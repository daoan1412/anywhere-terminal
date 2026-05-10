---
labels: [xterm, webview, terminal, bugfix, link-hover]
source: add-click-cursor-positioning
summary: The link-hover guard must inspect both the wrapper and nested xterm DOM descendants for .xterm-cursor-pointer; checking only the container misses the production DOM shape and can leak cursor-move input onto terminal links.
---
# Nested xterm descendants must be checked for link-hover before moving the cursor
**Date**: 2026-05-10

## TL;DR
- xterm may apply `.xterm-cursor-pointer` on a nested terminal element, not the outer wrapper.
- Link-click guards should check both the wrapper and descendants before synthesizing cursor movement.
- Add a test that mirrors the real nested DOM shape.

## Context
A prior review found that the handler only looked at the wrapper container. That was enough for the unit test, but not for xterm’s production DOM structure.

## Root cause
- **Symptom:** clicking a terminal link could still move the shell cursor.
- **Immediate cause:** the guard inspected only `deps.container.classList`.
- **Deeper cause:** xterm applies the hover/pointer class to an internal descendant element in the live DOM.

## Fix
- Check the wrapper and nested descendants for `.xterm-cursor-pointer`.
- Cover the real DOM shape in tests.

## Prevention gate
- When skipping xterm link clicks, validate against the rendered xterm subtree, not just the wrapper passed to the handler.

## Evidence
### Anchors
- `src/webview/ClickCursorHandler.ts` → `isLinkClick()` — checks the wrapper and nested descendants for `.xterm-cursor-pointer`.
- `src/webview/ClickCursorHandler.test.ts` — includes `does not send input when a nested xterm element is hovering a link`.
- `src/webview/terminal/TerminalFactory.ts` → `createClickCursorHandler(...)` — passes the wrapper container after `terminal.open(container)`, so the guard must match the actual nested xterm DOM.

## When to apply
- Any xterm webview click guard that depends on hover/link state.
- Any DOM-based terminal interaction that may be applied to wrapper + child elements.
