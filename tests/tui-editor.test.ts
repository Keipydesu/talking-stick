import { describe, expect, test } from "vitest";
import { InputEditor } from "../src/tui/editor.js";

describe("full-screen input editor", () => {
  test("edits around the cursor and supports readline-style controls", () => {
    const editor = new InputEditor();
    editor.insert("helo");
    editor.left();
    editor.insert("l");
    expect(editor.snapshot()).toMatchObject({ value: "hello", cursor: 4 });

    editor.home();
    editor.right();
    editor.killToEnd();
    expect(editor.snapshot().value).toBe("h");
    editor.insert(" two words");
    editor.deleteWord();
    expect(editor.snapshot().value).toBe("h two");
    editor.clear();
    expect(editor.snapshot().value).toBe("");
  });

  test("recalls history and completes slash commands", () => {
    const editor = new InputEditor();
    editor.insert("/state");
    expect(editor.submit()).toBe("/state");
    editor.insert("draft");
    editor.previousHistory();
    expect(editor.snapshot().value).toBe("/state");
    editor.nextHistory();
    expect(editor.snapshot().value).toBe("draft");
    editor.clear();
    editor.insert("/ins");
    editor.complete(["/instructions"]);
    expect(editor.snapshot().value).toBe("/instructions");
  });
});
