import { describe, expect, test } from "vitest";
import { createTheme, identityColorIndex } from "../src/tui/theme.js";

describe("TUI theme", () => {
  test("assigns stable 256-color identities", () => {
    expect(identityColorIndex("codex:one")).toBe(identityColorIndex("codex:one"));
    expect(createTheme({ isTTY: true, env: {} }).identity("codex:one", "codex"))
      .toMatch(/\u001b\[38;5;\d+m/);
  });

  test("honors non-TTY, NO_COLOR, and dumb terminals", () => {
    expect(createTheme({ isTTY: false, env: {} }).color).toBe(false);
    expect(createTheme({ isTTY: true, env: { NO_COLOR: "1" } }).color).toBe(false);
    expect(createTheme({ isTTY: true, env: { TERM: "dumb" } }).color).toBe(false);
  });

  test("adds a non-color-independent self treatment only when styling is enabled", () => {
    const theme = createTheme({ isTTY: true, env: {} });
    expect(theme.identity("human:me", "me", true)).toContain("\u001b[4m");
    expect(createTheme({ isTTY: false, env: {} }).identity("human:me", "me", true))
      .toBe("me");
  });
});
