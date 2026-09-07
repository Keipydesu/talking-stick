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
  releaseTurnSession,
  takeTurnSession
} from "../cli/turn-session.js";
import { CHAT_ACTIONS, type ChatAction } from "./actions.js";
import {
  actionAvailability,
  type ActionConfiguration,
  type CapabilitySnapshot
} from "./availability.js";
import {
  actionConfiguration,
  buildChatInput,
  createMenuState,
  filteredActions,
  menuWindow,
  selectedAction,
  setMenuOption,
  updateMenu,
  type ActionMenuState
} from "./menu.js";
import { InputEditor } from "./editor.js";
import {
  createChatState,
  hasSelfRemoval,
  updateChatState,
  type ChatState
} from "./model.js";
import { parseChatInput, type ParsedChatInput } from "./parse.js";
import {
  completionCandidates,
  activitySize,
  renderActionMenu,
  renderError,
  renderDashboard,
  renderEvent,
  renderFrame,
  popupSize,
  timelineLines,
  renderPalette,
  renderTeachingCommand,
  shortAgent
} from "./render.js";
import {
  ChatScreen,
  FullScreenDriver,
  normalizeTerminalColumns,
  normalizeTerminalRows,
  terminateProcess,
  type ChatTerminal,
  type ScreenOutput
} from "./terminal.js";
import { createTheme } from "./theme.js";

export interface ChatAppOptions {
  runtime: Runtime;
  identity: DerivedIdentity;
  contextPath: string;
  cliEntryUrl: string;
  terminal: ChatTerminal;
  pollWaitMs?: number;
}

export async function runChatApp(options: ChatAppOptions): Promise<void> {
  if (options.terminal.inputIsTTY && options.terminal.outputIsTTY) {
    return runFullScreenChatApp(options);
  }
  return runLineChatApp(options);
}

