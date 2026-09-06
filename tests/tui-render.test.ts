import { describe, expect, test } from "vitest";
import type { JoinPathResult, RoomEvent } from "../src/index.js";
import { createChatState, type ChatEventEntry } from "../src/tui/model.js";
import {
  completionCandidates,
  renderEvent,
  renderStatusBar,
  renderTeachingCommand,
  shellQuote
} from "../src/tui/render.js";

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
