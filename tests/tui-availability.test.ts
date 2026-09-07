import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  TalkingStickCommands,
  TalkingStickService,
  type DerivedIdentity,
  type GetRoomHealthResult,
  type JoinPathResult,
  type RoomMember
} from "../src/index.js";
import { releaseTurnSession } from "../src/cli/turn-session.js";
import { CHAT_ACTIONS } from "../src/tui/actions.js";
import {
  actionAvailability,
  type CapabilitySnapshot
} from "../src/tui/availability.js";
import { createChatState } from "../src/tui/model.js";

describe("TUI action availability", () => {
  const services: TalkingStickService[] = [];
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const service of services.splice(0)) service.close();
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("requires both ownership and a recoverable lease for handoffs", () => {
    const snapshot = capability();
    const release = action("release");
    expect(actionAvailability(release, snapshot)).toBe("you need the stick");

    snapshot.state.room = { ...snapshot.state.room, owner: snapshot.state.selfAgentId };
    expect(actionAvailability(release, snapshot))
      .toBe("owned room has no recoverable lease session");

    snapshot.hasLeaseSession = true;
    expect(actionAvailability(release, snapshot)).toBe(true);
  });

  test("derives assignment reachability from current health", () => {
    const snapshot = capability();
    snapshot.state.room = { ...snapshot.state.room, owner: snapshot.state.selfAgentId };
    snapshot.hasLeaseSession = true;
    snapshot.health.receivers = [{
      room_id: "room-1",
      agent_id: "claude:one",
      receiver_id: "receiver-1",
      harness_session_id: null,
      host_id: "host",
      pid: 2,
      process_started_at: new Date(0).toISOString(),
      cursor_event_seq: 1,
      generation: 1,
      registered_at: new Date(0).toISOString(),
      heartbeat_at: new Date(0).toISOString(),
      liveness: "alive"
    }];

    expect(actionAvailability(action("assign"), snapshot, { member: "claude" })).toBe(true);
    expect(actionAvailability(action("assign"), snapshot, { member: "grok" }))
      .toBe("selected member is not reachable");
  });

  test("makes force-sensitive kick and quit legality explicit", () => {
    const snapshot = capability();
    expect(actionAvailability(action("kick"), snapshot, { member: "claude" }))
      .toBe("target is active; enable --force");
    expect(actionAvailability(action("kick"), snapshot, { member: "claude", force: true }))
      .toBe(true);

    snapshot.state.room = { ...snapshot.state.room, owner: snapshot.state.selfAgentId };
    expect(actionAvailability(action("quit"), snapshot)).toBe("You hold the stick; enable --force to close");
    expect(actionAvailability(action("quit"), snapshot, { force: true })).toBe(true);
  });

  test("take availability agrees with an operator takeover of a live lease", async () => {
    const harness = serviceHarness(services, tempRoots);
    const owner = identity("claude:owner", 2);
    const operator = identity("human:me", 3);
    harness.service.joinPath({
      agent_id: owner.agent_id,
      context_path: harness.project,
      process_metadata: owner.process_metadata
    });
    const joined = harness.service.joinPath({
      agent_id: operator.agent_id,
      context_path: harness.project,
      process_metadata: operator.process_metadata
    });
    await harness.service.waitForTurn({
      agent_id: owner.agent_id,
      room_id: joined.room_id,
      max_wait_ms: 0,
      process_metadata: owner.process_metadata
    });

    const snapshot = serviceCapability(harness.service, joined, operator, harness.project, false);
    const menuSaysAvailable = actionAvailability(action("take"), snapshot) === true;
    const realSucceeded = succeeds(() => harness.service.takeoverStick({
      agent_id: operator.agent_id,
      room_id: joined.room_id,
      expected_turn_id: snapshot.health.room.turn_id,
      reason: "operator requested takeover",
      operator_override: true,
      process_metadata: operator.process_metadata
    }));

    expect(menuSaysAvailable).toBe(realSucceeded);
    expect(realSucceeded).toBe(true);
  });

  test("kick availability agrees with the service force guard", () => {
    const harness = serviceHarness(services, tempRoots);
    const operator = identity("human:me", 2);
    const target = identity("claude:one", 3);
    const joined = harness.service.joinPath({
      agent_id: operator.agent_id,
      context_path: harness.project,
      process_metadata: operator.process_metadata
    });
    harness.service.joinPath({
      agent_id: target.agent_id,
      context_path: harness.project,
      process_metadata: target.process_metadata
    });
    const snapshot = serviceCapability(harness.service, joined, operator, harness.project, false);

    const regularVerdict = actionAvailability(action("kick"), snapshot, {
      member: target.agent_id
    });
    const regularSucceeded = succeeds(() => harness.service.kickMember({
      agent_id: operator.agent_id,
      room_id: joined.room_id,
      target_agent_id: target.agent_id
    }));
    expect(regularVerdict === true).toBe(regularSucceeded);
    expect(regularSucceeded).toBe(false);

    const forcedVerdict = actionAvailability(action("kick"), snapshot, {
      member: target.agent_id,
      force: true
    });
    const forcedSucceeded = succeeds(() => harness.service.kickMember({
      agent_id: operator.agent_id,
      room_id: joined.room_id,
      target_agent_id: target.agent_id,
      force: true
    }));
    expect(forcedVerdict === true).toBe(forcedSucceeded);
    expect(forcedSucceeded).toBe(true);
  });

  test("release availability agrees with the real missing-session guard", async () => {
    const harness = serviceHarness(services, tempRoots);
    const operator = identity("human:me", 2);
    const joined = harness.service.joinPath({
      agent_id: operator.agent_id,
      context_path: harness.project,
      process_metadata: operator.process_metadata
    });
    await harness.service.waitForTurn({
      agent_id: operator.agent_id,
      room_id: joined.room_id,
      max_wait_ms: 0,
      process_metadata: operator.process_metadata
    });
    const snapshot = serviceCapability(harness.service, joined, operator, harness.project, false);
    const menuSaysAvailable = actionAvailability(action("release"), snapshot) === true;

    const priorDataDir = process.env.TALKING_STICK_DATA_DIR;
    process.env.TALKING_STICK_DATA_DIR = harness.tempRoot;
    let realSucceeded: boolean;
    try {
      realSucceeded = succeeds(() => releaseTurnSession({
        runtime: {
          commands: new TalkingStickCommands(harness.service),
          close: () => undefined
        },
        identity: operator,
        contextPath: harness.project,
        handoff: { status: "done", next_action: "continue" }
      }));
    } finally {
      if (priorDataDir === undefined) delete process.env.TALKING_STICK_DATA_DIR;
      else process.env.TALKING_STICK_DATA_DIR = priorDataDir;
    }

    expect(menuSaysAvailable).toBe(realSucceeded);
    expect(realSucceeded).toBe(false);
  });
});

