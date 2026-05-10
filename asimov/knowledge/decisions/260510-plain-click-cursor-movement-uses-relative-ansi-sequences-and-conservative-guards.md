---
labels: [xterm, webview, terminal, cursor, decision]
source: add-click-cursor-positioning
summary: Plain click-to-cursor should reuse the existing terminal input path, emit relative left/right ANSI movement, and only run in the live normal buffer with no selection, scrollback, or mouse tracking.
---
# Plain-click cursor movement uses relative ANSI sequences and conservative guards
**Date**: 2026-05-10

## TL;DR
- Reuse the existing `terminal.input()` / `onData` path; do not add a new IPC contract.
- Use relative horizontal ANSI movement from the current cursor to the clicked cell.
- Gate the behavior to live normal-buffer shell prompts and conservative click conditions.

## Context
Plain click-to-cursor is meant as a shell prompt convenience, not arbitrary cursor teleportation inside TUIs or alternate-screen apps. The approved implementation keeps the webview-side behavior small and relies on xterm’s existing raw input plumbing.

## Decision
- Keep click-to-cursor on the existing raw input path.
- Generate relative right/left escape sequences instead of absolute CUP positioning.
- Skip when the terminal is scrolled back, has a selection, is in alternate buffer, or has active mouse tracking.

## Trade-offs
- Safer for readline-style prompts and existing shell state.
- Intentionally does not support fullscreen or mouse-aware terminal apps.

## Evidence
### Anchors
- `src/webview/terminal/TerminalFactory.ts` → `createClickCursorHandler({ container, terminal, sendInput })` — wires click-to-cursor through the existing `terminal.input()` path after `terminal.open(container)`.
- `src/webview/ClickCursorHandler.ts` → `createCursorMoveSequence()` — emits relative `\\x1b[C` / `\\x1b[D` sequences.
- `src/webview/ClickCursorHandler.ts` → `canMoveCursorFromClick()` — gates on normal buffer, live viewport, no selection, and `mouseTrackingMode === "none"`.
- `src/webview/ClickCursorHandler.test.ts` — covers clicks, drag/modifier guards, selection, scrollback, alternate buffer, and mouse-tracking modes.

## When to apply
- Adding plain-click cursor movement to xterm-based webviews.
- Any feature that should preserve shell input semantics instead of sending new terminal commands.
