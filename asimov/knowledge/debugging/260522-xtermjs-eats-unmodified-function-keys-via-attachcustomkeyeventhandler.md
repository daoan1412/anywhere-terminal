---
labels: [xtermjs, keybindings, function-keys, webview]
source: add-tab-rename
summary: xterm's attachCustomKeyEventHandler intercepts unmodified F1-F12 and sends escape sequences to PTY, blocking VS Code keybindings. Modifier-keyed bindings (Ctrl+\) work because VS Code matches them first.
---
# xterm.js eats unmodified function keys via attachCustomKeyEventHandler
**Date**: 2026-05-22

## TL;DR
- xterm.js's `attachCustomKeyEventHandler` treats unmodified function keys (F1-F12, etc.) as terminal input, sends \`\x1bOQ\` (escape sequence) to PTY, calls `preventDefault()`
- This blocks VS Code's keybinding layer from ever seeing the key
- Modifier-keyed bindings (Ctrl+\, Cmd+K) work because VS Code matches modifiers first, before xterm handler runs
- Impact: new unmodified-key keybindings for extension features cannot use F1-F12 without special xterm passthrough

## Context
The add-tab-rename feature initially planned an F2 default keybinding (typical 'rename' across UI frameworks). During build, F2 failed to trigger the command in some webview contexts because xterm was eating it.

## Evidence
### Anchors
- `src/webview/InputHandler.ts` → `createKeyEventHandler()` (lines 46-126) — custom key event handler attached to xterm terminal
- xterm.js source: `attachCustomKeyEventHandler` hook in `@xterm/xterm@5.x`

### Why it happens
xterm processes the keydown BEFORE the browser's native capture/bubble handlers. The handler at line 76 checks `const modifier = isMac ? event.metaKey : event.ctrlKey`. If no modifier is set, line 77 returns `true` (meaning 'let xterm process this'). xterm then translates F2 to \`\x1bOQ\` and sends it to the PTY, calling `preventDefault()` to block further handlers.

Modifier keys are checked by VS Code's keybinding layer first (before the custom handler runs), so Ctrl+\\ matches before xterm's handler is invoked.

## When to apply
- Any new unmodified-function-key (F1-F12) keybinding planned for the extension
- If users report 'my F[n] keybinding isn't working in the AT view' — suspect xterm eating it
- Check: does the binding work if you add a modifier (Ctrl+F2, Cmd+F2)? If yes, it's this issue

## Prevention gate
- For new keybindings, avoid bare F1-F12 in AT webviews; prefer Ctrl+[key] or Cmd+[key]
- If a bare function key is critical, add an explicit passthrough branch in `createKeyEventHandler` (`if (event.key === 'F2') return false;`) AND test across macOS/Linux/Windows
- Document the limitation: 'no default F-key bindings; users can add via VS Code's Keyboard Shortcuts UI if desired'