function serviceHarness(services: TalkingStickService[], tempRoots: string[]) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-availability-"));
  tempRoots.push(tempRoot);
  const project = path.join(tempRoot, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  const service = new TalkingStickService({
    dbPath: path.join(tempRoot, "rooms.sqlite"),
    processLivenessChecker: () => "alive"
  });
  services.push(service);
  return { tempRoot, project, service };
}

function identity(agentId: string, pid: number): DerivedIdentity {
  return {
    agent_id: agentId,
    process_metadata: {
      host_id: "test-host",
      pid,
      process_started_at: "2026-09-06T00:00:00.000Z"
    }
  };
}

function serviceCapability(
  service: TalkingStickService,
  joined: JoinPathResult,
  self: DerivedIdentity,
  project: string,
  hasLeaseSession: boolean
): CapabilitySnapshot {
  const health = service.getRoomHealth({
    context_path: project,
    agent_id: self.agent_id,
    process_metadata: self.process_metadata
  });
  const state = createChatState(joined);
  state.room = health.room;
  state.members = health.members.map((member) => ({
    agent_id: member.agent_id,
    status: member.status,
    display_name: member.display_name
  }));
  return { state, health, hasLeaseSession };
}

function succeeds(operation: () => unknown): boolean {
  try {
    operation();
    return true;
  } catch {
    return false;
  }
}

function action(name: string) {
  const found = CHAT_ACTIONS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing action ${name}`);
  return found;
}

function capability(options: { owner?: string | null; hasLeaseSession?: boolean } = {}): CapabilitySnapshot {
  const joined = joinResult();
  const state = createChatState(joined);
  state.members = members().map((member) => ({
    agent_id: member.agent_id,
    status: member.status,
    display_name: member.display_name
  }));
  state.room = { ...state.room, owner: options.owner ?? null };
  const health: GetRoomHealthResult = {
    room: state.room,
    members: members(),
    receivers: [],
    cursor_event_seq: 1,
    pending_handoff: null,
    takeover: { available: false }
  };
  return { state, health, hasLeaseSession: options.hasLeaseSession ?? false };
}

function members(): RoomMember[] {
  const base = {
    room_id: "room-1",
    ordinal: 0,
    joined_at: new Date(0).toISOString(),
    last_seen_at: new Date(0).toISOString(),
    last_wait_at: null,
    wait_intent: null,
    host_id: null,
    pid: null,
    process_started_at: null,
    session_kind: "human_cli" as const,
    harness_name: null,
    harness_session_id: null,
    harness_host_id: null,
    harness_pid: null,
    harness_process_started_at: null,
    last_park_hint_event_seq: null,
    standby_transport: null,
    standby_workspace_id: null,
    standby_surface_id: null,
    standby_generation: 0,
    standby_wake_pending: false,
    standby_registered_at: null,
    standby_last_error: null,
    standby_delivered_at: null,
    receiver_generation: 0,
    wake_workspace_id: null,
    wake_surface_id: null,
    wake_endpoint_session_id: null,
    wake_endpoint_recorded_at: null,
    wake_interrupt_delivered_at: null,
    wake_endpoint_generation: 0
  };
  return [
    { ...base, agent_id: "human:me", display_name: "me", status: "active" },
    { ...base, ordinal: 1, agent_id: "claude:one", display_name: "claude", status: "active" }
  ];
}

function joinResult(): JoinPathResult {
  return {
    agent_id: "human:me",
    room_id: "room-1",
    canonical_path: "/repo",
    requested_path: "/repo",
    workspace_root: "/repo",
    joined_existing_room: true,
    cursor_event_seq: 1,
    members: members(),
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
