# Room TUI v3 — full-pane alternate screen

Supersedes the inline-dashboard direction in `2026-09-06-room-tui.md`.

## Why

The operator ran the inline v2 build and rejected it: *"i would definetly like it to be
full pane based since pressing action now infinetely scrolls and is ugly."*

Reproduced in a pty at 110x40: every state change reprints the whole dashboard frame and
the previous frame is not fully erased, so opening Actions and moving the selection stacks
copies down the scrollback.

Root cause of the stacking (diagnosed, not speculative): `ChatScreen.eraseManagedRegion`
tracks `drawnStatusRows = lines.length` — *logical* lines — while `renderDashboard` pads
every line to exactly `options.width` via `fitWidth`. A line exactly `columns` wide plus
`\n` occupies two physical rows, so erase walks up too few rows and leaves residue.

That specific bug is fixable in place, and the operator was shown that option explicitly.
They chose the full-pane rewrite anyway. The inline approach would still be a reprinted
box rather than real panes, and the goal is a full TUI.

## Non-goals

Replacing agent-facing `tt wait`. Covering the full 25-command surface. Multi-room
switching, mouse support, themes. Chat scrollback — the operator confirmed twice they do
not need it ("i can always look at the panes running my agents"), which is what makes
discarding history on alt-screen exit acceptable rather than a regression.

## Layout

The operator selected this shape; honor it.

```
┌─ tt · <room> ─────────────────────┬──────────────┐
│ cwd  ~/projects/forks/talking-stick│ MEMBERS      │
│ turn 24 · owned                    │ ● you        │
├────────────────────────────────────┤ ◆ codex      │
│ 00:19  codex  → you   passed turn  │ ○ grok       │
│ 00:17  you    → codex OPERATOR ... │              │
│                                    ├──────────────┤
│                                    │ stick: codex │
└────────────────────────────────────┴──────────────┘
 Tab actions · ? help · /quit detach
```

Glyphs carry meaning without color: `●` active, `◆` holds the stick, `○` inactive.
Identity color and the self underline stay decorative on top, never load-bearing.

Activity pane shows the last N entries where N is whatever fits the pane; keep at most
200 in memory. Oldest scroll out of the pane, not into scrollback.

## Architecture

**Pure frame renderer.** `renderFrame(input): string[]` returns exactly `rows` lines, each
padded to `width`. It takes state, menu, capability snapshot, and `{width, rows}` and
touches no terminal. This is the whole testable surface and must be unit-tested without a
pty — the current non-TTY test harness cannot exercise alt-screen at all, which is why the
F3 test broke.

**Thin impure driver.** Enter alt-screen, hide cursor, and on each repaint write cursor-home
(`\x1b[H`) followed by every row, then `\x1b[J`. Do not clear the screen before painting —
that causes flicker. Because every row is padded to `width`, no residue is possible.

**Input.** readline's own cursor management fights full-frame repaint, so own the line.
Implement a minimal editor over the existing raw-mode key handling: printable chars,
Backspace, Left/Right, Ctrl-A/E/U/K/W, Up/Down history, and Tab completion reusing the
existing `completionCandidates`. This is a real cost of the pivot — do not silently drop
Tab completion or history, they were built in v1.

## Non-negotiables

1. **Restore on every exit path.** One idempotent `restore()`: leave alt-screen, show
   cursor, disable raw mode, remove listeners. Wire it to normal return, thrown errors,
   SIGINT, SIGTERM, and the existing `uncaughtExceptionMonitor` backstop. A crash must
   never strand the terminal in the alt buffer with raw mode on. Test this by forcing a
   throw mid-session in a pty and asserting the primary buffer is restored.
2. **Non-TTY never enters alt-screen.** Fall back to the existing line-based path. The
   harness refusal for agent sessions stays.
3. **Degenerate sizes.** Sizeless (0x0) pty and very small terminals must render something
   sane, never crash or divide by zero. Below the minimum pane size, fall back to the
   single-line status bar.
4. **Carry forward the verified v2 behavior.** Unavailable actions stay visible and dimmed
   with the reason, never hidden. `NO_COLOR` / `TERM=dumb` / non-TTY gating exact.
   Responsive collapse. Options/preview shell quoting.
5. **Carry forward the v1 guarantees.** Poll cancellation on quit at the *production*
   interval (regression test stays at the production default). Release-before-cleanup:
   never clear the CLI session or kill the guardian after a failed release.

## Review findings still in scope

- **F1** real-service availability agreement tests — landed and green; keep them.
- **F2** `Unavailable: <reason>` wording — landed.
- **F3** slash commands typed from global help must still execute. The current patch is
  **red** (`tests/tui-app.test.ts > slash commands entered from global help still execute`
  times out). In the alt-screen model help is an overlay pane, not a mode: typing always
  edits the input line, Enter runs the command and closes the overlay. Re-do F3 in those
  terms and get the tree green.

## Definition of done

`npm test`, `npm run typecheck`, `npm run build` all clean, with the frame renderer covered
by pure unit tests and the restore path covered by a pty test. Reviewer re-runs everything
independently, re-runs both v1 proof tests, and dogfoods in a pty including a forced crash.
