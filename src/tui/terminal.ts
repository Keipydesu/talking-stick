import readline from "node:readline";

export interface ChatTerminal {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  isRaw?: () => boolean;
  setRawMode?: (enabled: boolean) => void;
  columns: () => number;
  rows?: () => number;
  onResize: (listener: () => void) => () => void;
}

export interface ScreenOutput {
  setPrompt(prompt: string): void;
  write(lines: string | string[]): void;
  finish(lines?: string | string[]): void;
  redraw(): void;
}

export function createProcessTerminal(): ChatTerminal {
  return {
    input: process.stdin,
    output: process.stdout,
    inputIsTTY: process.stdin.isTTY === true,
    outputIsTTY: process.stdout.isTTY === true,
    isRaw: () => process.stdin.isRaw === true,
    setRawMode: (enabled) => process.stdin.setRawMode?.(enabled),
    columns: () => normalizeTerminalColumns(process.stdout.columns),
    rows: () => normalizeTerminalRows(process.stdout.rows),
    onResize: (listener) => {
      process.stdout.on("resize", listener);
      return () => process.stdout.off("resize", listener);
    }
  };
}

export function normalizeTerminalColumns(columns: number | undefined): number {
  return columns || 80;
}

export function normalizeTerminalRows(rows: number | undefined): number {
  return rows || 24;
}

export class ChatScreen {
  private prompt = "> ";
  private drawn = false;
  private drawnStatusRows = 0;

  constructor(
    private readonly terminal: ChatTerminal,
    private readonly readlineInterface: readline.Interface,
    private readonly status: () => string | string[]
  ) {}

  setPrompt(prompt: string): void {
    this.prompt = prompt;
    this.redraw();
  }

  write(lines: string | string[]): void {
    const values = Array.isArray(lines) ? lines : [lines];
    this.eraseManagedRegion();
    for (const line of values) {
      this.terminal.output.write(`${line}\n`);
    }
    this.redraw();
  }

  finish(lines: string | string[] = []): void {
    const values = Array.isArray(lines) ? lines : [lines];
    this.eraseManagedRegion();
    for (const line of values) {
      this.terminal.output.write(`${line}\n`);
    }
  }

  redraw(): void {
    this.eraseManagedRegion();
    if (!this.terminal.outputIsTTY) return;
    const status = this.status();
    const lines = Array.isArray(status) ? status : [status];
    for (const line of lines) {
      this.terminal.output.write(`${line}\n`);
    }
    this.readlineInterface.setPrompt(this.prompt);
    this.readlineInterface.prompt(true);
    this.drawn = true;
    this.drawnStatusRows = lines.length;
  }

  private eraseManagedRegion(): void {
    if (!this.terminal.outputIsTTY || !this.drawn) return;
    const wrappedInputRows = this.readlineInterface.getCursorPos().rows;
    for (let row = 0; row <= wrappedInputRows; row += 1) {
      readline.clearLine(this.terminal.output, 0);
      readline.cursorTo(this.terminal.output, 0);
      if (row < wrappedInputRows) {
        readline.moveCursor(this.terminal.output, 0, -1);
      }
    }
    for (let row = 0; row < this.drawnStatusRows; row += 1) {
      readline.moveCursor(this.terminal.output, 0, -1);
      readline.clearLine(this.terminal.output, 0);
      readline.cursorTo(this.terminal.output, 0);
    }
    this.drawn = false;
    this.drawnStatusRows = 0;
  }
}

const ENTER_ALT_SCREEN = "\u001b[?1049h";
const LEAVE_ALT_SCREEN = "\u001b[?1049l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

export class FullScreenDriver {
  private readonly initialRawMode: boolean;
  private active = false;
  private restored = false;
  private readonly restoreListener = () => this.restore();

  constructor(
    private readonly terminal: ChatTerminal,
    private readonly frame: () => string[]
  ) {
    this.initialRawMode = terminal.isRaw?.() ?? false;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.restored = false;
    this.terminal.setRawMode?.(true);
    this.terminal.output.write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}`);
    process.on("uncaughtExceptionMonitor", this.restoreListener);
    process.on("exit", this.restoreListener);
    this.redraw();
  }

  redraw(): void {
    if (!this.active || this.restored) return;
    const rows = this.frame();
    const painted = rows.map((row, index) =>
      index === 0 ? row : `\u001b[${index + 1};1H${row}`
    ).join("");
    this.terminal.output.write(`\u001b[H${painted}\u001b[J`);
  }

  restore(): void {
    if (this.restored) return;
    this.restored = true;
    this.active = false;
    process.off("uncaughtExceptionMonitor", this.restoreListener);
    process.off("exit", this.restoreListener);
    this.terminal.setRawMode?.(this.initialRawMode);
    this.terminal.output.write(`${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
  }
}

export function terminateProcess(signal: "SIGINT" | "SIGTERM"): void {
  process.kill(process.pid, signal);
}
