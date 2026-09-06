import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  createSystemProcessInspector,
  findCliSessionByRoom,
  getCurrentProcessStartedAt,
  resolveCliSessionPath,
  upsertCliSession,
  type DerivedIdentity,
  type WaitForTurnResult
} from "../index.js";
import {
  hasCmuxCallerContext,
  resolveCmuxStandbyEndpoint
} from "../wake.js";
import { waitForActionableSignal } from "../wait-loop.js";
import {
  checkGuardianLiveness,
  spawnGuardian
} from "./guardian.js";
import { resolveHandoff } from "./handoff.js";
import {
  deriveCliIdentity,
  resolveTakeoverReason,
  shouldUseOperatorOverride
} from "./identity.js";
import {
  getStringOption,
  hasOption,
  parseRequiredInteger,
  parseWaitTimeout,
  type ParsedCommand
} from "./parser.js";
import {
  formatWaitResult,
  printResult
} from "./output.js";
import {
  upsertSessionFromJoin
} from "./session.js";
import type { Runtime } from "./runtime.js";
import {
  assignTurnSession,
  releaseTurnSession,
  takeTurnSession
} from "./turn-session.js";

export async function handleWaitCommand(
  runtime: Runtime,
  parsed: ParsedCommand,
  isTry: boolean,
  cliEntryUrl: string
): Promise<void> {
  const park = hasOption(parsed, "park");
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const identity = deriveCliIdentity(parsed);
  const joined = runtime.commands.joinPath(identity, { context_path: contextPath });
  upsertSessionFromJoin(identity, joined);
  const sessionPath = resolveCliSessionPath();
  const session = findCliSessionByRoom(sessionPath, identity.agent_id, joined.room_id);
  const hasExplicitCursor = hasOption(parsed, "after");
  const afterEventSeq = hasExplicitCursor
    ? parseRequiredInteger(parsed, "after")
    : session?.event_cursor_seq ?? joined.cursor_event_seq;
  const target = getStringOption(parsed, "target");
  if (target && target !== "self") {
    throw new Error(
      "tt wait manages the self cursor only. Use `tt events --target ...` for audit/debug reads."
    );
  }
  const targetAgentId = "self" as const;

  const explicitTimeout = hasOption(parsed, "timeout");
  let currentCursor = afterEventSeq;
  const receiverId = isTry ? null : randomUUID();
  if (receiverId) {
    runtime.commands.registerReceiver(identity, {
      room_id: joined.room_id,
      receiver_id: receiverId,
      harness_session_id:
        identity.process_metadata.harness_session_id ?? null,
      host_id: os.hostname(),
      pid: process.pid,
      process_started_at: getCurrentProcessStartedAt(),
      cursor_event_seq: currentCursor
    });
    const harnessSessionId = identity.process_metadata.harness_session_id;
    try {
      if (!harnessSessionId) {
        throw new Error("No harness session is available for endpoint scoping.");
      }
      if (!hasCmuxCallerContext()) {
        throw new Error("No cmux caller context is available.");
      }
      const endpoint = resolveCmuxStandbyEndpoint();
      runtime.commands.registerWakeEndpoint(identity, {
        room_id: joined.room_id,
        workspace_id: endpoint.workspace_id,
        surface_id: endpoint.surface_id
      });
    } catch {
      // Absence of a cmux surface is a valid state; interrupts then rely on
      // the live receiver alone.
    }
  }

  let waitResult: WaitForTurnResult;
  try {
    waitResult = await waitForActionableSignal(
      async () => {
        const result = await runtime.commands.waitForTurn(identity, {
          room_id: joined.room_id,
          max_wait_ms: isTry ? 0 : parseWaitTimeout(parsed),
          auto_claim: park ? false : undefined,
          mode: park ? "parked" : "active",
          include_events: true,
          after_event_seq: currentCursor,
          target_agent_id: targetAgentId,
          // An unbounded default wait keeps listening through advisory
          // owner_idle; `tt try` and explicit --timeout still report it.
          advisory_takeover_wake: isTry || explicitTimeout
        });
        currentCursor = result.cursor_event_seq ?? currentCursor;
        return result;
      },
      {
        is_try: isTry,
        explicit_timeout: explicitTimeout,
        on_internal_timeout: () => {
          if (!hasExplicitCursor) {
            persistWaitCursor(identity, joined, currentCursor);
          }
          if (receiverId) {
            runtime.commands.heartbeatReceiver(identity, {
              room_id: joined.room_id,
              receiver_id: receiverId,
              cursor_event_seq: currentCursor
            });
          }
        }
      }
    );
  } finally {
    if (receiverId) {
      runtime.commands.unregisterReceiver(identity, {
        room_id: joined.room_id,
        receiver_id: receiverId,
        cursor_event_seq: currentCursor
      });
    }
  }
  const returnedCursor = waitResult.cursor_event_seq ?? afterEventSeq;

  const nextReminder =
    "Keep one `tt wait --json` running; a duplicate for this room member is rejected.";

  if (waitResult.status === "your_turn") {
    if (waitResult.reason === "already_owner") {
      const sessionPath = resolveCliSessionPath();
      const existing = findCliSessionByRoom(
        sessionPath,
        identity.agent_id,
        joined.room_id
      );

      const liveness = existing?.guardian_pid
        ? checkGuardianLiveness(
            {
              pid: existing.guardian_pid,
              process_started_at: existing.guardian_process_started_at
            },
            createSystemProcessInspector()
          )
        : "gone";

      if (liveness === "gone") {
        const replacement = await spawnGuardian({
          agentId: identity.agent_id,
          canonicalPath: joined.canonical_path,
          roomId: joined.room_id,
          leaseId: waitResult.lease_id,
          turnId: waitResult.turn_id,
          cliEntryUrl,
          processMetadata: identity.process_metadata
        });

        upsertCliSession(sessionPath, {
          agent_id: identity.agent_id,
          room_id: joined.room_id,
          canonical_path: joined.canonical_path,
          workspace_root: joined.workspace_root,
          lease_id: waitResult.lease_id,
          turn_id: waitResult.turn_id,
          guardian_pid: replacement.pid,
          guardian_process_started_at: replacement.process_started_at,
          updated_at: new Date().toISOString()
        });

        printResult(
          parsed,
          { ...waitResult, guardian_pid: replacement.pid, next: nextReminder },
          () => {
            const reason = existing?.guardian_pid
              ? "Prior guardian was gone"
              : "No guardian was recorded";
            const body = `Already holding the stick (turn ${waitResult.turn_id}). ${reason}; spawned replacement ${replacement.pid}.`;
            return `${body}\n\nnext: ${nextReminder}`;
          }
        );
        if (!hasExplicitCursor) {
          persistWaitCursor(identity, joined, returnedCursor);
        }
        return;
      }

      const guardianPid = existing?.guardian_pid;
      printResult(
        parsed,
        { ...waitResult, guardian_pid: guardianPid ?? null, next: nextReminder },
        () => {
          let body = "";
          if (!guardianPid) {
            body = `Already holding the stick (turn ${waitResult.turn_id}).`;
          } else {
            const descriptor = liveness === "alive" ? "still active" : "liveness unknown";
            body = `Already holding the stick (turn ${waitResult.turn_id}). Guardian ${guardianPid} (${descriptor}).`;
          }
          return `${body}\n\nnext: ${nextReminder}`;
        }
      );
      if (!hasExplicitCursor) {
        persistWaitCursor(identity, joined, returnedCursor);
      }
      return;
    }

    const guardianPid = await spawnGuardian({
      agentId: identity.agent_id,
      canonicalPath: joined.canonical_path,
      roomId: joined.room_id,
      leaseId: waitResult.lease_id,
      turnId: waitResult.turn_id,
      cliEntryUrl,
      processMetadata: identity.process_metadata
    });

    upsertCliSession(resolveCliSessionPath(), {
      agent_id: identity.agent_id,
      room_id: joined.room_id,
      canonical_path: joined.canonical_path,
      workspace_root: joined.workspace_root,
      lease_id: waitResult.lease_id,
      turn_id: waitResult.turn_id,
      guardian_pid: guardianPid.pid,
      guardian_process_started_at: guardianPid.process_started_at,
      updated_at: new Date().toISOString()
    });

    printResult(
      parsed,
      { ...waitResult, guardian_pid: guardianPid.pid, next: nextReminder },
      () => {
        const body = formatWaitResult(waitResult);
        return `${body}\n\nGuardian ${guardianPid.pid} is holding the lease.\n\nnext: ${nextReminder}`;
      }
    );
    if (!hasExplicitCursor) {
      persistWaitCursor(identity, joined, returnedCursor);
    }
    return;
  }

  printResult(
    parsed,
    { ...waitResult, next: nextReminder },
    () => {
      const body = formatWaitResult(waitResult);
      return `${body}\n\nnext: ${nextReminder}`;
    }
  );
  if (!hasExplicitCursor) {
    persistWaitCursor(identity, joined, returnedCursor);
  }
}

