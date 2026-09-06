import readline from "node:readline";
import {
  findCliSessionByRoom,
  isProtocolError,
  removeCliSession,
  removeCliSessionsForRoom,
  resolveCliSessionPath,
  showInstructions,
  type DerivedIdentity,
  type Handoff,
  type RoomEvent
} from "../index.js";
import { resolveAgentSelector } from "../cli/event-stream.js";
import { stopGuardian } from "../cli/guardian.js";
import type { Runtime } from "../cli/runtime.js";
import { upsertSessionFromJoin } from "../cli/session.js";
import {
  assignTurnSession,
  finishTurnSession,
  releaseTurnSession,
  takeTurnSession
} from "../cli/turn-session.js";
import { CHAT_ACTIONS } from "./actions.js";
import {
  createChatState,
  hasSelfRemoval,
  updateChatState,
  type ChatState
} from "./model.js";
import { parseChatInput, type ParsedChatInput } from "./parse.js";
import {
  completionCandidates,
  renderError,
  renderEvent,
  renderPalette,
  renderStatusBar,
  renderTeachingCommand,
  shortAgent
} from "./render.js";
import { ChatScreen, type ChatTerminal } from "./terminal.js";

export interface ChatAppOptions {
  runtime: Runtime;
  identity: DerivedIdentity;
  contextPath: string;
  cliEntryUrl: string;
  terminal: ChatTerminal;
  pollWaitMs?: number;
}

