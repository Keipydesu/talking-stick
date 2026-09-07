import { describe, expect, test } from "vitest";
import { CHAT_ACTIONS } from "../src/tui/actions.js";
import {
  actionConfiguration,
  buildChatInput,
  buildCommandPreview,
  createMenuState,
  selectedAction,
  setMenuOption,
  updateMenu
} from "../src/tui/menu.js";

describe("TUI action menu", () => {
  test("opens, navigates, filters, and escapes each stage", () => {
    let menu = updateMenu(createMenuState(), { type: "open" });
    expect(menu.stage).toBe("browse");
    menu = updateMenu(menu, { type: "down" });
    expect(selectedAction(menu)?.name).toBe("release");
    menu = updateMenu(menu, { type: "filter", value: "tak" });
    expect(selectedAction(menu)?.name).toBe("take");
    menu = updateMenu(menu, { type: "help" });
    expect(menu.stage).toBe("help");
    menu = updateMenu(menu, { type: "escape" });
    expect(menu.stage).toBe("browse");
    menu = updateMenu(menu, { type: "escape" });
    expect(menu.stage).toBe("closed");
  });

  test("edits boolean and value options with a live command preview", () => {
    let menu = updateMenu(createMenuState(), { type: "open" });
    menu = { ...menu, selectedActionId: "kick" };
    menu = updateMenu(menu, { type: "right" });
    expect(menu.stage).toBe("options");
    menu = setMenuOption(menu, "kick", "member", "claude:one");
    menu = setMenuOption(menu, "kick", "reason", "stale process");
    menu = { ...menu, selectedOptionIndex: 2 };
    menu = updateMenu(menu, { type: "toggle" });

    const kick = CHAT_ACTIONS.find((action) => action.name === "kick")!;
    const configuration = actionConfiguration(menu, kick);
    expect(buildCommandPreview(kick, configuration))
      .toBe("tt kick claude:one --reason 'stale process' --force");
    expect(buildChatInput(kick, configuration))
      .toBe("/kick claude:one 'stale process' --force");
  });

  test("keeps configured values when moving back to browse", () => {
    let menu = updateMenu(createMenuState(), { type: "open" });
    menu = { ...menu, selectedActionId: "take" };
    menu = updateMenu(menu, { type: "right" });
    menu = setMenuOption(menu, "take", "reason", "reviewing parser");
    menu = updateMenu(menu, { type: "left" });
    const take = CHAT_ACTIONS.find((action) => action.name === "take")!;
    expect(actionConfiguration(menu, take).reason).toBe("reviewing parser");
  });
});