export function handleStandbyCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): void {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const identity = deriveCliIdentity(parsed);
  const joined = runtime.commands.joinPath(identity, {
    context_path: contextPath
  });
  upsertSessionFromJoin(identity, joined);
  const requestedTransport = getStringOption(parsed, "wake");
  if (
    requestedTransport !== undefined &&
    requestedTransport !== "cmux" &&
    requestedTransport !== "manual"
  ) {
    throw new Error("--wake must be cmux or manual.");
  }
  let transport: "cmux" | "manual" = requestedTransport ?? "cmux";

  let endpoint = null;
  let fallbackReason: string | undefined;
  if (transport === "cmux") {
    try {
      if (!hasCmuxCallerContext()) {
        throw new Error("No cmux caller context is available.");
      }
      endpoint = resolveCmuxStandbyEndpoint();
    } catch (error) {
      if (requestedTransport !== undefined) {
        throw error;
      }
      transport = "manual";
      fallbackReason =
        error instanceof Error ? error.message : String(error);
    }
  }
  const result = runtime.commands.registerStandby(identity, {
    room_id: joined.room_id,
    transport,
    workspace_id: endpoint?.workspace_id,
    surface_id: endpoint?.surface_id
  });

  printResult(
    parsed,
    fallbackReason ? { ...result, fallback_reason: fallbackReason } : result,
    () => {
      if (result.can_self_wake) {
        return "Standby registered. This turn may end; cmux will wake this surface for an actionable update.";
      }
      if (fallbackReason) {
        return `Manual standby registered because cmux wake is unavailable (${fallbackReason}). It cannot self-wake; run \`tt wait --json\` to resume.`;
      }
      return "Manual standby registered. It cannot self-wake; run `tt wait --json` to resume.";
    }
  );
}

