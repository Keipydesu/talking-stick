import type {
  GetRoomStateResult,
  JoinPathResult,
  PathRoom,
  RoomEvent
} from "../index.js";

export const MAX_CHAT_EVENTS = 200;
export const MAX_CHAT_NOTICES = 50;
export const MAX_CHAT_ACTIVITY = 200;

export interface ChatMember {
  agent_id: string;
  status: "active" | "inactive";
  display_name?: string | null;
}

export interface ChatEventEntry {
  event: RoomEvent;
  historical: boolean;
}

export interface ChatNotice {
  level: "info" | "error";
  text: string;
}

export type ChatActivity =
  | { kind: "event"; entry: ChatEventEntry }
  | { kind: "notice"; notice: ChatNotice };

export interface ChatState {
  roomId: string;
  canonicalPath: string;
  workingDirectory: string;
  selfAgentId: string;
  room: PathRoom;
  members: ChatMember[];
  cursor: number;
  events: ChatEventEntry[];
  notices: ChatNotice[];
  activity: ChatActivity[];
  stoppedReason: string | null;
}

export type ChatUpdate =
  | { type: "events"; events: RoomEvent[]; historical?: boolean }
  | { type: "room_state"; value: GetRoomStateResult }
  | { type: "notice"; level?: ChatNotice["level"]; text: string }
  | { type: "stop"; reason: string };

export function createChatState(joined: JoinPathResult): ChatState {
  return {
    roomId: joined.room_id,
    canonicalPath: joined.canonical_path,
    workingDirectory: joined.requested_path,
    selfAgentId: joined.agent_id,
    room: joined.room_state,
    members: joined.members.map((member) => ({ ...member })),
    cursor: joined.cursor_event_seq,
    events: [],
    notices: [],
    activity: [],
    stoppedReason: null
  };
}

export function updateChatState(
  state: ChatState,
  update: ChatUpdate
): ChatState {
  switch (update.type) {
    case "events": {
      let room = state.room;
      let members = state.members;
      let cursor = state.cursor;
      for (const event of update.events) {
        cursor = Math.max(cursor, event.event_seq);
        room = applyRoomEvent(room, event);
        members = applyMemberEvent(members, event);
      }
      return {
        ...state,
        room,
        members,
        cursor,
        events: [
          ...state.events,
          ...update.events.map((event) => ({
            event,
            historical: update.historical === true
          }))
        ].slice(-MAX_CHAT_EVENTS),
        activity: [
          ...state.activity,
          ...update.events.map((event): ChatActivity => ({
            kind: "event",
            entry: { event, historical: update.historical === true }
          }))
        ].slice(-MAX_CHAT_ACTIVITY)
      };
    }
    case "room_state":
      return {
        ...state,
        room: update.value.room,
        members: update.value.members.map((member) => ({
          agent_id: member.agent_id,
          status: member.status,
          display_name: member.display_name
        }))
      };
    case "notice":
      const notice = { level: update.level ?? "info", text: update.text };
      return {
        ...state,
        notices: [
          ...state.notices,
          notice
        ].slice(-MAX_CHAT_NOTICES),
        activity: [
          ...state.activity,
          { kind: "notice", notice } as ChatActivity
        ].slice(-MAX_CHAT_ACTIVITY)
      };
    case "stop":
      return { ...state, stoppedReason: update.reason };
  }
}

export function hasSelfRemoval(events: RoomEvent[], selfAgentId: string): boolean {
  return events.some(
    (event) =>
      (event.event_type === "kick" && event.to_agent_id === selfAgentId) ||
      (event.event_type === "leave" && event.from_agent_id === selfAgentId) ||
      event.event_type === "close"
  );
}

function applyRoomEvent(room: PathRoom, event: RoomEvent): PathRoom {
  switch (event.event_type) {
    case "claim":
    case "takeover":
      return {
        ...room,
        owner: event.to_agent_id,
        reserved_for: null,
        state: "owned",
        turn_id: event.turn_id
      };
    case "pass":
      return {
        ...room,
        owner: null,
        reserved_for: event.to_agent_id,
        state: "reserved",
        turn_id: event.turn_id
      };
    case "release":
      return {
        ...room,
        owner: null,
        reserved_for: null,
        state: "idle",
        turn_id: event.turn_id
      };
    case "close":
      return { ...room, owner: null, reserved_for: null, state: "closed" };
    case "leave":
      if (event.from_agent_id === room.owner) {
        return { ...room, owner: null, state: "idle" };
      }
      if (event.from_agent_id === room.reserved_for) {
        return { ...room, reserved_for: null, state: "idle" };
      }
      return room;
    case "kick":
      if (event.to_agent_id === room.owner) {
        return { ...room, owner: null, state: "idle" };
      }
      if (event.to_agent_id === room.reserved_for) {
        return { ...room, reserved_for: null, state: "idle" };
      }
      return room;
    default:
      return room;
  }
}

function applyMemberEvent(
  members: ChatMember[],
  event: RoomEvent
): ChatMember[] {
  if (event.event_type === "join" && event.from_agent_id) {
    if (members.some((member) => member.agent_id === event.from_agent_id)) {
      return members.map((member) =>
        member.agent_id === event.from_agent_id
          ? { ...member, status: "active" }
          : member
      );
    }
    return [...members, { agent_id: event.from_agent_id, status: "active" }];
  }
  const removed =
    event.event_type === "leave"
      ? event.from_agent_id
      : event.event_type === "kick"
        ? event.to_agent_id
        : null;
  return removed
    ? members.filter((member) => member.agent_id !== removed)
    : members;
}
