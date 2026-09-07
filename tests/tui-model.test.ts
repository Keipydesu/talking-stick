import { describe, expect, test } from "vitest";
import type { JoinPathResult, RoomEvent } from "../src/index.js";
import {
  createChatState,
  hasSelfRemoval,
  MAX_CHAT_EVENTS,
  MAX_CHAT_NOTICES,
  updateChatState
} from "../src/tui/model.js";

describe("chat model", () => {
  test("tracks ownership, membership, messages, and a monotonic cursor", () => {
    let state = createChatState(joinResult());
    state = updateChatState(state, {
      type: "events",
      events: [
        event(11, "join", "claude:2", null),
        event(12, "claim", null, "human:me"),
        { ...event(13, "message_sent", "claude:2", null), payload: {
          body: "hello",
          delivery_hint: "normal"
        } }
      ]
    });

    expect(state.room.owner).toBe("human:me");
    expect(state.room.state).toBe("owned");
    expect(state.members.map((member) => member.agent_id)).toContain("claude:2");
    expect(state.events.at(-1)?.event.payload?.body).toBe("hello");
    expect(state.cursor).toBe(13);

    state = updateChatState(state, {
      type: "events",
      events: [event(9, "leave", "claude:2", null)]
    });
    expect(state.cursor).toBe(13);
    expect(state.members.map((member) => member.agent_id)).not.toContain("claude:2");
  });

  test("marks backlog entries as historical", () => {
    const state = updateChatState(createChatState(joinResult()), {
      type: "events",
      events: [event(7, "release", "codex:1", null)],
      historical: true
    });
    expect(state.events[0].historical).toBe(true);
  });

  test("keeps the requested working directory separate from the room root", () => {
    const joined = joinResult();
    joined.requested_path = "/repo/packages/cli";
    joined.canonical_path = "/repo";
    const state = createChatState(joined);

    expect(state.workingDirectory).toBe("/repo/packages/cli");
    expect(state.canonicalPath).toBe("/repo");
  });

  test("room-state refreshes never advance the event cursor", () => {
    const initial = createChatState(joinResult());
    const state = updateChatState(initial, {
      type: "room_state",
      value: {
        room: initial.room,
        members: [],
        cursor_event_seq: 99
      }
    });
    expect(state.cursor).toBe(10);
  });

  test("caps semantic event and notice history", () => {
    let state = createChatState(joinResult());
    state = updateChatState(state, {
      type: "events",
      events: Array.from({ length: MAX_CHAT_EVENTS + 5 }, (_, index) =>
        event(index + 20, "message_sent", "claude:2", null)
      )
    });
    for (let index = 0; index < MAX_CHAT_NOTICES + 5; index += 1) {
      state = updateChatState(state, { type: "notice", text: `notice ${index}` });
    }

    expect(state.events).toHaveLength(MAX_CHAT_EVENTS);
    expect(state.events[0].event.event_seq).toBe(25);
    expect(state.notices).toHaveLength(MAX_CHAT_NOTICES);
    expect(state.notices[0].text).toBe("notice 5");
    expect(state.activity).toHaveLength(MAX_CHAT_EVENTS);
    expect(state.activity.at(-1)).toMatchObject({
      kind: "notice",
      notice: { text: `notice ${MAX_CHAT_NOTICES + 4}` }
    });
  });

  test("detects self removal and room closure", () => {
    expect(hasSelfRemoval([event(2, "kick", "human:admin", "human:me")], "human:me")).toBe(true);
    expect(hasSelfRemoval([event(3, "leave", "human:me", null)], "human:me")).toBe(true);
    expect(hasSelfRemoval([event(4, "close", "human:admin", null)], "human:me")).toBe(true);
    expect(hasSelfRemoval([event(5, "kick", "human:admin", "claude:2")], "human:me")).toBe(false);
  });
});

function joinResult(): JoinPathResult {
  return {
    agent_id: "human:me",
    room_id: "room-1",
    canonical_path: "/repo",
    requested_path: "/repo",
    workspace_root: "/repo",
    joined_existing_room: true,
    cursor_event_seq: 10,
    members: [{ agent_id: "human:me", status: "active", last_seen_at: new Date(0).toISOString() }],
    policy: {
      ownerLeaseTtlMs: 1,
      ownerActivityTtlMs: 1,
      claimTtlMs: 1,
      heartbeatIntervalMs: 1,
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
      canonical_path: "/repo",
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

function event(
  eventSeq: number,
  eventType: RoomEvent["event_type"],
  fromAgentId: string | null,
  toAgentId: string | null
): RoomEvent {
  return {
    event_seq: eventSeq,
    event_id: `event-${eventSeq}`,
    room_id: "room-1",
    turn_id: eventSeq,
    event_type: eventType,
    from_agent_id: fromAgentId,
    to_agent_id: toAgentId,
    handoff: null,
    reason: null,
    created_at: new Date(eventSeq * 1000).toISOString(),
    payload: null
  };
}
