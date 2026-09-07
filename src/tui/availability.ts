import type { GetRoomHealthResult, RoomMember } from "../index.js";
import type { ChatAction } from "./actions.js";
import type { ChatState } from "./model.js";

export type ActionConfiguration = Record<string, string | boolean | undefined>;
export type Availability = true | string;

export interface CapabilitySnapshot {
  state: ChatState;
  health: GetRoomHealthResult;
  hasLeaseSession: boolean;
}

export function actionAvailability(
  action: Pick<ChatAction, "name">,
  snapshot: CapabilitySnapshot,
  configuration: ActionConfiguration = {}
): Availability {
  const state = snapshot.state;
  const self = state.selfAgentId;
  switch (action.name) {
    case "take":
      if (state.room.state === "closed") return "room is closed";
      if (state.room.owner === self) return "you already have the stick";
      return true;
    case "release":
    case "pass":
      return ownedLeaseAvailability(snapshot);
    case "assign": {
      const owned = ownedLeaseAvailability(snapshot);
      if (owned !== true) return owned;
      const reachable = reachableMembers(snapshot).filter((member) => member.agent_id !== self);
      if (reachable.length === 0) return "no reachable member to receive the turn";
      const selector = stringValue(configuration.member);
      if (!selector) return true;
      return findMember(reachable, selector) ? true : "selected member is not reachable";
    }
    case "msg": {
      const active = state.members.filter(
        (member) => member.agent_id !== self && member.status === "active"
      );
      if (active.length === 0) return "no other active member";
      const selector = stringValue(configuration.member);
      if (!selector) return true;
      return findMember(active, selector) ? true : "selected member is not active";
    }
    case "kick": {
      const candidates = state.members.filter((member) => member.agent_id !== self);
      if (candidates.length === 0) return "no other room member";
      const selector = stringValue(configuration.member);
      if (!selector) return true;
      const target = findMember(candidates, selector);
      if (!target) return "selected member is not in the room";
      if (target.status === "active" && configuration.force !== true) {
        return "target is active; enable --force";
      }
      return true;
    }
    case "leave":
      return state.room.owner === self ? "release the stick before leaving" : true;
    case "quit":
      return state.room.owner === self && configuration.force !== true
        ? "You hold the stick; enable --force to close"
        : true;
    default:
      return true;
  }
}

export function reachableMembers(snapshot: CapabilitySnapshot): RoomMember[] {
  const receiverIds = new Set(
    snapshot.health.receivers
      .filter((receiver) => receiver.liveness === "alive")
      .map((receiver) => receiver.agent_id)
  );
  return snapshot.health.members.filter((member) =>
    member.status === "active" && (
      receiverIds.has(member.agent_id) ||
      (
        member.wait_intent === "parked" &&
        member.standby_transport === "cmux" &&
        Boolean(member.standby_workspace_id) &&
        Boolean(member.standby_surface_id) &&
        Boolean(member.standby_registered_at) &&
        member.standby_last_error === null
      )
    )
  );
}

function ownedLeaseAvailability(snapshot: CapabilitySnapshot): Availability {
  if (snapshot.state.room.owner !== snapshot.state.selfAgentId) {
    return "you need the stick";
  }
  return snapshot.hasLeaseSession ? true : "owned room has no recoverable lease session";
}

function findMember<T extends { agent_id: string; display_name?: string | null }>(
  members: T[],
  selector: string
): T | undefined {
  const normalized = selector.toLowerCase();
  return members.find((member) =>
    member.agent_id.toLowerCase() === normalized ||
    member.agent_id.toLowerCase().startsWith(`${normalized}:`) ||
    member.display_name?.toLowerCase() === normalized
  );
}

function stringValue(value: string | boolean | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
