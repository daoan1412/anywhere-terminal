---
topic: xterm-click-cursor-conflicts
created-by: Research for Asimov change add-click-cursor-positioning; avoid breaking TUI and mouse-aware terminal apps.
date: 2026-05-09
libraries: [xterm.js, opencode, claude-code]
used-by: []
---

# Research: xterm-click-cursor-conflicts

## Answers
- **1. Public xterm.js detection points:** use `terminal.buffer.active.type` (`'normal' | 'alternate'`), `terminal.buffer.onBufferChange`, and `terminal.modes.mouseTrackingMode` (`'none' | 'x10' | 'vt200' | 'drag' | 'any'`). `terminal.onBinary` is the observable channel for binary mouse reports. Sources: xterm public API docs + typings (`@xterm/xterm`), and `SelectionService` internals. 
- **2. `altClickMovesCursor` behavior:** in `SelectionService._handleMouseUp`, xterm only moves the cursor when: selection length is `<= 1`, mouse-up happened within 500ms, `Alt` was held, `altClickMovesCursor` is enabled, and the buffer is **not** scrolled back (`ybase === ydisp`). It then converts screen coords to a cursor-move escape via `moveToCellSequence(..., applicationCursorKeys)` and injects it with `triggerDataEvent`. It does **not** check `mouseTrackingMode` directly. Source: `src/browser/services/SelectionService.ts` on GitHub.
- **3. CLI/TUI evidence:**
  - **OpenCode**: documented TUI mouse capture is on by default (`"mouse": true` in `tui.json`), can be disabled via `OPENCODE_DISABLE_MOUSE`, and TUI components use mouse events (`onMouseDown`, `onMouseUp`, `onMouseMove`) for dialogs/autocomplete/copy actions. Evidence is about mouse interaction, not explicit xterm mouse-tracking protocol use.
  - **Claude Code**: changelog entries mention mouse selection, mouse-scroll escape sequences leaking into the prompt, click-to-select behavior, and an alt-screen rendering bug/flicker mode (`CLAUDE_CODE_NO_FLICKER=1`). This strongly implies terminal mouse interaction and alt-screen usage, but exact protocol-level mouse tracking isn’t explicitly documented.
- **4. Conservative guard strategy:** only synthesize click-to-cursor in the **normal buffer** and when `mouseTrackingMode === 'none'`. Skip it when the terminal is in alternate screen, when any app mouse mode is active, when the viewport is scrolled back, or when a selection/drag/double-click is in progress. In those cases, preserve the terminal app’s own mouse handling and native selection/scroll behavior.
- **5. Spec/task updates:** add explicit acceptance criteria for “plain shell” vs “TUI/app-mouse-mode” behavior, and add negative tests for alternate screen + active mouse tracking (`x10/vt200/drag/any`). Also add a task to confirm the webview layer can observe `buffer.active.type` and `modes.mouseTrackingMode` before dispatching cursor jumps.

## Recommended Approach
- Treat click-to-cursor as a **plain-shell convenience**, not a universal mouse feature.
- Gate it with: `buffer.active.type === 'normal'`, `modes.mouseTrackingMode === 'none'`, no selection, no drag, and no scrollback.
- Add a user-facing escape hatch (config or toggle) so TUI-heavy workflows can disable the behavior entirely.

## Gotchas & Constraints
- xterm’s built-in `altClickMovesCursor` is selection-service logic, not a terminal protocol detector; it can’t reliably infer whether an embedded app wants mouse input.
- OpenCode/Claude evidence is mostly docs/changelog, so treat that as strong but not exhaustive proof of their current runtime behavior.
- If the click handler injects arrow-key sequences while a TUI is active, it can corrupt UI state or trigger accidental navigation/submit actions.

## Sources
- xterm public API: `typings/xterm.d.ts` (`buffer`, `modes`, `onBinary`, `altClickMovesCursor`) and `src/browser/services/SelectionService.ts` (`_handleMouseUp`, `moveToCellSequence`).
- DeepWiki: `xtermjs/xterm.js` pages for Public API / Mouse Input Handling.
- OpenCode DeepWiki: `sst/opencode` UI/TUI pages.
- Claude Code DeepWiki + changelog snippets on GitHub: `anthropics/claude-code/CHANGELOG.md`.

## Confidence
Medium — xterm behavior is confirmed from source; OpenCode and Claude Code evidence is strong but mostly from docs/changelog rather than direct protocol tracing.
