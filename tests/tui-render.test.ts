import { describe, expect, test } from "vitest";
import type { JoinPathResult, RoomEvent } from "../src/index.js";
import {
  createChatState,
  updateChatState,
  type ChatEventEntry
} from "../src/tui/model.js";
import type { CapabilitySnapshot } from "../src/tui/availability.js";
import { createMenuState, setMenuOption, updateMenu } from "../src/tui/menu.js";
import {
  completionCandidates,
  renderActionMenu,
  renderDashboard,
  renderEvent,
  renderFrame,
  renderStatusBar,
  renderTeachingCommand,
  shellQuote,
  stripAnsi
} from "../src/tui/render.js";
import {
  normalizeTerminalColumns,
  normalizeTerminalRows
} from "../src/tui/terminal.js";

describe("chat rendering", () => {
  test("formats messages and dims historical events only with color", () => {
    const entry: ChatEventEntry = {
      historical: true,
      event: messageEvent()
    };
    expect(renderEvent(entry, { color: false })).toContain("claude");
    expect(renderEvent(entry, { color: false })).toContain("-> room");
    expect(renderEvent(entry, { color: true })).toMatch(/^\u001b\[2m/);
  });

  test("renders contextual status and truncates narrow terminals", () => {
    const state = createChatState(joinResult());
    expect(renderStatusBar(state)).toContain("stick: free — /take");
    const narrow = renderStatusBar(state, { width: 20 });
    expect(narrow).toHaveLength(20);
    expect(narrow.endsWith("…")).toBe(true);
  });

  test("surfaces takeover availability in the status bar", () => {
    const state = createChatState(joinResult());
    state.room = { ...state.room, state: "owner_gone", owner: "claude:one" };
    expect(renderStatusBar(state)).toContain("takeover available (owner_gone) — /take");
  });

  test("renders persistent room, cwd, member, and stick context", () => {
    const state = createChatState(joinResult());
    state.members = [
      { agent_id: "human:me", status: "active", display_name: "me" },
      { agent_id: "claude:one", status: "active", display_name: "Claude" },
      { agent_id: "codex:two", status: "inactive", display_name: "Codex" }
    ];
    state.room = { ...state.room, owner: "claude:one", state: "owned" };

    const dashboard = renderDashboard(state, { color: false, width: 100 });

    expect(dashboard).toHaveLength(4);
    expect(dashboard[0]).toContain("talking-stick");
    expect(dashboard[0]).toContain("owned");
    expect(dashboard[1]).toContain("cwd");
    expect(dashboard[1]).toContain("/repo/talking-stick");
    expect(dashboard[2]).toContain("me (you)");
    expect(dashboard[2]).toContain("Claude [stick]");
    expect(dashboard[2]).toContain("Codex");
    expect(dashboard[3]).toContain("stick: Claude");
  });

  test("uses stable agent colors and ANSI-aware dashboard widths", () => {
    const state = createChatState(joinResult());
    state.members = [
      { agent_id: "human:me", status: "active", display_name: "me" },
      { agent_id: "claude:one", status: "active", display_name: "Claude" }
    ];

    const dashboard = renderDashboard(state, { color: true, width: 100 });
    expect(dashboard.every((line) => stripAnsi(line).length === 100)).toBe(true);
    expect(dashboard.join("\n")).toMatch(/\u001b\[38;5;\d+m/);

    const coloredMessage = renderEvent(
      { historical: false, event: messageEvent() },
      { color: true }
    );
    expect(coloredMessage).toMatch(/\u001b\[38;5;\d+m/);
    expect(stripAnsi(coloredMessage)).toContain("claude");
  });

  test("renders a fixed full-pane frame with activity, members, cwd, and stick", () => {
    const state = createChatState(joinResult());
    state.members = [
      { agent_id: "human:me", status: "active", display_name: "Me" },
      { agent_id: "claude:one", status: "active", display_name: "Claude" },
      { agent_id: "codex:two", status: "inactive", display_name: "Codex" }
    ];
    state.room = { ...state.room, owner: "claude:one", state: "owned", turn_id: 24 };
    state.events = [{ historical: false, event: messageEvent() }];

    const frame = renderFrame({
      state,
      menu: createMenuState(),
      capability: null,
      editor: { prompt: "> ", value: "/sta", cursor: 4 },
      width: 100,
      rows: 24,
      color: false
    });

    expect(frame).toHaveLength(24);
    expect(frame.every((line) => stripAnsi(line).length === 100)).toBe(true);
    expect(frame.join("\n")).toContain("MEMBERS");
    expect(frame.join("\n")).toContain("◆ Claude");
    expect(frame.join("\n")).toContain("○ Codex");
    expect(frame.join("\n")).toContain("/repo/talking-stick");
    expect(frame.join("\n")).toContain("stick: Claude");
    expect(frame.at(-2)).toContain("> /sta▏");
    expect(stripAnsi(frame[0])).not.toContain("MEMBERS");
    expect(stripAnsi(frame[1])).toContain("MEMBERS");
    expect(stripAnsi(frame[1]).startsWith("│")).toBe(true);
    expect(stripAnsi(frame[4]).startsWith("│")).toBe(true);
    expect(stripAnsi(frame[3])).toContain("┤");
  });

  test("renders actions as an overlay without hiding unavailable choices", () => {
    const state = createChatState(joinResult());
    let menu = updateMenu(createMenuState(), { type: "open" });
    menu = { ...menu, selectedActionId: "release" };
    const frame = renderFrame({
      state,
      menu,
      capability: capability(state),
      editor: { prompt: "> ", value: "", cursor: 0 },
      width: 90,
      rows: 20,
      color: false
    });

    expect(frame.join("\n")).toContain("release");
    expect(frame.join("\n")).toContain("you need the stick");
    expect(frame.join("\n")).toContain("MEMBERS");
    const actionsRow = stripAnsi(frame.find((line) => line.includes("ACTIONS")) ?? "");
    expect(actionsRow.slice(0, 72).endsWith("…")).toBe(false);
  });

  test("does not truncate activity merely to make room for its leading border", () => {
    let state = createChatState(joinResult());
    state = updateChatState(state, { type: "notice", text: "short notice" });
    const frame = renderFrame({
      state,
      menu: createMenuState(),
      capability: null,
      editor: { prompt: "> ", value: "", cursor: 0 },
      width: 100,
      rows: 20,
      color: false
    });
    const activityRow = frame.find((line) => line.includes("short notice"));

    expect(activityRow).toBeDefined();
    expect(stripAnsi(activityRow ?? "").slice(0, 72).endsWith("…")).toBe(false);
  });

  test("degrades safely for tiny and sizeless terminal dimensions", () => {
    const state = createChatState(joinResult());
    for (const [width, rows] of [[1, 1], [20, 3], [47, 7]]) {
      const frame = renderFrame({
        state,
        menu: createMenuState(),
        capability: null,
        editor: { prompt: "> ", value: "", cursor: 0 },
        width,
        rows,
        color: false
      });
      expect(frame).toHaveLength(rows);
      expect(frame.every((line) => line.length === width)).toBe(true);
    }
  });

  test("disambiguates members that share a display name", () => {
    const state = createChatState(joinResult());
    state.members = [
      { agent_id: "human:one", status: "active", display_name: "Sam" },
      { agent_id: "claude:one", status: "active", display_name: "Sam" }
    ];

    const dashboard = renderDashboard(state, { color: false, width: 100 });
    expect(dashboard.join("\n")).toContain("Sam [human]");
    expect(dashboard.join("\n")).toContain("Sam [claude]");

    const renderedMessage = renderEvent(
      { historical: false, event: messageEvent() },
      { color: false, members: state.members }
    );
    expect(renderedMessage).toContain("Sam [claude]");
  });

  test("truncates styled dashboard lines by visible width", () => {
    const state = createChatState(joinResult());
    state.members = [
      { agent_id: "human:me", status: "active", display_name: "Me" },
      { agent_id: "claude:one", status: "active", display_name: "Claude" },
      { agent_id: "codex:two", status: "active", display_name: "Codex" }
    ];
    const dashboard = renderDashboard(state, {
      color: true,
      width: 28
    });
    const plain = dashboard.map(stripAnsi);
    expect(plain.every((line) => line.length === 28)).toBe(true);
    expect(dashboard).toHaveLength(1);
    expect(plain[0]).toContain("3 member");
    expect(dashboard.some((line) => stripAnsi(line).endsWith("…"))).toBe(true);
  });

  test("renders every action with live availability and command previews", () => {
    const state = createChatState(joinResult());
    let menu = updateMenu(createMenuState(), { type: "open" });
    menu = { ...menu, selectedActionId: "release" };
    const browse = renderActionMenu(menu, capability(state), {
      color: false,
      width: 72,
      maxRows: 10
    });
    expect(browse.join("\n")).toContain("release");
    expect(browse.join("\n")).toContain("you need the stick");

    menu = { ...menu, selectedActionId: "take" };
    menu = updateMenu(menu, { type: "right" });
    menu = setMenuOption(menu, "take", "reason", "review parser");
    const options = renderActionMenu(menu, capability(state), {
      color: false,
      width: 72,
      maxRows: 10
    });
    expect(options.join("\n")).toContain("Preview: tt take --reason 'review parser'");
  });

  test("uses an 80-column fallback for sizeless pseudo-terminals", () => {
    expect(normalizeTerminalColumns(0)).toBe(80);
    expect(normalizeTerminalColumns(undefined)).toBe(80);
    expect(normalizeTerminalColumns(120)).toBe(120);
    expect(normalizeTerminalRows(0)).toBe(24);
    expect(normalizeTerminalRows(undefined)).toBe(24);
    expect(normalizeTerminalRows(40)).toBe(40);
  });

  test("keeps the working-directory tail visible in collapsed layouts", () => {
    const state = createChatState(joinResult());
    state.workingDirectory = "/a/very/long/path/with/useful/project-name";
    const dashboard = renderDashboard(state, { color: false, width: 50 });

    expect(dashboard).toHaveLength(2);
    expect(dashboard[1]).toContain("project-name");
    expect(dashboard[1]).toContain("…");
  });

  test("caps the managed dashboard while preserving the stick row", () => {
    const state = createChatState(joinResult());
    state.members = Array.from({ length: 12 }, (_, index) => ({
      agent_id: `agent:${index}`,
      status: "active" as const,
      display_name: `agent-${index}`
    }));

    const dashboard = renderDashboard(state, {
      color: false,
      width: 72,
      maxRows: 5
    });
    expect(dashboard.length).toBeLessThanOrEqual(5);
    expect(dashboard.at(-1)).toContain("stick: free");
    expect(dashboard.join("\n")).toContain("more");
  });

  test("shell-quotes teaching commands so they are copyable", () => {
    expect(shellQuote("plain-value")).toBe("plain-value");
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("it's ready")).toBe("'it'\"'\"'s ready'");
    expect(renderTeachingCommand("tt msg send room", ["two words"], false))
      .toBe("→ tt msg send room 'two words'");
  });

  test("completes slash actions and live member ids", () => {
    expect(completionCandidates("/ins", [])).toEqual(["/instructions"]);
    expect(completionCandidates("/msg cla", [
      { agent_id: "claude:one" },
      { agent_id: "codex:two" }
    ])).toEqual(["/msg claude:one"]);
  });
});

function joinResult(): JoinPathResult {
  return {
    agent_id: "human:me",
    room_id: "room-1",
    canonical_path: "/repo/talking-stick",
    requested_path: "/repo/talking-stick",
    workspace_root: "/repo/talking-stick",
    joined_existing_room: true,
    cursor_event_seq: 1,
    members: [{ agent_id: "human:me", status: "active", last_seen_at: new Date(0).toISOString() }],
    policy: {
      ownerLeaseTtlMs: 1,
      ownerActivityTtlMs: 1,
      heartbeatIntervalMs: 1,
      claimTtlMs: 1,
      waitForTurnMaxWaitMs: 1,
      waitForTurnPollMs: 1,
      waitForEventsMaxWaitMs: 1,
      waitForEventsPollMs: 1,
      waitForEventsBatchLimit: 1,
      presenceTtlMs: 1,
      waiterGraceMs: 1,
      idleRoomTtlMs: 1
    },
    room_state: {
      room_id: "room-1",
      canonical_path: "/repo/talking-stick",
      sequence_index: 0,
      owner: null,
      reserved_for: null,
      pending_handoff_event_seq: null,
      turn_id: 0,
      lease_id: null,
      lease_expires_at: null,
      claim_expires_at: null,
      state: "idle",
      updated_at: new Date(0).toISOString()
    },
    handoff_template: { status: "", next_action: "" }
  };
}

function messageEvent(): RoomEvent {
  return {
    event_seq: 1,
    event_id: "event-1",
    room_id: "room-1",
    turn_id: 0,
    event_type: "message_sent",
    from_agent_id: "claude:one",
    to_agent_id: null,
    handoff: null,
    reason: null,
    created_at: "2026-09-06T14:02:00.000Z",
    payload: { body: "hello", delivery_hint: "normal" }
  };
}

function capability(state: ReturnType<typeof createChatState>): CapabilitySnapshot {
  return {
    state,
    hasLeaseSession: false,
    health: {
      room: state.room,
      members: [],
      receivers: [],
      cursor_event_seq: state.cursor,
      pending_handoff: null,
      takeover: { available: false }
    }
  };
}