async function runFullScreenChatApp(options: ChatAppOptions): Promise<void> {
  const color = createTheme({ isTTY: true, env: process.env }).color;
  const joined = options.runtime.commands.joinPath(options.identity, {
    context_path: options.contextPath
  });
  upsertSessionFromJoin(options.identity, joined);
  let state = createChatState(joined);
  const backlogView = options.runtime.commands.getRoomEventsView({
    room_id: joined.room_id,
    agent_id: options.identity.agent_id,
    process_metadata: options.identity.process_metadata,
    include_all: false
  });
  state = updateChatState(state, {
    type: "events",
    events: backlogView.events.slice(-50),
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

  let menu = createMenuState();
  let menuSnapshot: CapabilitySnapshot | null = null;
  let editingMenuOption: { actionId: string; optionId: string } | null = null;
  const editor = new InputEditor();
  const lineQueue: Array<string | null> = [];
  const lineWaiters: Array<(line: string | null) => void> = [];
  const pollAbort = new AbortController();
  let stopped = false;
  let finalMessage: string | null = null;
  let terminationSignal: "SIGINT" | "SIGTERM" | null = null;
  let scrollOffset = 0;
  const setState = (next: ChatState) => {
    if (scrollOffset > 0) {
      const size = activitySize(normalizeTerminalColumns(options.terminal.columns()), normalizeTerminalRows(options.terminal.rows?.()));
      scrollOffset = Math.max(0, scrollOffset + timelineLines(next, size.width, false).length - timelineLines(state, size.width, false).length);
    }
    state = next;
  };

  const driver = new FullScreenDriver(options.terminal, () => renderFrame({
    state,
    menu,
    capability: menuSnapshot,
    editor: editor.snapshot(),
    width: normalizeTerminalColumns(options.terminal.columns()),
    rows: normalizeTerminalRows(options.terminal.rows?.()),
    scrollOffset,
    color
  }));
  const screen: ScreenOutput & { stateDriven: true } = {
    stateDriven: true,
    setPrompt(prompt) {
      editor.setPrompt(prompt);
      driver.redraw();
    },
    write(lines) {
      const values = Array.isArray(lines) ? lines : [lines];
      for (const text of values) {
        state = updateChatState(state, {
          type: "notice",
          level: /unavailable|error|could not|failed/i.test(text) ? "error" : "info",
          text
        });
      }
      driver.redraw();
    },
    finish(lines = []) {
      const values = Array.isArray(lines) ? lines : [lines];
      if (values.length > 0) finalMessage = values.join("\n");
      driver.redraw();
    },
    redraw() {
      driver.redraw();
    }
  };
  const deliverLine = (line: string | null) => {
    const waiter = lineWaiters.shift();
    if (waiter) waiter(line);
    else lineQueue.push(line);
  };
  const nextLine = async (prompt = "> "): Promise<string | null> => {
    editor.setPrompt(prompt);
    driver.redraw();
    const queued = lineQueue.shift();
    if (queued !== undefined) return queued;
    return await new Promise<string | null>((resolve) => lineWaiters.push(resolve));
  };
  const refreshMenuSnapshot = (): CapabilitySnapshot => {
    const health = options.runtime.commands.getRoomHealth(options.identity, {
      context_path: options.contextPath
    });
    state = updateChatState(state, {
      type: "room_state",
      value: {
        room: health.room,
        members: health.members,
        cursor_event_seq: health.cursor_event_seq
      }
    });
    const session = findCliSessionByRoom(
      resolveCliSessionPath(),
      options.identity.agent_id,
      joined.room_id
    );
    menuSnapshot = {
      state,
      health,
      hasLeaseSession: Boolean(
        session?.lease_id &&
        session.turn_id === health.room.turn_id &&
        session.lease_id === health.room.lease_id &&
        health.room.owner === options.identity.agent_id
      )
    };
    return menuSnapshot;
  };
  const closeOverlay = () => {
    menu = { ...menu, stage: "closed", filter: "" };
    menuSnapshot = null;
  };
  const runSelectedMenuAction = () => {
    if (menu.stage !== "browse" && menu.stage !== "options") return;
    const action = selectedAction(menu);
    if (!action) return;
    if (menu.stage === "browse" && !filteredActions(CHAT_ACTIONS, menu.filter).some((candidate) => candidate.id === action.id)) return;
    if (action.id === "help") {
      menu = updateMenu(menu, { type: "global_help" });
      driver.redraw();
      return;
    }
    const snapshot = refreshMenuSnapshot();
    const configuration = actionConfiguration(menu, action);
    const availability = actionAvailability(action, snapshot, configuration);
    if (availability !== true) {
      screen.write(renderError(`Unavailable: ${availability}`, color));
      return;
    }
    const input = buildChatInput(action, configuration);
    closeOverlay();
    deliverLine(input);
  };
  const stop = (reason?: string) => {
    if (stopped) return;
    stopped = true;
    pollAbort.abort();
    finalMessage = reason ?? finalMessage;
    if (reason) state = updateChatState(state, { type: "stop", reason });
    driver.redraw();
    while (lineWaiters.length > 0) lineWaiters.shift()?.(null);
  };

  interface Keypress {
    name?: string;
    ctrl?: boolean;
    meta?: boolean;
    sequence?: string;
  }
  const submitEditor = () => {
    const line = editor.submit();
    if (editingMenuOption) {
      menu = setMenuOption(menu, editingMenuOption.actionId, editingMenuOption.optionId, line);
      editingMenuOption = null;
      menu = { ...menu, stage: "options" };
      editor.setPrompt("> ");
      refreshMenuSnapshot();
      driver.redraw();
      return;
    }
    if (menu.stage === "global_help") closeOverlay();
    deliverLine(line);
    driver.redraw();
  };
  const editKey = (character: string | undefined, key: Keypress): boolean => {
    if (key.ctrl) {
      switch (key.name) {
        case "a": editor.home(); return true;
        case "e": editor.end(); return true;
        case "u": editor.clear(); return true;
        case "k": editor.killToEnd(); return true;
        case "w": editor.deleteWord(); return true;
      }
      return false;
    }
    switch (key.name) {
      case "backspace": editor.backspace(); return true;
      case "left": editor.left(); return true;
      case "right": editor.right(); return true;
      case "up": editor.previousHistory(); return true;
      case "down": editor.nextHistory(); return true;
      case "return":
      case "enter": submitEditor(); return true;
      case "tab": {
        const current = editor.snapshot().value;
        editor.complete(completionCandidates(current, state.members));
        return true;
      }
    }
    if (!key.ctrl && !key.meta && character && /^[^\x00-\x1f\x7f]$/u.test(character)) {
      editor.insert(character);
      return true;
    }
    return false;
  };
  const keypressHandler = (character: string | undefined, key: Keypress = {}) => {
    if (stopped) return;
    if (key.ctrl && key.name === "c") {
      terminationSignal = "SIGINT";
      if (menu.stage !== "closed") {
        stop("Chat closed. You remain a room member.");
      } else if (state.room.owner === options.identity.agent_id) {
        stop("Chat closed. The owned turn will be released before exit.");
      } else {
        stop("Chat closed. You remain a room member.");
      }
      driver.redraw();
      return;
    }
    if (menu.stage === "closed" && !editingMenuOption) {
      const current = editor.snapshot().value;
      if (key.name === "pageup" || key.name === "pagedown" || (key.ctrl && (key.name === "u" || key.name === "d") && !current)) {
        const direction = key.name === "pageup" || key.name === "u" ? 1 : -1;
        const rows = normalizeTerminalRows(options.terminal.rows?.());
        const size = activitySize(normalizeTerminalColumns(options.terminal.columns()), rows);
        scrollOffset = Math.max(0, Math.min(
          Math.max(0, timelineLines(state, size.width, false).length - size.rows),
          scrollOffset + direction * Math.max(1, Math.floor((rows - 7) / 2))
        ));
      } else if (key.ctrl && key.name === "e" && !current) {
        scrollOffset = 0;
      } else if (key.name === "tab" && current.length === 0 && !editingMenuOption) {
        menu = updateMenu(menu, { type: "open" });
        refreshMenuSnapshot();
      } else if (character === "?" && current.length === 0) {
        menu = updateMenu(menu, { type: "global_help" });
        refreshMenuSnapshot();
      } else {
        editKey(character, key);
      }
      driver.redraw();
      return;
    }
    if (menu.stage === "global_help" || editingMenuOption) {
      if (key.name === "escape") {
        editingMenuOption = null;
        closeOverlay();
        editor.setPrompt("> ");
      } else {
        editKey(character, key);
      }
      driver.redraw();
      return;
    }
    refreshMenuSnapshot();
    if (menu.searching && menu.stage === "browse") {
      if (key.name === "escape" || key.name === "return") {
        menu = { ...menu, searching: false };
      } else if (key.name === "backspace") {
        menu = updateMenu(menu, { type: "backspace" });
      } else if (character && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]+$/u.test(character)) {
        menu = updateMenu(menu, { type: "filter", value: character });
      }
    } else if (character === "/" && menu.stage === "browse") {
      menu = { ...menu, searching: true, filter: "" };
    } else if (character && /^[1-9]$/.test(character) && menu.stage === "browse") {
      const size = popupSize(normalizeTerminalColumns(options.terminal.columns()), normalizeTerminalRows(options.terminal.rows?.()));
      const action = menuWindow(menu, size.rows - 2)[Number(character) - 1];
      if (action) menu = { ...menu, selectedActionId: action.id };
    } else if (character && /^[1-9]$/.test(character) && menu.stage === "options") {
      const index = Number(character) - 1;
      if (index < (selectedAction(menu)?.options.length ?? 0)) menu = { ...menu, selectedOptionIndex: index };
    } else if (key.name === "escape" || key.name === "tab") {
      menu = updateMenu(menu, { type: "escape" });
      if (menu.stage === "closed") menuSnapshot = null;
    } else if (key.name === "up" || key.name === "down" || character === "j" || character === "k") {
      menu = updateMenu(menu, { type: key.name === "up" || character === "k" ? "up" : "down" });
    } else if (key.name === "right" || character === "l") {
      menu = updateMenu(menu, { type: "right" });
    } else if (key.name === "left" || character === "h") {
      menu = updateMenu(menu, { type: "left" });
    } else if (character === "?") {
      menu = updateMenu(menu, { type: "help" });
    } else if (key.name === "backspace" && menu.stage === "browse") {
      menu = updateMenu(menu, { type: "backspace" });
    } else if (key.name === "return" || key.name === "enter") {
      runSelectedMenuAction();
    } else if (character === " " && menu.stage === "options") {
      const action = selectedAction(menu);
      const option = action?.options[menu.selectedOptionIndex];
      if (action && option?.kind === "boolean") {
        menu = updateMenu(menu, { type: "toggle" });
      } else if (action && option) {
        editingMenuOption = { actionId: action.id, optionId: option.id };
        menu = { ...menu, stage: "closed" };
        menuSnapshot = null;
        editor.clear();
        editor.setPrompt(`${option.syntax}: `);
      }
    }
    driver.redraw();
  };
  const endHandler = () => stop();
  const resizeCleanup = options.terminal.onResize(() => {
    const size = activitySize(normalizeTerminalColumns(options.terminal.columns()), normalizeTerminalRows(options.terminal.rows?.()));
    scrollOffset = Math.min(scrollOffset, Math.max(0, timelineLines(state, size.width, false).length - size.rows));
    driver.redraw();
  });
  const interruptStop = () => {
    terminationSignal = "SIGINT";
    stop("Chat closed. You remain a room member.");
  };
  const terminateStop = () => {
    terminationSignal = "SIGTERM";
    stop("Chat closed. You remain a room member.");
  };
  readline.emitKeypressEvents(options.terminal.input);
  options.terminal.input.on("keypress", keypressHandler);
  options.terminal.input.once("end", endHandler);
  process.once("SIGINT", interruptStop);
  process.once("SIGTERM", terminateStop);
  driver.enter();

  if (joined.warning) screen.write(`Warning: ${joined.warning}`);
  if (backlogView.hidden?.events.older_count) {
    screen.write(`… ${backlogView.hidden.events.older_count} older events hidden; use \`tt events --all\` for the full audit log.`);
  }
  const pollPromise = pollRoom({
    ...options,
    roomId: joined.room_id,
    getState: () => state,
    setState,
    screen,
    isStopped: () => stopped,
    stop,
    pollWaitMs: options.pollWaitMs ?? joined.policy.waitForEventsMaxWaitMs,
    signal: pollAbort.signal
  });

  try {
    while (!stopped) {
      const line = await nextLine();
      if (line === null) {
        stop();
        break;
      }
      if (line.trim() === "/" || line.trim() === "/help") {
        menu = updateMenu(menu, { type: line.trim() === "/" ? "open" : "global_help" });
        refreshMenuSnapshot();
        driver.redraw();
        continue;
      }
      try {
        await executeInput(parseChatInput(line), {
          ...options,
          joined,
          getState: () => state,
          setState,
          screen,
          nextLine,
          stop
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        screen.write(renderError(message, color));
        if (isProtocolError(error) && error.code === "unknown_member") {
          stop("You are no longer a room member. Run `tt chat` to join again.");
        }
      }
    }
  } finally {
    stopped = true;
    pollAbort.abort();
    options.terminal.input.off("keypress", keypressHandler);
    options.terminal.input.off("end", endHandler);
    process.off("SIGINT", interruptStop);
    process.off("SIGTERM", terminateStop);
    resizeCleanup();
    driver.restore();
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
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        const recovery = `Could not release the stick while closing chat: ${cause} The guardian and CLI session were preserved. Resolve the cause, then run \`tt release\` or reopen \`tt chat\`.`;
        options.terminal.output.write(`${recovery}\n`);
        if (terminationSignal) terminateProcess(terminationSignal);
        throw new Error(recovery, { cause: error });
      }
    }
    if (finalMessage) options.terminal.output.write(`${finalMessage}\n`);
    if (terminationSignal) terminateProcess(terminationSignal);
  }
}

async function runLineChatApp(options: ChatAppOptions): Promise<void> {
  const color = createTheme({
    isTTY: options.terminal.outputIsTTY,
    env: process.env
  }).color;
  const joined = options.runtime.commands.joinPath(options.identity, {
    context_path: options.contextPath
  });
  upsertSessionFromJoin(options.identity, joined);

  let state = createChatState(joined);
  const backlogView = options.runtime.commands.getRoomEventsView({
    room_id: joined.room_id,
    agent_id: options.identity.agent_id,
    process_metadata: options.identity.process_metadata,
    include_all: false
  });
  const backlog = backlogView.events.slice(-50);
  state = updateChatState(state, {
    type: "events",
    events: backlog,
    historical: true
  });

  let menu = createMenuState();
  let menuSnapshot: CapabilitySnapshot | null = null;
  let editingMenuOption: { actionId: string; optionId: string } | null = null;
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
  const initialRawMode = options.terminal.isRaw?.() ?? false;
  const restoreTerminal = () => options.terminal.setRawMode?.(initialRawMode);
  process.on("uncaughtExceptionMonitor", restoreTerminal);
  process.on("exit", restoreTerminal);
  const rl = readline.createInterface({
    input: options.terminal.input,
    output: options.terminal.output,
    terminal: options.terminal.inputIsTTY && options.terminal.outputIsTTY,
    escapeCodeTimeout: 100,
    completer: (line: string) => {
      const candidates = completionCandidates(line, state.members);
      return [candidates.length > 0 ? candidates : [line], line];
    }
  });
  const screen = new ChatScreen(
    options.terminal,
    rl,
    () => {
      const width = Math.max(1, options.terminal.columns() - 1);
      if (menu.stage !== "closed" && menuSnapshot) {
        return renderActionMenu(menu, menuSnapshot, {
          color,
          width,
          maxRows: Math.max(5, Math.floor((options.terminal.rows?.() ?? 24) / 3))
        });
      }
      return renderDashboard(state, {
        color,
        width,
        maxRows: Math.max(4, Math.floor((options.terminal.rows?.() ?? 24) / 3))
      });
    }
  );
  const pollAbort = new AbortController();
  let stopped = false;
  const stop = (reason?: string) => {
    if (stopped) return;
    stopped = true;
    pollAbort.abort();
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
  const refreshMenuSnapshot = (): CapabilitySnapshot => {
    const health = options.runtime.commands.getRoomHealth(options.identity, {
      context_path: options.contextPath
    });
    state = updateChatState(state, {
      type: "room_state",
      value: {
        room: health.room,
        members: health.members,
        cursor_event_seq: health.cursor_event_seq
      }
    });
    const session = findCliSessionByRoom(
      resolveCliSessionPath(),
      options.identity.agent_id,
      joined.room_id
    );
    menuSnapshot = {
      state,
      health,
      hasLeaseSession: Boolean(
        session?.lease_id &&
        session.turn_id === health.room.turn_id &&
        session.lease_id === health.room.lease_id &&
        health.room.owner === options.identity.agent_id
      )
    };
    return menuSnapshot;
  };
  const runSelectedMenuAction = () => {
    if (menu.stage !== "browse" && menu.stage !== "options") return;
    const action = selectedAction(menu);
    if (!action) return;
    const snapshot = refreshMenuSnapshot();
    const configuration = actionConfiguration(menu, action);
    const availability = actionAvailability(action, snapshot, configuration);
    if (availability !== true) {
      screen.redraw();
      return;
    }
    const input = buildChatInput(action, configuration);
    menu = { ...menu, stage: "closed", filter: "" };
    menuSnapshot = null;
    screen.setPrompt("> ");
    deliverLine(input);
  };
  rl.on("line", (line) => {
    if (editingMenuOption) {
      menu = setMenuOption(
        menu,
        editingMenuOption.actionId,
        editingMenuOption.optionId,
        line
      );
      editingMenuOption = null;
      menu = { ...menu, stage: "options" };
      refreshMenuSnapshot();
      screen.setPrompt("> ");
      screen.redraw();
      return;
    }
    if (menu.stage !== "closed") {
      if (menu.stage === "global_help" && line.trimStart().startsWith("/")) {
        menu = { ...menu, stage: "closed", filter: "" };
        menuSnapshot = null;
        screen.setPrompt("> ");
        deliverLine(line);
        return;
      }
      if (line.length > 0) {
        screen.write("Menu selection not run: press Enter alone, or Esc before typing a command.");
        return;
      }
      runSelectedMenuAction();
      return;
    }
    deliverLine(line);
  });
  rl.on("close", () => {
    while (lineWaiters.length > 0) lineWaiters.shift()?.(null);
  });
  const nextLine = async (prompt = "> "): Promise<string | null> => {
    screen.setPrompt(prompt);
    const queued = lineQueue.shift();
    if (queued !== undefined) return queued;
    return await new Promise<string | null>((resolve) => lineWaiters.push(resolve));
  };

  interface Keypress {
    name?: string;
    ctrl?: boolean;
    meta?: boolean;
  }
  let rawEscapePending = false;
  const clearMenuInput = () => {
    setImmediate(() => {
      if (stopped) return;
      if (rl.line) rl.write(null, { ctrl: true, name: "u" });
      screen.redraw();
    });
  };
  const keypressHandler = (character: string | undefined, key: Keypress = {}) => {
    if (rawEscapePending) {
      rawEscapePending = false;
      if (key.name === "escape") return;
      if (key.meta && character) {
        if (menu.stage === "closed") {
          rl.write(character);
        } else if (menu.stage === "browse" && /^[A-Za-z0-9_-]$/.test(character)) {
          menu = updateMenu(menu, { type: "filter", value: character });
          clearMenuInput();
        }
        return;
      }
    }
    if (stopped || key.ctrl || key.meta) return;
    if (menu.stage === "closed") {
      if (key.name === "tab" && rl.line.length === 0) {
        menu = updateMenu(menu, { type: "open" });
        refreshMenuSnapshot();
        clearMenuInput();
      } else if (character === "?" && (rl.line === "?" || rl.line.length === 0)) {
        menu = updateMenu(menu, { type: "global_help" });
        refreshMenuSnapshot();
        clearMenuInput();
      }
      return;
    }

    refreshMenuSnapshot();
    if (key.name === "up" || key.name === "down") {
      menu = updateMenu(menu, { type: key.name });
    } else if (key.name === "right") {
      menu = updateMenu(menu, { type: "right" });
    } else if (key.name === "left") {
      menu = updateMenu(menu, { type: "left" });
    } else if (key.name === "escape") {
      menu = updateMenu(menu, { type: "escape" });
      if (menu.stage === "closed") menuSnapshot = null;
    } else if (character === "?") {
      menu = updateMenu(menu, { type: "help" });
    } else if (key.name === "backspace" && menu.stage === "browse") {
      menu = updateMenu(menu, { type: "backspace" });
    } else if (character === " " && menu.stage === "options") {
      const action = selectedAction(menu);
      const option = action?.options[menu.selectedOptionIndex];
      if (action && option?.kind === "boolean") {
        menu = updateMenu(menu, { type: "toggle" });
      } else if (action && option) {
        editingMenuOption = { actionId: action.id, optionId: option.id };
        menu = { ...menu, stage: "closed" };
        menuSnapshot = null;
        screen.setPrompt(`${option.syntax}: `);
      }
    } else if (
      menu.stage === "browse" &&
      character &&
      /^[A-Za-z0-9_-]$/.test(character)
    ) {
      menu = updateMenu(menu, { type: "filter", value: character });
    }
    clearMenuInput();
  };
  const rawEscapeHandler = (chunk: Buffer | string) => {
    const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (stopped || menu.stage === "closed" || value.length !== 1 || value[0] !== 0x1b) {
      return;
    }
    rawEscapePending = true;
    menu = updateMenu(menu, { type: "escape" });
    if (menu.stage === "closed") menuSnapshot = null;
    screen.redraw();
  };
  options.terminal.input.on("keypress", keypressHandler);
  options.terminal.input.on("data", rawEscapeHandler);

  const resizeCleanup = options.terminal.onResize(() => screen.redraw());
  const signalStop = () => stop("Chat closed. You remain a room member.");
  process.once("SIGINT", signalStop);
  process.once("SIGTERM", signalStop);
  rl.on("SIGINT", () => {
    if (menu.stage !== "closed") {
      menu = updateMenu(menu, { type: "escape" });
      if (menu.stage === "closed") menuSnapshot = null;
      screen.redraw();
      return;
    }
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
    ...(backlogView.hidden?.events.older_count
      ? [`… ${backlogView.hidden.events.older_count} older events hidden; use \`tt events --all\` for the full audit log.`]
      : []),
    ...backlog.map((event) =>
      renderEvent({ event, historical: true }, {
        color,
        members: state.members
      })
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
    stop,
    pollWaitMs: options.pollWaitMs ?? joined.policy.waitForEventsMaxWaitMs,
    signal: pollAbort.signal
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
        screen.write(renderError(message, color));
        if (isProtocolError(error) && error.code === "unknown_member") {
          stop("You are no longer a room member. Run `tt chat` to join again.");
        }
      }
    }
  } finally {
    stopped = true;
    rl.close();
    restoreTerminal();
    resizeCleanup();
    process.off("SIGINT", signalStop);
    process.off("SIGTERM", signalStop);
    process.off("uncaughtExceptionMonitor", restoreTerminal);
    process.off("exit", restoreTerminal);
    options.terminal.input.off("keypress", keypressHandler);
    options.terminal.input.off("data", rawEscapeHandler);
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
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        const recovery =
          `Could not release the stick while closing chat: ${cause} ` +
          "The guardian and CLI session were preserved. Resolve the cause, then run `tt release` or reopen `tt chat`.";
        screen.finish(renderError(recovery, color));
        throw new Error(recovery, { cause: error });
      }
    }
  }
}

