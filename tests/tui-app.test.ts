import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  deriveHumanCliIdentity,
  readCliSessions,
  resolveCliSessionPath,
  TalkingStickService,
  writeCliSessions
} from "../src/index.js";
import { createRuntime } from "../src/cli/runtime.js";
import { runChatApp } from "../src/tui/app.js";
import type { ChatTerminal } from "../src/tui/terminal.js";

describe("interactive room chat", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.TALKING_STICK_DATA_DIR;
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("plain input sends a room message and quit detaches", async () => {
    const harness = startChat(tempDirs);
    try {
      await waitFor(() => harness.outputText().includes("Type a message"));
      harness.input.write("hello from chat\n");
      await waitFor(() => roomEvents(harness.project).some(
        (event) => event.payload?.body === "hello from chat"
      ));
      harness.input.write("/quit\n");
      await harness.app;

      expect(harness.outputText()).toContain("→ tt msg send room 'hello from chat'");
      expect(harness.outputText()).toContain("You remain a room member");
      expect(harness.outputText()).not.toContain("-- project ·");
      expect(harness.outputText()).not.toContain("\u001b[?1049h");
      expect(roomEvents(harness.project).filter(
        (event) => event.payload?.body === "hello from chat"
      )).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  test("quiet-room quit cancels the production-length event wait", async () => {
    const harness = startChat(tempDirs, { productionPoll: true });
    try {
      await waitFor(() => harness.outputText().includes("Type a message"));
      await new Promise((resolve) => setTimeout(resolve, 300));

      const startedAt = Date.now();
      harness.input.write("/quit\n");
      await harness.app;

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(harness.outputText()).not.toContain("Chat stopped:");
    } finally {
      harness.close();
    }
  });

  test("restores terminal state and removes process recovery listeners", async () => {
    const uncaughtListeners = process.listenerCount("uncaughtExceptionMonitor");
    const exitListeners = process.listenerCount("exit");
    const harness = startChat(tempDirs);
    try {
      await waitFor(() => harness.outputText().includes("Type a message"));
      harness.setRawMode(true);
      harness.input.write("/quit\n");
      await harness.app;

      expect(harness.rawMode()).toBe(false);
      expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(uncaughtListeners);
      expect(process.listenerCount("exit")).toBe(exitListeners);
    } finally {
      harness.close();
    }
  });

  test("empty-line Tab opens the action menu and runs the selected action", async () => {
    const harness = startChat(tempDirs);
    try {
      await waitFor(() => harness.outputText().includes("Type a message"));
      harness.input.emit("keypress", undefined, { name: "tab" });
      harness.input.emit("keypress", "w", { name: "w" });
      harness.input.emit("keypress", "h", { name: "h" });
      harness.input.emit("keypress", "o", { name: "o" });
      harness.input.write("\n");

      await waitFor(() => harness.outputText().includes("→ tt state"));
      harness.input.write("/quit\n");
      await harness.app;

      expect(harness.outputText()).toContain("● human:chat-test (you)");
    } finally {
      harness.close();
    }
  });

  test("execution guard agrees with the menu's unavailable handoff reason", async () => {
    const harness = startChat(tempDirs);
    try {
      await waitFor(() => harness.outputText().includes("Type a message"));
      harness.input.write("/release\n");
      await waitFor(() => harness.outputText().includes("Unavailable: you need the stick"));
      harness.input.write("/quit\n");
      await harness.app;
    } finally {
      harness.close();
    }
  });

  test("buffered text cannot accidentally run the highlighted menu action", async () => {
    const harness = startChat(tempDirs);
    try {
      await waitFor(() => harness.outputText().includes("Type a message"));
      harness.input.emit("keypress", undefined, { name: "tab" });
      harness.input.write("leave\n");
      await waitFor(() => harness.outputText().includes("Menu selection not run"));

      const service = new TalkingStickService();
      try {
        expect(service.listRooms({ context_path: harness.project }).rooms[0]?.owner).toBeNull();
      } finally {
        service.close();
      }

      harness.input.emit("keypress", undefined, { name: "escape" });
      harness.input.write("/quit\n");
      await harness.app;
    } finally {
      harness.close();
    }
  });

  test("slash commands entered from global help still execute", async () => {
    const harness = startChat(tempDirs, { tty: true });
    try {
      await waitFor(() => harness.outputText().includes("tt · project"));
      harness.input.emit("keypress", "?", { name: "?" });
      await waitFor(() => harness.outputText().includes("ACTIONS & HELP"));
      for (const character of "/quit") {
        harness.input.emit("keypress", character, { name: character });
      }
      harness.input.emit("keypress", "\r", { name: "return" });
      await harness.app;

      expect(harness.outputText()).toContain("You remain a room member");
      expect(harness.outputText()).toContain("\u001b[?1049h");
      expect(harness.outputText()).toContain("\u001b[?1049l");
      expect(harness.rawMode()).toBe(false);
    } finally {
      harness.close();
    }
  });

  test("take persists a guarded session, owner quit refuses, and release cleans up", async () => {
    const harness = startChat(tempDirs);
    let guardianPid: number | undefined;
    try {
      await waitFor(() => harness.outputText().includes("Type a message"));
      harness.input.write("/take\n");
      await waitFor(() => {
        const session = readCliSessions(resolveCliSessionPath()).find(
          (candidate) => candidate.agent_id === "human:chat-test"
        );
        guardianPid = session?.guardian_pid ?? undefined;
        return Boolean(session?.lease_id && guardianPid);
      }, 5_000);

      harness.input.write("/quit\n");
      await waitFor(() => harness.outputText().includes("You hold the stick"));
      harness.input.write("/release\nImplemented chat\nReview the result\n/quit\n");
      await harness.app;

      const session = readCliSessions(resolveCliSessionPath()).find(
        (candidate) => candidate.agent_id === "human:chat-test"
      );
      expect(session).toMatchObject({
        lease_id: null,
        turn_id: null,
        guardian_pid: null
      });
      expect(harness.outputText()).toContain("Turn released");
    } finally {
      if (guardianPid) {
        try {
          process.kill(guardianPid, "SIGTERM");
        } catch {
          // The release path normally stops it first.
        }
      }
      harness.close();
    }
  });

  test("a self-targeted kick stops chat without rejoining", async () => {
    const harness = startChat(tempDirs);
    const admin = deriveHumanCliIdentity({
      agentId: "human:admin",
      displayName: "admin"
    });
    const service = new TalkingStickService();
    try {
      await waitFor(() => harness.outputText().includes("Type a message"));
      const joined = service.joinPath({
        agent_id: admin.agent_id,
        context_path: harness.project,
        process_metadata: admin.process_metadata
      });
      service.kickMember({
        agent_id: admin.agent_id,
        room_id: joined.room_id,
        target_agent_id: "human:chat-test",
        force: true,
        reason: "test removal"
      });

      await harness.app;
      const state = service.getRoomState({ room_id: joined.room_id });
      expect(state.members.map((member) => member.agent_id)).not.toContain("human:chat-test");
      expect(harness.outputText()).toContain("You were removed from the room");
    } finally {
      service.close();
      harness.close();
    }
  });

  test("forced owner quit releases the turn and clears its guardian session", async () => {
    const harness = startChat(tempDirs);
    let guardianPid: number | undefined;
    try {
      await waitFor(() => harness.outputText().includes("Type a message"));
      harness.input.write("/take\n");
      await waitFor(() => {
        const session = readCliSessions(resolveCliSessionPath()).find(
          (candidate) => candidate.agent_id === "human:chat-test"
        );
        guardianPid = session?.guardian_pid ?? undefined;
        return Boolean(session?.lease_id && guardianPid);
      }, 5_000);

      harness.input.write("/quit --force\n");
      await harness.app;

      const service = new TalkingStickService();
      try {
        const room = service.listRooms({ context_path: harness.project }).rooms[0];
        expect(room?.owner).toBeNull();
      } finally {
        service.close();
      }
      expect(readCliSessions(resolveCliSessionPath()).find(
        (candidate) => candidate.agent_id === "human:chat-test"
      )).toMatchObject({ lease_id: null, guardian_pid: null });
    } finally {
      if (guardianPid) {
        try {
          process.kill(guardianPid, "SIGTERM");
        } catch {
          // The forced quit path normally stops it first.
        }
      }
      harness.close();
    }
  });

  test("a failed exit release preserves the guardian and recoverable session", async () => {
    const harness = startChat(tempDirs);
    const outcome = harness.app.then(
      () => null,
      (error: unknown) => error
    );
    let guardianPid: number | undefined;
    try {
      await waitFor(() => harness.outputText().includes("Type a message"));
      harness.input.write("/take\n");
      await waitFor(() => {
        const session = readCliSessions(resolveCliSessionPath()).find(
          (candidate) => candidate.agent_id === "human:chat-test"
        );
        guardianPid = session?.guardian_pid ?? undefined;
        return Boolean(session?.lease_id && guardianPid);
      }, 5_000);

      const sessionsPath = resolveCliSessionPath();
      const sessions = readCliSessions(sessionsPath);
      const owned = sessions.find(
        (candidate) => candidate.agent_id === "human:chat-test"
      );
      if (!owned?.turn_id) throw new Error("Expected an owned chat session.");
      owned.turn_id += 99;
      writeCliSessions(sessionsPath, sessions);

      harness.input.end();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/guardian and CLI session were preserved/);

      const service = new TalkingStickService();
      try {
        const room = service.listRooms({ context_path: harness.project }).rooms[0];
        expect(room?.owner).toBe("human:chat-test");
      } finally {
        service.close();
      }
      const preserved = readCliSessions(sessionsPath).find(
        (candidate) => candidate.agent_id === "human:chat-test"
      );
      expect(preserved?.lease_id).toEqual(expect.any(String));
      expect(preserved?.guardian_pid).toBe(guardianPid);
      expect(isProcessAlive(guardianPid)).toBe(true);
      expect(harness.outputText()).toContain("Resolve the cause, then run `tt release`");
    } finally {
      if (guardianPid) {
        try {
          process.kill(guardianPid, "SIGTERM");
        } catch {
          // The regression intentionally leaves the guardian running.
        }
      }
      harness.close();
    }
  });
});

function startChat(
  tempDirs: string[],
  settings: { productionPoll?: boolean; tty?: boolean } = {}
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-chat-"));
  tempDirs.push(dataDir);
  process.env.TALKING_STICK_DATA_DIR = dataDir;
  const project = path.join(dataDir, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");

  const input = new PassThrough();
  const output = new PassThrough();
  let captured = "";
  let rawMode = false;
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    captured += chunk;
  });
  const terminal: ChatTerminal = {
    input,
    output,
    inputIsTTY: settings.tty === true,
    outputIsTTY: settings.tty === true,
    isRaw: () => rawMode,
    setRawMode: (enabled) => {
      rawMode = enabled;
    },
    columns: () => 100,
    rows: () => 30,
    onResize: () => () => undefined
  };
  const identity = deriveHumanCliIdentity({
    agentId: "human:chat-test",
    displayName: "chat-test"
  });
  const runtime = createRuntime();
  const app = runChatApp({
    runtime,
    identity,
    contextPath: project,
    cliEntryUrl: pathToFileURL(path.join(process.cwd(), "src", "cli.ts")).href,
    terminal,
    ...(settings.productionPoll ? {} : { pollWaitMs: 20 })
  });

  return {
    app,
    input,
    project,
    outputText: () => captured,
    rawMode: () => rawMode,
    setRawMode: (enabled: boolean) => {
      rawMode = enabled;
    },
    close: () => {
      input.end();
      runtime.close();
    }
  };
}

function roomEvents(project: string) {
  const service = new TalkingStickService();
  try {
    const room = service.listRooms({ context_path: project }).rooms[0];
    return room ? service.getRoomEvents({ room_id: room.room_id, limit: 500 }) : [];
  } finally {
    service.close();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
