import { describe, expect, test } from "vitest";
import { parseChatInput, tokenize } from "../src/tui/parse.js";

describe("parseChatInput", () => {
  test("treats ordinary text as a room message without rewriting it", () => {
    expect(parseChatInput("  hello   room  ")).toEqual({
      kind: "message",
      body: "  hello   room  "
    });
  });

  test("ignores empty input and opens the palette for a bare slash", () => {
    expect(parseChatInput("   ")).toEqual({ kind: "empty" });
    expect(parseChatInput("/   ")).toEqual({ kind: "palette" });
  });

  test("resolves commands, aliases, and unambiguous prefixes", () => {
    expect(parseChatInput("/msg codex hello")).toMatchObject({
      kind: "action",
      action: { name: "msg" },
      args: ["codex", "hello"]
    });
    expect(parseChatInput("/dm claude hi")).toMatchObject({
      kind: "action",
      action: { name: "msg" },
      args: ["claude", "hi"]
    });
    expect(parseChatInput("/ins")).toMatchObject({
      kind: "action",
      action: { name: "instructions" }
    });
  });

  test("reports unknown and ambiguous prefixes", () => {
    expect(parseChatInput("/wat")).toEqual({
      kind: "error",
      message: "Unknown action /wat. Type /help to see available actions."
    });
    expect(parseChatInput("/h")).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/Ambiguous action \/h:.*\/help.*\/health.*\/history/)
    });
  });

  test("parses quoted action arguments", () => {
    expect(parseChatInput('/msg codex "two words"')).toMatchObject({
      kind: "action",
      args: ["codex", "two words"]
    });
    expect(parseChatInput("/note 'keep $literal'")).toMatchObject({
      kind: "action",
      args: ["keep $literal"]
    });
  });

  test("reports unclosed quotes", () => {
    expect(parseChatInput('/msg codex "unfinished')).toEqual({
      kind: "error",
      message: "Unclosed double quote."
    });
  });
});

describe("tokenize", () => {
  test("supports escaped spaces and empty quoted values", () => {
    expect(tokenize('msg codex hello\\ world ""')).toEqual([
      "msg",
      "codex",
      "hello world",
      ""
    ]);
  });
});
