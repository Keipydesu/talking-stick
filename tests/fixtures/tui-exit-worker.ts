import readline from "node:readline";
import {
  FullScreenDriver,
  createProcessTerminal,
  terminateProcess
} from "../../src/tui/terminal.js";

const terminal = createProcessTerminal();
const width = terminal.columns();
const rows = terminal.rows?.() ?? 24;
const driver = new FullScreenDriver(
  terminal,
  () => Array.from({ length: rows }, () => " ".repeat(width))
);
let stopping = false;
const stop = (signal: "SIGINT" | "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  driver.restore();
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  terminateProcess(signal);
};
const interrupt = () => stop("SIGINT");
const terminate = () => stop("SIGTERM");

process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
readline.emitKeypressEvents(process.stdin);
process.stdin.on("keypress", (_character, key) => {
  if (key.ctrl && key.name === "c") interrupt();
});
driver.enter();
setInterval(() => undefined, 1_000);