function persistWaitCursor(
  identity: DerivedIdentity,
  joined: {
    room_id: string;
    canonical_path: string;
    workspace_root: string;
  },
  eventCursorSeq: number
): void {
  upsertCliSession(resolveCliSessionPath(), {
    agent_id: identity.agent_id,
    room_id: joined.room_id,
    canonical_path: joined.canonical_path,
    workspace_root: joined.workspace_root,
    event_cursor_seq: eventCursorSeq,
    updated_at: new Date().toISOString()
  });
}

export async function handleTakeCommand(
  runtime: Runtime,
  parsed: ParsedCommand,
  cliEntryUrl: string
): Promise<void> {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const identity = deriveCliIdentity(parsed);
  const reason = resolveTakeoverReason(parsed);
  const operatorOverride = shouldUseOperatorOverride(parsed);
  const result = await takeTurnSession({
    runtime,
    identity,
    contextPath,
    reason,
    operatorOverride,
    cliEntryUrl
  });

  printResult(
    parsed,
    result,
    () => `Took the stick. Guardian ${result.guardian_pid} is holding the lease.`
  );
}

export async function handleReleaseCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  rejectUnsupportedPathOption(parsed, "release");
  const identity = deriveCliIdentity(parsed);
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const handoff = await resolveHandoff(parsed);
  const result = releaseTurnSession({
    runtime,
    identity,
    contextPath,
    handoff
  });

  printResult(parsed, result, () => {
    const target = result.reserved_for ? ` to ${result.reserved_for}` : "";
    const parked =
      result.parked_hinted.length > 0
        ? ` Parked hint: ${result.parked_hinted.join(", ")}.`
        : "";
    return `Released${target}.${parked}`;
  });
}

export async function handlePassCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  rejectUnsupportedPathOption(parsed, "pass");
  if (parsed.positionals[0]?.includes(":")) {
    await handleAssignCommand(runtime, parsed);
    return;
  }

  const identity = deriveCliIdentity(parsed);
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const handoff = await resolveHandoff(parsed);
  const result = releaseTurnSession({
    runtime,
    identity,
    contextPath,
    handoff
  });
  printResult(parsed, result, () => {
    const reserved = result.reserved_for ? ` Next: ${result.reserved_for}.` : "";
    return `Passed turn.${reserved}`;
  });
}

export async function handleAssignCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  rejectUnsupportedPathOption(parsed, "assign");
  const targetSelector = parsed.positionals[0];
  if (!targetSelector) {
    throw new Error("Usage: tt assign <target|next> [path] (--status TEXT --next-action TEXT | --stdin)");
  }

  const identity = deriveCliIdentity(parsed);
  const contextPath = parsed.positionals[1] ?? process.cwd();
  const handoff = await resolveHandoff(parsed);
  const result = assignTurnSession({
    runtime,
    identity,
    contextPath,
    targetSelector,
    handoff,
    operatorOverride: hasOption(parsed, "operator-requested")
  });

  printResult(parsed, result, () => `Passed to ${result.reserved_for}.`);
}

function rejectUnsupportedPathOption(
  parsed: ParsedCommand,
  commandName: "release" | "pass" | "assign"
): void {
  if (hasOption(parsed, "path")) {
    throw new Error(
      `tt ${commandName} takes its workspace path positionally; --path is not supported.`
    );
  }
}
