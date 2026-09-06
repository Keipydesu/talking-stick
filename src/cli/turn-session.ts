import {
  clearCliSessionLease,
  resolveCliSessionPath,
  upsertCliSession,
  type CliSession,
  type DerivedIdentity,
  type Handoff,
  type PassStickResult,
  type ReleaseStickResult,
  type RoomEvent,
  type RoomMember,
  type TakeoverStickResult,
  type WaitForTurnResult
} from "../index.js";
import { spawnGuardian, stopGuardian } from "./guardian.js";
import { formatWaitResult } from "./output.js";
import { requireLeaseSession, upsertSessionFromJoin } from "./session.js";
import type { Runtime } from "./runtime.js";

type ClaimedTurn = Extract<WaitForTurnResult, { status: "your_turn" }>;

export type GuardedTurnResult = (ClaimedTurn | TakeoverStickResult) & {
  guardian_pid: number;
};

export interface TakeTurnSessionInput {
  runtime: Runtime;
  identity: DerivedIdentity;
  contextPath: string;
  reason: string;
  operatorOverride: boolean;
  cliEntryUrl: string;
}

export async function takeTurnSession(
  input: TakeTurnSessionInput
): Promise<GuardedTurnResult> {
  const joined = input.runtime.commands.joinPath(input.identity, {
    context_path: input.contextPath
  });
  upsertSessionFromJoin(input.identity, joined);

  const availability = await input.runtime.commands.waitForTurn(input.identity, {
    room_id: joined.room_id,
    max_wait_ms: 0
  });

  let result: ClaimedTurn | TakeoverStickResult;
  if (availability.status === "your_turn") {
    result = availability;
  } else {
    if (availability.status === "closed") {
      throw new Error("Takeover is not available: room is closed.");
    }
    if (availability.status !== "takeover_available" && !input.operatorOverride) {
      throw new Error(`Takeover is not available: ${formatWaitResult(availability)}`);
    }

    result = input.runtime.commands.takeoverStick(input.identity, {
      room_id: joined.room_id,
      expected_turn_id: availability.turn_id,
      reason: input.reason,
      operator_override: input.operatorOverride
    });
  }

  const guardian = await spawnGuardian({
    agentId: input.identity.agent_id,
    canonicalPath: joined.canonical_path,
    roomId: joined.room_id,
    leaseId: result.lease_id,
    turnId: result.turn_id,
    cliEntryUrl: input.cliEntryUrl,
    processMetadata: input.identity.process_metadata
  });

  upsertCliSession(resolveCliSessionPath(), {
    agent_id: input.identity.agent_id,
    room_id: joined.room_id,
    canonical_path: joined.canonical_path,
    workspace_root: joined.workspace_root,
    lease_id: result.lease_id,
    turn_id: result.turn_id,
    guardian_pid: guardian.pid,
    guardian_process_started_at: guardian.process_started_at,
    updated_at: new Date().toISOString()
  });

  return { ...result, guardian_pid: guardian.pid };
}

export function releaseTurnSession(input: {
  runtime: Runtime;
  identity: DerivedIdentity;
  contextPath: string;
  handoff: Handoff;
}): ReleaseStickResult {
  const session = requireLeaseSession(input.identity, input.contextPath);
  const result = input.runtime.commands.releaseStick(input.identity, {
    room_id: session.room_id,
    lease_id: session.lease_id as string,
    expected_turn_id: session.turn_id as number,
    handoff: input.handoff
  });
  finishTurnSession(input.identity, session);
  return result;
}

export function assignTurnSession(input: {
  runtime: Runtime;
  identity: DerivedIdentity;
  contextPath: string;
  targetSelector: string;
  handoff: Handoff;
  operatorOverride?: boolean;
}): PassStickResult {
  const session = requireLeaseSession(input.identity, input.contextPath);
  const target = resolveAssignmentTarget(
    input.runtime,
    input.identity,
    session,
    input.targetSelector,
    input.operatorOverride === true
  );
  const result = input.runtime.commands.passStick(input.identity, {
    room_id: session.room_id,
    lease_id: session.lease_id as string,
    expected_turn_id: session.turn_id as number,
    to_agent_id: target,
    handoff: input.handoff,
    operator_override: input.operatorOverride
  });
  finishTurnSession(input.identity, session);
  return result;
}

