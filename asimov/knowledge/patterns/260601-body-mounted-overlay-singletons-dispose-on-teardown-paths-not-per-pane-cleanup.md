---
labels: [webview, disposal, lifecycle, singleton, overlay, terminal]
source: preview-subagent-popup
summary: Body-mounted fixed overlays (click popups, tooltips) must dispose on EVERY terminal teardown path: split close, tab close, and panel teardown — not just explicit close
---
# Body-mounted overlay singletons: dispose on teardown paths, not per-pane cleanup
**Date**: 2026-06-01

## TL;DR
- Body-mounted fixed overlays (click popups, tooltips) must dispose on EVERY terminal teardown path: split close, tab close, and panel teardown — not just explicit close
- Singleton popups (one instance across all terminals) must NOT be disposed inside per-terminal `disposeHoverController(id)` — that kills the popup when ANY sibling pane closes while the popup is still showing from another pane

## Context
The subagent preview popup is a factory singleton — one instance reused across all terminal panes. When a pane closes, the host calls `disposeHoverController(id)` (per-pane cleanup). However, if the popup is currently showing from pane A and pane B closes, calling `factory.disposeSubagentPopup()` inside the per-pane cleanup path would kill the A-pane popup, which is undesired.

Instead, the popup is disposed on:
1. **Open-replace** — when a new click opens a popup, the prior one is disposed
2. **Every terminal teardown path** — `removeTerminal`, `removeTab`, split-pane close — but NOT inside `disposeHoverController`

The consequence is acceptable: closing pane B while the popup from pane A is open will dismiss the pane-A popup (because `removeTerminal` calls `factory.disposeSubagentPopup()`). This is a harmless degradation of the "single popup" metaphor — the user can reopen it.

## Evidence
### Anchors
- `src/webview/terminal/TerminalFactory.ts` — owns the singleton `SubagentPreviewPopup` instance (field)
- `src/webview/main.ts` lines 370, 409, 544, 552 — `factory.disposeSubagentPopup()` called on:
  - Line 370: `switchTab` (keyboard tab switch)
  - Line 409: `removeTerminal(tabId)` 
  - Line 544, 552: split-pane close (`splitRenderer.removeTab`)
- `src/webview/terminal/TerminalFactory.ts` — `disposeSubagentPopup()` is idempotent
- Design.md D7 & oracle #7: "does NOT dispose inside per-session `disposeHoverController` path"

### Root cause
`disposeHoverController(id)` is called for every terminal (pane) close. If the singleton popup's `dispose()` were wired there, it would fire N times on a multi-pane close, and an in-progress popup from pane A would be torn down when pane B closes.

## Pattern
1. **Signal**: a singleton UI element (one per app, not per-pane) needs cleanup
2. **Anti-pattern**: calling `dispose()` inside per-pane cleanup handlers (can over-dispose)
3. **Detection**: a factory-singleton disposal path that also cleans up per-pane state
4. **Fix**:
   - Dispose singleton on every explicit teardown path (app close, pane close, etc.)
   - BUT NOT inside shared per-pane cleanup (e.g., `disposeHoverController`)
   - Protect `dispose()` with an idempotency check
5. **Test**: close pane A while a popup is open from pane B; verify the popup is not orphaned (it is dismissed, which is acceptable); close all panes; verify no `document.body` children remain

## When to apply
- Body-mounted overlays that are singletons (one instance shared across multiple terminals/views)
- Floating windows, tooltips, context menus that can be triggered from any pane but only one can be open at a time
- Distinguish between per-pane state (hover controllers) and singleton state (popup) — clean up only what you own

## Prevention gate
- Ownership model: document which component owns which UI element (e.g., "factory owns the popup; panes own their hover controllers")
- Teardown audit: grep for all `dispose()` calls and verify they match ownership (no per-pane handler disposes a singleton)
- Test: close panes in various orders and confirm the singleton is cleaned up exactly once per change, not per-pane-that-happened-to-close