export async function runChatApp(options: ChatAppOptions): Promise<void> {
  const joined = options.runtime.commands.joinPath(options.identity, {
    context_path: options.contextPath
  });
  upsertSessionFromJoin(options.identity, joined);

  let state = createChatState(joined);
  const backlog = options.runtime.commands.getRoomEventsView({
    room_id: joined.room_id,
    agent_id: options.identity.agent_id,
    process_metadata: options.identity.process_metadata,
    include_all: false
  }).events.slice(-50);
  state = updateChatState(state, {
    type: "events",
    events: backlog,
    historical: true
  });
  state = updateChatState(state, {
    type: "room_state",
    value: options.runtime.commands.getRoomState({
      room_id: joined.room_id,
      agent_id: options.identity.agent_id,
      process_metadata: options.identity.process_metadata
    })
  });

  const lineQueue: Array<string | null> = [];
  const lineWaiters: Array<(line: string | null) => void> = [];
  const rl = readline.createInterface({
    input: options.terminal.input,
    output: options.terminal.output,
    terminal: options.terminal.inputIsTTY && options.terminal.outputIsTTY,
    completer: (line: string) => {
      const candidates = completionCandidates(line, state.members);
      return [candidates.length > 0 ? candidates : [line], line];
    }
  });
  const screen = new ChatScreen(
    options.terminal,
    rl,
    () => renderStatusBar(state, { width: options.terminal.columns() })
  );
  let stopped = false;
  const stop = (reason?: string) => {
    if (stopped) return;
    stopped = true;
    if (reason) {
      state = updateChatState(state, { type: "stop", reason });
      screen.finish(reason);
    } else {
      screen.finish();
    }
    rl.close();
  };

  const deliverLine = (line: string | null) => {
    const waiter = lineWaiters.shift();
    if (waiter) waiter(line);
    else lineQueue.push(line);
  };
  rl.on("line", (line) => deliverLine(line));
  rl.on("close", () => {
    while (lineWaiters.length > 0) lineWaiters.shift()?.(null);
  });
  const nextLine = async (prompt = "> "): Promise<string | null> => {
    screen.setPrompt(prompt);
    const queued = lineQueue.shift();
    if (queued !== undefined) return queued;
    return await new Promise<string | null>((resolve) => lineWaiters.push(resolve));
  };

  const resizeCleanup = options.terminal.onResize(() => screen.redraw());
  const signalStop = () => stop("Chat closed. You remain a room member.");
  process.once("SIGINT", signalStop);
  process.once("SIGTERM", signalStop);
  rl.on("SIGINT", () => {
    if (state.room.owner === options.identity.agent_id) {
      screen.write(
        "You hold the stick. Use /release or /pass first, or /quit --force to release and detach."
      );
      return;
    }
    stop("Chat closed. You remain a room member.");
  });

  screen.write([
    `Joined ${joined.canonical_path} as ${joined.agent_id}.`,
    ...(joined.warning ? [`Warning: ${joined.warning}`] : []),
    "Type a message for the room, or / for actions. /quit detaches; /leave leaves.",
    ...backlog.map((event) =>
      renderEvent({ event, historical: true }, { color: options.terminal.outputIsTTY })
    )
  ]);

  const pollPromise = pollRoom({
    ...options,
    roomId: joined.room_id,
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    screen,
    isStopped: () => stopped,
    stop
  });

  try {
    while (!stopped) {
      const line = await nextLine();
      if (line === null) {
        stop();
        break;
      }
      try {
        const parsed = parseChatInput(line);
        await executeInput(parsed, {
          ...options,
          joined,
          getState: () => state,
          setState: (next) => {
            state = next;
          },
          screen,
          nextLine,
          stop
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        screen.write(renderError(message, options.terminal.outputIsTTY));
        if (isProtocolError(error) && error.code === "unknown_member") {
          stop("You are no longer a room member. Run `tt chat` to join again.");
        }
      }
    }
  } finally {
    stopped = true;
    rl.close();
    resizeCleanup();
    process.off("SIGINT", signalStop);
    process.off("SIGTERM", signalStop);
    await pollPromise;
    if (state.room.owner === options.identity.agent_id) {
      try {
        releaseTurnSession({
          runtime: options.runtime,
          identity: options.identity,
          contextPath: options.contextPath,
          handoff: {
            status: "Interactive chat closed.",
            next_action: "Continue normally."
          }
        });
      } catch {
        const session = findCliSessionByRoom(
          resolveCliSessionPath(),
          options.identity.agent_id,
          joined.room_id
        );
        if (session) finishTurnSession(options.identity, session);
      }
    }
  }
}

interface ExecutionContext extends ChatAppOptions {
  joined: ReturnType<Runtime["commands"]["joinPath"]>;
  getState: () => ChatState;
  setState: (state: ChatState) => void;
  screen: ChatScreen;
  nextLine: (prompt?: string) => Promise<string | null>;
  stop: (reason?: string) => void;
}

async function executeInput(
  parsed: ParsedChatInput,
  context: ExecutionContext
): Promise<void> {
  if (parsed.kind === "empty") return;
  if (parsed.kind === "error") {
    context.screen.write(renderError(parsed.message, context.terminal.outputIsTTY));
    return;
  }
  if (parsed.kind === "palette") {
    context.screen.write(renderPalette());
    return;
  }
  if (parsed.kind === "message") {
    context.runtime.commands.sendMessage(context.identity, {
      room_id: context.joined.room_id,
      body: parsed.body,
      to_agent_id: null
    });
    context.screen.write(
      renderTeachingCommand("tt msg send room", [parsed.body], context.terminal.outputIsTTY)
    );
    return;
  }

  const { name, cli } = parsed.action;
  const args = parsed.args;
  switch (name) {
    case "help":
      context.screen.write(renderPalette(args[0]));
      return;
    case "msg": {
      const member = args[0] || await promptMember(context);
      if (!member) return;
      let body = args.slice(1).join(" ");
      if (!body) body = (await context.nextLine("Message: ")) ?? "";
      if (!body.trim()) return;
      const target = resolveAgentSelector(
        context.runtime,
        context.identity,
        context.joined.room_id,
        member
      );
      context.runtime.commands.sendMessage(context.identity, {
        room_id: context.joined.room_id,
        body,
        to_agent_id: target
      });
      context.screen.write(renderTeachingCommand(cli, [target, body], context.terminal.outputIsTTY));
      return;
    }
    case "who":
      refreshState(context);
      context.screen.write([
        renderTeachingCommand(cli, [], context.terminal.outputIsTTY),
        ...renderMembers(context.getState())
      ]);
      return;
    case "state":
      refreshState(context);
      context.screen.write([
        renderTeachingCommand(cli, [], context.terminal.outputIsTTY),
        describeRoom(context.getState())
      ]);
      return;
    case "health": {
      const health = context.runtime.commands.getRoomHealth(context.identity, {
        context_path: context.contextPath
      });
      const takeover = health.takeover.available
        ? ` Takeover available: ${health.takeover.reason}.`
        : "";
      context.screen.write([
        renderTeachingCommand(cli, [], context.terminal.outputIsTTY),
        `Room ${health.room.state}; ${health.members.filter((member) => member.status === "active").length} active members; ${health.receivers.length} receivers.${takeover}`
      ]);
      return;
    }
    case "history": {
      const requested = Number.parseInt(args[0] ?? "20", 10);
      const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 20;
      const events = context.runtime.commands.getRoomEventsView({
        room_id: context.joined.room_id,
        agent_id: context.identity.agent_id,
        process_metadata: context.identity.process_metadata,
        include_all: false
      }).events.slice(-count);
      context.screen.write([
        renderTeachingCommand(cli, ["--limit", String(count)], context.terminal.outputIsTTY),
        ...events.map((event) => renderEvent({ event, historical: true }, {
          color: context.terminal.outputIsTTY
        }))
      ]);
      return;
    }
    case "note": {
      let body = args.join(" ");
      if (!body) body = (await context.nextLine("Note: ")) ?? "";
      if (!body.trim()) return;
      context.runtime.commands.addNote(context.identity, {
        room_id: context.joined.room_id,
        body
      });
      context.screen.write(renderTeachingCommand(cli, [body], context.terminal.outputIsTTY));
      return;
    }
    case "notes": {
      const notes = context.runtime.commands.listNotes(context.identity, {
        room_id: context.joined.room_id,
        limit: 50
      });
      context.screen.write([
        renderTeachingCommand(cli, [], context.terminal.outputIsTTY),
        ...(notes.notes.length > 0
          ? notes.notes.map((note) => `${shortAgent(note.author_agent_id)}: ${note.body}`)
          : ["No unresolved notes."])
      ]);
      return;
    }
    case "take": {
      const room = context.getState().room;
      if (room.owner === context.identity.agent_id) {
        context.screen.write("You already have the stick.");
        return;
      }
      const currentHolder = room.owner ?? room.reserved_for;
      if (currentHolder && currentHolder !== context.identity.agent_id) {
        const answer = await context.nextLine(`Take from ${shortAgent(currentHolder)}? [y/N] `);
        if (!answer || !/^y(es)?$/i.test(answer.trim())) {
          context.screen.write("Take cancelled.");
          return;
        }
      }
      const reason = args.join(" ") || "operator takeover";
      const result = await takeTurnSession({
        runtime: context.runtime,
        identity: context.identity,
        contextPath: context.contextPath,
        reason,
        operatorOverride: true,
        cliEntryUrl: context.cliEntryUrl
      });
      context.screen.write([
        renderTeachingCommand(cli, ["--reason", reason], context.terminal.outputIsTTY),
        `You have the stick. Guardian ${result.guardian_pid} is protecting turn ${result.turn_id}.`
      ]);
      refreshState(context);
      return;
    }
    case "release":
    case "pass": {
      const handoff = await promptHandoff(context);
      if (!handoff) return;
      const result = releaseTurnSession({
        runtime: context.runtime,
        identity: context.identity,
        contextPath: context.contextPath,
        handoff
      });
      context.screen.write([
        renderTeachingCommand(cli, ["--status", handoff.status, "--next-action", handoff.next_action], context.terminal.outputIsTTY),
        result.reserved_for ? `Turn released to ${result.reserved_for}.` : "Turn released."
      ]);
      refreshState(context);
      return;
    }
    case "assign": {
      const target = args[0] || await promptMember(context);
      if (!target) return;
      const handoff = await promptHandoff(context);
      if (!handoff) return;
      const result = assignTurnSession({
        runtime: context.runtime,
        identity: context.identity,
        contextPath: context.contextPath,
        targetSelector: target,
        handoff
      });
      context.screen.write([
        renderTeachingCommand(cli, [target, "--status", handoff.status, "--next-action", handoff.next_action], context.terminal.outputIsTTY),
        `Turn assigned to ${result.reserved_for}.`
      ]);
      refreshState(context);
      return;
    }
    case "kick": {
      const target = args[0] || await promptMember(context);
      if (!target) return;
      const resolved = resolveAgentSelector(
        context.runtime,
        context.identity,
        context.joined.room_id,
        target
      );
      const reason = args.slice(1).join(" ");
      context.runtime.commands.kickMember(context.identity, {
        room_id: context.joined.room_id,
        target_agent_id: resolved,
        reason: reason || undefined
      });
      context.screen.write(renderTeachingCommand(cli, [resolved, ...(reason ? ["--reason", reason] : [])], context.terminal.outputIsTTY));
      refreshState(context);
      return;
    }
    case "instructions": {
      const instructions = showInstructions({
        options: { contextPath: context.contextPath, identity: context.identity }
      });
      context.screen.write([
        renderTeachingCommand(cli, [], context.terminal.outputIsTTY),
        instructions.text || "No effective instructions found."
      ]);
      return;
    }
    case "rooms": {
      const rooms = context.runtime.commands.listRooms({ context_path: context.contextPath }).rooms;
      context.screen.write([
        renderTeachingCommand(cli, [], context.terminal.outputIsTTY),
        ...rooms.map((room) => `${room.state.padEnd(8)} ${room.canonical_path}`)
      ]);
      return;
    }
    case "quit": {
      const ownsTurn = context.getState().room.owner === context.identity.agent_id;
      const force = args.includes("--force") || args.includes("-f");
      if (ownsTurn && !force) {
        context.screen.write("You hold the stick. Use /release or /pass first, or /quit --force to release and detach.");
        return;
      }
      if (ownsTurn) {
        releaseTurnSession({
          runtime: context.runtime,
          identity: context.identity,
          contextPath: context.contextPath,
          handoff: {
            status: "Operator closed interactive chat.",
            next_action: "Continue normally."
          }
        });
        refreshState(context);
      }
      context.stop("Chat closed. You remain a room member.");
      return;
    }
    case "leave": {
      if (context.getState().room.owner === context.identity.agent_id) {
        context.screen.write("You hold the stick. Use /release or /pass before leaving.");
        return;
      }
      const sessionPath = resolveCliSessionPath();
      const session = findCliSessionByRoom(
        sessionPath,
        context.identity.agent_id,
        context.joined.room_id
      );
      const result = context.runtime.commands.leaveRoom(context.identity, {
        room_id: context.joined.room_id
      });
      if (result.status === "room_deleted") {
        removeCliSessionsForRoom(sessionPath, context.joined.room_id);
      } else {
        removeCliSession(sessionPath, context.identity.agent_id, context.joined.room_id);
      }
      stopGuardian(session?.guardian_pid, session?.guardian_process_started_at);
      context.screen.write(renderTeachingCommand(cli, [], context.terminal.outputIsTTY));
      context.stop("You left the room.");
      return;
    }
  }
}

function refreshState(context: Pick<ExecutionContext, "runtime" | "identity" | "joined" | "getState" | "setState">): void {
  context.setState(updateChatState(context.getState(), {
    type: "room_state",
    value: context.runtime.commands.getRoomState({
      room_id: context.joined.room_id,
      agent_id: context.identity.agent_id,
      process_metadata: context.identity.process_metadata
    })
  }));
}

async function promptHandoff(context: ExecutionContext): Promise<Handoff | null> {
  const status = await context.nextLine("What changed? ");
  if (status === null || !status.trim()) {
    context.screen.write("Handoff cancelled: status is required.");
    return null;
  }
  const nextAction = await context.nextLine("What should happen next? ");
  if (nextAction === null || !nextAction.trim()) {
    context.screen.write("Handoff cancelled: next action is required.");
    return null;
  }
  return { status, next_action: nextAction };
}

async function promptMember(context: ExecutionContext): Promise<string | null> {
  const members = context.getState().members.filter(
    (member) => member.status === "active" && member.agent_id !== context.identity.agent_id
  );
  if (members.length === 0) {
    context.screen.write("No other active room members.");
    return null;
  }
  context.screen.write(members.map((member, index) => `${index + 1}. ${member.agent_id}`));
  const answer = await context.nextLine("Choose member: ");
  if (!answer) return null;
  const index = Number.parseInt(answer, 10) - 1;
  return members[index]?.agent_id ?? answer;
}

function renderMembers(state: ChatState): string[] {
  return state.members.map((member) => {
    const you = member.agent_id === state.selfAgentId ? " (you)" : "";
    const owner = member.agent_id === state.room.owner ? " — has stick" : "";
    return `${member.status === "active" ? "●" : "○"} ${member.agent_id}${you}${owner}`;
  });
}

function describeRoom(state: ChatState): string {
  if (state.room.owner) return `Room ${state.room.state}; stick held by ${state.room.owner}.`;
  if (state.room.reserved_for) return `Room reserved for ${state.room.reserved_for}.`;
  return `Room ${state.room.state}; stick is free.`;
}

async function pollRoom(input: ChatAppOptions & {
  roomId: string;
  getState: () => ChatState;
  setState: (state: ChatState) => void;
  screen: ChatScreen;
  isStopped: () => boolean;
  stop: (reason?: string) => void;
}): Promise<void> {
  while (!input.isStopped()) {
    try {
      const result = await input.runtime.commands.waitForEvents({
        room_id: input.roomId,
        agent_id: input.identity.agent_id,
        process_metadata: input.identity.process_metadata,
        after_event_seq: input.getState().cursor,
        target_agent_id: "any",
        max_wait_ms: input.pollWaitMs ?? 1_000
      });
      if (input.isStopped()) break;
      if (result.events.length > 0) {
        input.setState(updateChatState(input.getState(), {
          type: "events",
          events: result.events
        }));
        input.screen.write(result.events.map((event) =>
          renderEvent({ event, historical: false }, { color: input.terminal.outputIsTTY })
        ));
        if (hasSelfRemoval(result.events, input.identity.agent_id)) {
          input.stop(removalReason(result.events, input.identity.agent_id));
          break;
        }
      }
      input.setState(updateChatState(input.getState(), {
        type: "room_state",
        value: input.runtime.commands.getRoomState({
          room_id: input.roomId,
          agent_id: input.identity.agent_id,
          process_metadata: input.identity.process_metadata
        })
      }));
    } catch (error) {
      if (input.isStopped()) break;
      input.stop(`Chat stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function removalReason(events: RoomEvent[], selfAgentId: string): string {
  if (events.some((event) => event.event_type === "close")) return "The room was closed.";
  if (events.some((event) => event.event_type === "kick" && event.to_agent_id === selfAgentId)) {
    return "You were removed from the room. Run `tt chat` to join again.";
  }
  return "You left the room.";
}

export { CHAT_ACTIONS };
