import { resolveCliIdentity } from "./identity.js";
import type { ParsedCommand } from "./parser.js";
import type { Runtime } from "./runtime.js";
import { runChatApp } from "../tui/app.js";
import { createProcessTerminal } from "../tui/terminal.js";

export async function handleChatCommand(
  runtime: Runtime,
  parsed: ParsedCommand,
  cliEntryUrl: string
): Promise<void> {
  const terminal = createProcessTerminal();
  const resolution = resolveCliIdentity(parsed);
  if (resolution.identity.process_metadata.session_kind !== "human_cli") {
    throw new Error(
      "tt chat is for interactive human sessions. Agents should use `tt wait --json`."
    );
  }
  if (!terminal.inputIsTTY || !terminal.outputIsTTY) {
    throw new Error(
      "tt chat requires an interactive terminal. Use `tt events --follow --target any` for streamed output."
    );
  }

  await runChatApp({
    runtime,
    identity: resolution.identity,
    contextPath: parsed.positionals[0] ?? process.cwd(),
    cliEntryUrl,
    terminal
  });
}
