import { FullScreenDriver, createProcessTerminal } from "../../src/tui/terminal.js";

const terminal = createProcessTerminal();
const width = terminal.columns();
const rows = terminal.rows?.() ?? 24;
const driver = new FullScreenDriver(
  terminal,
  () => Array.from({ length: rows }, () => " ".repeat(width))
);

driver.enter();
setImmediate(() => {
  throw new Error("forced full-screen crash");
});
