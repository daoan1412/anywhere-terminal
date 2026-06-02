---
labels: [webview, clipboard, paste, event-handling, cli-integration]
source: preview-pasted-images
summary: When capturing clipboard content in the webview (for image preview), the paste listener must never call preventDefault/stopPropagation — the empty paste must still reach xterm so the CLI's out-of-band clipboard read works.
---
# Clipboard paste listener must be observe-only to not break CLI's paste handling
**Date**: 2026-06-02

## TL;DR
- WebView captures image from `ClipboardEvent.clipboardData.items` for preview
- Image bytes are stored locally (no PTY traversal)
- But the CLI also reads the clipboard out of band (macOS NSPasteboard, xclip, wl-paste, PowerShell)
- If the paste listener calls `preventDefault`/`stopPropagation`, xterm's native paste is blocked
- The empty paste never reaches xterm → the CLI's clipboard read gets nothing → no `[Image #N]` placeholder
- **Fix: never call preventDefault; listen in capture phase (true third arg) and let the event propagate**

## Context
All three CLIs (Claude Code, OpenCode, Codex) obtain the pasted image out of band from the OS clipboard, not through the terminal input stream. The placeholder `[Image #N]` is rendered when the CLI detects and reads the clipboard.

To preview the image, the webview must also capture it from the clipboard at paste time. However, if the webview's listener consumes the paste event, the xterm textarea's paste handler (and thus the CLI's paste trigger) never fires.

## Evidence
### Anchors
- `src/webview/main.ts` → document-level paste listener (L1080-1105)
  - `addEventListener('paste', ...., true)` — capture phase (true third arg)
  - Never calls `e.preventDefault()` or `e.stopPropagation()`
  - Just checks `e.clipboardData.items` for image, extracts blob, stores in `PastedImageStore`
  - **Returns without modifying the event**

### Design Rationale
From discovery §1 and design D1: image bytes never traverse the PTY. The only uniform interception point is the webview's paste event because the host app (Claude Code, etc.) is what triggered Cmd/Ctrl+V. But the CLI is ALSO listening to the same OS clipboard via native APIs.

If we consume the paste, the CLI never gets its trigger, and the placeholder never appears.

## When to apply
- Intercepting a browser event (paste, drag, key) from a native app
- The native app also listens for the same input (clipboard read, drop target, hotkey)
- Webview wants to capture/observe the input without interfering with the native app
- Symptom: native app's behavior stops working after adding the listener
- Fix: never prevent/stop-propagate; mark the listener as capture-phase if you need to read before bubbling handlers

## Prevention gate
- If a listener intercepts user input that flows to a parent app (CLI, editor, terminal), mark it observe-only
- Never call `preventDefault()` unless you are **completely replacing** the default behavior
- Test the critical path: paste image in the CLI → verify `[Image #N]` placeholder still appears
- For paste capture, use `addEventListener('paste', handler, true)` and just read `e.clipboardData` without modifying the event

