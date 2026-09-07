import readline from "node:readline";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  ChatScreen,
  FullScreenDriver,
  type ChatTerminal
} from "../src/tui/terminal.js";

describe("chat screen", () => {
  test("keeps every dashboard row managed above the prompt", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = "";
    let prompts = 0;
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      captured += chunk;
    });
    const terminal: ChatTerminal = {
      input,
      output,
      inputIsTTY: true,
      outputIsTTY: true,
      columns: () => 80,
      onResize: () => () => undefined
    };
    const readlineInterface = {
      getCursorPos: () => ({ cols: 2, rows: 0 }),
      prompt: () => {
        prompts += 1;
      },
      setPrompt: () => undefined
    } as unknown as readline.Interface;
    const screen = new ChatScreen(terminal, readlineInterface, () => [
      "room",
      "cwd",
      "members",
      "stick"
    ]);

    screen.redraw();
    screen.write("new event");
    screen.finish();
    input.destroy();
    output.destroy();

    expect(captured).toContain("room\ncwd\nmembers\nstick\n");
    expect(captured.lastIndexOf("new event")).toBeLessThan(captured.lastIndexOf("room"));
    expect(prompts).toBe(2);
  });

  test("full-screen driver repaints in place and restores exactly once", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = "";
    let rawMode = false;
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { captured += chunk; });
    const terminal: ChatTerminal = {
      input,
      output,
      inputIsTTY: true,
      outputIsTTY: true,
      isRaw: () => rawMode,
      setRawMode: (enabled) => { rawMode = enabled; },
      columns: () => 8,
      rows: () => 2,
      onResize: () => () => undefined
    };
    const driver = new FullScreenDriver(terminal, () => ["12345678", "abcdefgh"]);

    driver.enter();
    driver.redraw();
    expect(rawMode).toBe(true);
    expect(captured.match(/\u001b\[H/g)).toHaveLength(2);
    expect(captured).not.toContain("\u001b[2J");

    driver.restore();
    driver.restore();
    expect(rawMode).toBe(false);
    expect(captured.match(/\u001b\[\?1049l/g)).toHaveLength(1);
    input.destroy();
    output.destroy();
  });

  test("uncaught exception backstop restores the primary screen", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = "";
    let rawMode = false;
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { captured += chunk; });
    const terminal: ChatTerminal = {
      input,
      output,
      inputIsTTY: true,
      outputIsTTY: true,
      isRaw: () => rawMode,
      setRawMode: (enabled) => { rawMode = enabled; },
      columns: () => 8,
      rows: () => 1,
      onResize: () => () => undefined
    };
    const driver = new FullScreenDriver(terminal, () => ["frame   "]);
    driver.enter();

    process.emit("uncaughtExceptionMonitor", new Error("forced crash"), "uncaughtException");

    expect(rawMode).toBe(false);
    expect(captured).toContain("\u001b[?25h\u001b[?1049l");
    input.destroy();
    output.destroy();
  });

  const ptyTest = process.platform === "win32" ? test.skip : test;
  ptyTest("restores the primary buffer after a forced crash in a pseudo-terminal", () => {
    const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    const worker = path.join(process.cwd(), "tests", "fixtures", "tui-crash-worker.ts");
    const result = spawnSync("python3", [
      "-c",
      "import pty,sys; sys.exit(pty.spawn(sys.argv[1:]))",
      tsx,
      worker
    ], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 10_000
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(output).toContain("forced full-screen crash");
    expect(output).toContain("\u001b[?1049h");
    expect(output).toContain("\u001b[?25h\u001b[?1049l");
    expect(output.lastIndexOf("\u001b[?1049l"))
      .toBeGreaterThan(output.indexOf("\u001b[?1049h"));
  });

  ptyTest("Ctrl-C, SIGINT, and SIGTERM restore and terminate the process", () => {
    const worker = path.join(process.cwd(), "tests", "fixtures", "tui-exit-worker.ts");
    for (const [mode, expectedExit] of [
      ["ctrl-c", -2],
      ["sigint", -2],
      ["sigterm", -15]
    ] as const) {
      const result = spawnSync("python3", [
        "-c",
        PTY_EXIT_PROBE,
        mode,
        process.execPath,
        "--import",
        "tsx",
        worker
      ], {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        timeout: 10_000
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(output, mode).not.toContain("__TIMEOUT__");
      expect(output, mode).toContain(`__EXIT__=${expectedExit}`);
      expect(output, mode).toContain("\u001b[?1049h");
      expect(output, mode).toContain("\u001b[?25h\u001b[?1049l");
    }
  });
});

const PTY_EXIT_PROBE = [
  "import os,pty,select,signal,sys,time",
  "mode=sys.argv[1]",
  "cmd=sys.argv[2:]",
  "pid,fd=pty.fork()",
  "if pid==0: os.execv(cmd[0],cmd)",
  "time.sleep(0.4)",
  "os.write(fd,b'\\x03') if mode=='ctrl-c' else os.kill(pid, signal.SIGINT if mode=='sigint' else signal.SIGTERM)",
  "data=b''",
  "status=None",
  "deadline=time.time()+5",
  "while status is None and time.time()<deadline:",
  " ready,_,_=select.select([fd],[],[],0.1)",
  " if ready:",
  "  try: data+=os.read(fd,65536)",
  "  except OSError: pass",
  " found,current=os.waitpid(pid,os.WNOHANG)",
  " if found: status=current",
  "if status is None:",
  " os.kill(pid,signal.SIGKILL)",
  " os.waitpid(pid,0)",
  " data+=b'\\n__TIMEOUT__'",
  "sys.stdout.buffer.write(data)",
  "print('\\n__EXIT__='+str(os.waitstatus_to_exitcode(status)) if status is not None else '')"
].join("\n");