export function finishTurnSession(
  identity: DerivedIdentity,
  session: CliSession
): void {
  clearCliSessionLease(resolveCliSessionPath(), identity.agent_id, session.room_id);
  stopGuardian(
    session.guardian_pid,
    session.guardian_process_started_at ?? null
  );
}

export function resolveAssignmentTarget(
  runtime: Runtime,
  identity: DerivedIdentity,
  session: CliSession,
  selector: string,
  allowUnreachable = false
): string {
  if (selector.includes(":")) {
    return selector;
  }

  const state = runtime.commands.getRoomState({
    room_id: session.room_id,
    agent_id: identity.agent_id,
    process_metadata: identity.process_metadata
  });
  const health = runtime.commands.getRoomHealth(identity, {
    context_path: session.workspace_root
  });
  const reachableIds = new Set(
    health.receivers
      .filter((receiver) => receiver.liveness === "alive")
      .map((receiver) => receiver.agent_id)
  );
  for (const member of state.members) {
    if (
      member.wait_intent === "parked" &&
      member.standby_transport === "cmux" &&
      member.standby_workspace_id &&
      member.standby_surface_id &&
      member.standby_registered_at &&
      member.standby_last_error === null
    ) {
      reachableIds.add(member.agent_id);
    }
  }
  const normalizedSelector = selector.toLowerCase();
  const candidates = state.members.filter((member) => {
    if (member.agent_id === identity.agent_id || member.status !== "active") {
      return false;
    }
    if (!allowUnreachable && !reachableIds.has(member.agent_id)) {
      return false;
    }

    if (normalizedSelector === "next") {
      return true;
    }

    return (
      member.agent_id.toLowerCase() === normalizedSelector ||
      member.agent_id.toLowerCase().startsWith(`${normalizedSelector}:`) ||
      member.display_name?.toLowerCase() === normalizedSelector
    );
  });

  if (candidates.length === 0) {
    throw new Error(
      allowUnreachable
        ? `No active room member matched assignment target: ${selector}`
        : `No reachable room member matched assignment target: ${selector}. Release for fair routing or use --operator-requested for an explicit override.`
    );
  }

  const events = runtime.commands.getRoomEvents({
    room_id: session.room_id,
    agent_id: identity.agent_id,
    limit: 500,
    process_metadata: identity.process_metadata
  });
  return pickFairAssignmentCandidate(candidates, events).agent_id;
}

function pickFairAssignmentCandidate(
  candidates: RoomMember[],
  events: RoomEvent[]
): RoomMember {
  const lastOwnership = new Map<string, string>();
  for (const event of events) {
    if (
      (event.event_type === "claim" || event.event_type === "takeover") &&
      event.to_agent_id
    ) {
      lastOwnership.set(event.to_agent_id, event.created_at);
    }
  }

  return candidates
    .slice()
    .sort((left, right) => {
      const leftTier = left.wait_intent === "active" ? 0 : 1;
      const rightTier = right.wait_intent === "active" ? 0 : 1;
      if (leftTier !== rightTier) {
        return leftTier - rightTier;
      }
      const leftLastOwned = lastOwnership.get(left.agent_id);
      const rightLastOwned = lastOwnership.get(right.agent_id);

      if (!leftLastOwned && rightLastOwned) return -1;
      if (leftLastOwned && !rightLastOwned) return 1;
      if (leftLastOwned && rightLastOwned && leftLastOwned !== rightLastOwned) {
        return Date.parse(leftLastOwned) - Date.parse(rightLastOwned);
      }

      return left.ordinal - right.ordinal;
    })[0];
}