interface ExecutionContext extends ChatAppOptions {
  joined: ReturnType<Runtime["commands"]["joinPath"]>;
  getState: () => ChatState;
  setState: (state: ChatState) => void;
  screen: ScreenOutput;
  nextLine: (prompt?: string) => Promise<string | null>;
  stop: (reason?: string) => void;
}

async function executeInput(
  parsed: ParsedChatInput,
  context: ExecutionContext
): Promise<void> {
  if (parsed.kind === "empty") return;
  if (parsed.kind === "error") {
    context.screen.write(renderError(parsed.message, tuiColor(context.terminal)));
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
      renderTeachingCommand("tt msg send room", [parsed.body], tuiColor(context.terminal))
    );
    return;
  }

  const { name, cli } = parsed.action;
  const args = parsed.args;
  const configuration = configurationFromArgs(name, args);
  const availability = actionAvailability(
    parsed.action,
    refreshCapabilitySnapshot(context),
    configuration
  );
  if (availability !== true) {
    context.screen.write(renderError(`Unavailable: ${availability}`, tuiColor(context.terminal)));
    return;
  }
  switch (name) {
    case "help":
      context.screen.write(renderPalette(args[0]));
      return;
    case "msg": {
      const member = args[0] || await promptMember(context);
      if (!member) return;
      let body = args.slice(1).join(" ");
      if (!body) {
        body = (await context.nextLine("Message: ")) ?? "";
        context.screen.setPrompt("> ");
      }
      if (!body.trim()) return;
      const target = resolveAgentSelector(
        context.runtime,
        context.identity,
        context.joined.room_id,
        member
      );
      if (!ensureActionAvailable(context, parsed.action, {
        ...configuration,
        member: target
      })) return;
      context.runtime.commands.sendMessage(context.identity, {
        room_id: context.joined.room_id,
        body,
        to_agent_id: target
      });
      context.screen.write(renderTeachingCommand(cli, [target, body], tuiColor(context.terminal)));
      return;
    }
    case "who":
      refreshState(context);
      context.screen.write([
        renderTeachingCommand(cli, [], tuiColor(context.terminal)),
        ...renderMembers(context.getState())
      ]);
      return;
    case "state":
      refreshState(context);
      context.screen.write([
        renderTeachingCommand(cli, [], tuiColor(context.terminal)),
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
        renderTeachingCommand(cli, [], tuiColor(context.terminal)),
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
        renderTeachingCommand(cli, ["--limit", String(count)], tuiColor(context.terminal)),
        ...events.map((event) => renderEvent({ event, historical: true }, {
          color: tuiColor(context.terminal),
          members: context.getState().members
        }))
      ]);
      return;
    }
    case "note": {
      let body = args.join(" ");
      if (!body) {
        body = (await context.nextLine("Note: ")) ?? "";
        context.screen.setPrompt("> ");
      }
      if (!body.trim()) return;
      context.runtime.commands.addNote(context.identity, {
        room_id: context.joined.room_id,
        body
      });
      context.screen.write(renderTeachingCommand(cli, [body], tuiColor(context.terminal)));
      return;
    }
    case "notes": {
      const notes = context.runtime.commands.listNotes(context.identity, {
        room_id: context.joined.room_id,
        limit: 50
      });
      context.screen.write([
        renderTeachingCommand(cli, [], tuiColor(context.terminal)),
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
        context.screen.setPrompt("> ");
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
      refreshState(context);
      context.screen.write([
        renderTeachingCommand(cli, ["--reason", reason], tuiColor(context.terminal)),
        `You have the stick. Guardian ${result.guardian_pid} is protecting turn ${result.turn_id}.`
      ]);
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
      refreshState(context);
      context.screen.write([
        renderTeachingCommand(cli, ["--status", handoff.status, "--next-action", handoff.next_action], tuiColor(context.terminal)),
        result.reserved_for ? `Turn released to ${result.reserved_for}.` : "Turn released."
      ]);
      return;
    }
    case "assign": {
      const target = args[0] || await promptMember(context);
      if (!target) return;
      if (!ensureActionAvailable(context, parsed.action, {
        ...configuration,
        member: target
      })) return;
      const handoff = await promptHandoff(context);
      if (!handoff) return;
      const result = assignTurnSession({
        runtime: context.runtime,
        identity: context.identity,
        contextPath: context.contextPath,
        targetSelector: target,
        handoff
      });
      refreshState(context);
      context.screen.write([
        renderTeachingCommand(cli, [target, "--status", handoff.status, "--next-action", handoff.next_action], tuiColor(context.terminal)),
        `Turn assigned to ${result.reserved_for}.`
      ]);
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
      const force = args.includes("--force");
      const reason = args.slice(1).filter((argument) => argument !== "--force").join(" ");
      if (!ensureActionAvailable(context, parsed.action, {
        member: resolved,
        reason,
        force
      })) return;
      context.runtime.commands.kickMember(context.identity, {
        room_id: context.joined.room_id,
        target_agent_id: resolved,
        reason: reason || undefined,
        force
      });
      refreshState(context);
      context.screen.write(renderTeachingCommand(cli, [
        resolved,
        ...(reason ? ["--reason", reason] : []),
        ...(force ? ["--force"] : [])
      ], tuiColor(context.terminal)));
      return;
    }
    case "instructions": {
      const instructions = showInstructions({
        options: { contextPath: context.contextPath, identity: context.identity }
      });
      context.screen.write([
        renderTeachingCommand(cli, [], tuiColor(context.terminal)),
        instructions.text || "No effective instructions found."
      ]);
      return;
    }
    case "rooms": {
      const rooms = context.runtime.commands.listRooms({ context_path: context.contextPath }).rooms;
      context.screen.write([
        renderTeachingCommand(cli, [], tuiColor(context.terminal)),
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
      context.screen.write(renderTeachingCommand(cli, [], tuiColor(context.terminal)));
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

function refreshCapabilitySnapshot(context: ExecutionContext): CapabilitySnapshot {
  const health = context.runtime.commands.getRoomHealth(context.identity, {
    context_path: context.contextPath
  });
  const state = updateChatState(context.getState(), {
    type: "room_state",
    value: {
      room: health.room,
      members: health.members,
      cursor_event_seq: health.cursor_event_seq
    }
  });
  context.setState(state);
  const session = findCliSessionByRoom(
    resolveCliSessionPath(),
    context.identity.agent_id,
    context.joined.room_id
  );
  return {
    state,
    health,
    hasLeaseSession: Boolean(
      session?.lease_id &&
      session.turn_id === health.room.turn_id &&
      session.lease_id === health.room.lease_id &&
      health.room.owner === context.identity.agent_id
    )
  };
}

function ensureActionAvailable(
  context: ExecutionContext,
  action: ChatAction,
  configuration: ActionConfiguration
): boolean {
  const availability = actionAvailability(
    action,
    refreshCapabilitySnapshot(context),
    configuration
  );
  if (availability === true) return true;
  context.screen.write(renderError(`Unavailable: ${availability}`, tuiColor(context.terminal)));
  return false;
}

function configurationFromArgs(
  actionName: string,
  args: string[]
): ActionConfiguration {
  switch (actionName) {
    case "msg":
      return { member: args[0], message: args.slice(1).join(" ") };
    case "history":
      return { count: args[0] };
    case "note":
      return { text: args.join(" ") };
    case "take":
      return { reason: args.join(" ") };
    case "assign":
      return { member: args[0] };
    case "kick":
      return {
        member: args[0],
        reason: args.slice(1).filter((argument) => argument !== "--force").join(" "),
        force: args.includes("--force")
      };
    case "quit":
      return { force: args.includes("--force") || args.includes("-f") };
    default:
      return {};
  }
}

function tuiColor(terminal: ChatTerminal): boolean {
  return createTheme({ isTTY: terminal.outputIsTTY, env: process.env }).color;
}

async function promptHandoff(context: ExecutionContext): Promise<Handoff | null> {
  const status = await context.nextLine("What changed? ");
  if (status === null || !status.trim()) {
    context.screen.setPrompt("> ");
    context.screen.write("Handoff cancelled: status is required.");
    return null;
  }
  const nextAction = await context.nextLine("What should happen next? ");
  if (nextAction === null || !nextAction.trim()) {
    context.screen.setPrompt("> ");
    context.screen.write("Handoff cancelled: next action is required.");
    return null;
  }
  context.screen.setPrompt("> ");
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
  context.screen.setPrompt("> ");
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
  screen: ScreenOutput & { stateDriven?: boolean };
  isStopped: () => boolean;
  stop: (reason?: string) => void;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.isStopped()) {
    try {
      const result = await input.runtime.commands.waitForEvents({
        room_id: input.roomId,
        agent_id: input.identity.agent_id,
        process_metadata: input.identity.process_metadata,
        after_event_seq: input.getState().cursor,
        target_agent_id: "any",
        max_wait_ms: input.pollWaitMs,
        signal: input.signal
      });
      if (input.isStopped()) break;
      if (result.events.length > 0) {
        input.setState(updateChatState(input.getState(), {
          type: "events",
          events: result.events
        }));
        if (input.screen.stateDriven) {
          input.screen.redraw();
        } else {
          input.screen.write(result.events.map((event) =>
            renderEvent({ event, historical: false }, {
              color: tuiColor(input.terminal),
              members: input.getState().members
            })
          ));
        }
        if (hasSelfRemoval(result.events, input.identity.agent_id)) {
          input.stop(removalReason(result.events, input.identity.agent_id));
          break;
        }
      }
      const refreshed = updateChatState(input.getState(), {
        type: "room_state",
        value: input.runtime.commands.getRoomState({
          room_id: input.roomId,
          agent_id: input.identity.agent_id,
          process_metadata: input.identity.process_metadata
        })
      });
      input.setState(refreshed);
      input.screen.redraw();
      if (!refreshed.members.some((member) => member.agent_id === input.identity.agent_id)) {
        input.stop("You are no longer a room member. Run `tt chat` to join again.");
        break;
      }
    } catch (error) {
      if (input.isStopped()) break;
      const message = error instanceof Error ? error.message : String(error);
      if (/SQLITE_BUSY|database is locked/i.test(message)) {
        input.screen.write(
          renderError(
            `Temporary database contention: ${message}`,
            tuiColor(input.terminal)
          )
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      input.stop(`Chat stopped: ${message}`);
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
