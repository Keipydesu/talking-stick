import readline from "node:readline";

export interface ChatTerminal {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  columns: () => number;
  onResize: (listener: () => void) => () => void;
}

export function createProcessTerminal(): ChatTerminal {
  return {
    input: process.stdin,
    output: process.stdout,
    inputIsTTY: process.stdin.isTTY === true,
    outputIsTTY: process.stdout.isTTY === true,
    columns: () => process.stdout.columns ?? 80,
    onResize: (listener) => {
      process.stdout.on("resize", listener);
      return () => process.stdout.off("resize", listener);
    }
  };
}

export class ChatScreen {
  private prompt = "> ";
  private drawn = false;

  constructor(
    private readonly terminal: ChatTerminal,
    private readonly readlineInterface: readline.Interface,
    private readonly status: () => string
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
    this.terminal.output.write(`${this.status()}\n`);
    this.readlineInterface.setPrompt(this.prompt);
    this.readlineInterface.prompt(true);
    this.drawn = true;
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
    readline.moveCursor(this.terminal.output, 0, -1);
    readline.clearLine(this.terminal.output, 0);
    readline.cursorTo(this.terminal.output, 0);
    this.drawn = false;
  }
}
