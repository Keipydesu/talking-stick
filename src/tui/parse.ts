import {
  findActionCandidates,
  findExactAction,
  type ChatAction
} from "./actions.js";

export type ParsedChatInput =
  | { kind: "empty" }
  | { kind: "message"; body: string }
  | { kind: "palette" }
  | { kind: "action"; action: ChatAction; args: string[] }
  | { kind: "error"; message: string };

export function parseChatInput(line: string): ParsedChatInput {
  if (line.trim().length === 0) {
    return { kind: "empty" };
  }
  if (!line.startsWith("/")) {
    return { kind: "message", body: line };
  }
  if (line.trim() === "/") {
    return { kind: "palette" };
  }

  const tokenized = tokenize(line.slice(1));
  if (typeof tokenized === "string") {
    return { kind: "error", message: tokenized };
  }

  const [name, ...args] = tokenized;
  if (!name) {
    return { kind: "palette" };
  }
  const exact = findExactAction(name);
  if (exact) {
    return { kind: "action", action: exact, args };
  }

  const candidates = findActionCandidates(name);
  if (candidates.length === 1) {
    return { kind: "action", action: candidates[0], args };
  }
  if (candidates.length > 1) {
    return {
      kind: "error",
      message: `Ambiguous action /${name}: ${candidates.map((candidate) => `/${candidate.name}`).join(", ")}`
    };
  }
  return {
    kind: "error",
    message: `Unknown action /${name}. Type /help to see available actions.`
  };
}

export function tokenize(input: string): string[] | string {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let started = false;

  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    return `Unclosed ${quote === "'" ? "single" : "double"} quote.`;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}
