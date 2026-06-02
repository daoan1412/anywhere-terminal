# Discovery: preview-pasted-images

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Memory Recall | Done | `asm memory search` |
| Architecture Snapshot | Done | finder subagent |
| Internal Patterns | Done | finder subagent (hover-preview infra) |
| External Research | Done | general-purpose agent over `/Users/huybuidac/Projects/ai-oss` OSS source |
| Constraint Check | Done | direct read (webviewHtml.ts CSP) |

## Key Findings

### 1. Image bytes never traverse the PTY stream

All three target CLIs obtain the pasted image **out of band** by reading the OS clipboard (or a dropped file path) — never through the terminal's input stream:

- **Claude Code**: empty bracketed-paste (macOS Cmd+V) or Ctrl+V *triggers* a native NSPasteboard read (fallback `osascript`/`xclip`/`wl-paste`/PowerShell). Placeholder `[Image #N]`, session-monotonic counter (shared with text pastes), also cached to `~/.claude/image-cache/<session>/<N>.<ext>`.
- **OpenCode (TUI)**: bracketed-paste; empty paste → OS clipboard read. Placeholder `[Image N]` (space, **no `#`**), per-prompt counter `(#images)+1`, in-memory `data:` URL only.
- **Codex CLI**: Ctrl+V keypress → `arboard` clipboard read. Placeholder `[Image #N]`, per-prompt contiguous (renumbers on delete), temp PNG on disk.

**Consequence:** A host terminal cannot sniff the bytes from terminal output. The only thing on the wire is the rendered placeholder text. The host **is** the app delivering the Cmd+V/Ctrl+V, so the only uniform interception point is the **OS clipboard at paste time**, captured from the webview's own DOM `paste` event.

### 2. Webview paste handling is text-only today

`InputHandler.ts` (`createKeyEventHandler`) returns `false` for Cmd/Ctrl+V (L97-103), letting the browser's native paste fire on xterm's textarea → `onData` → `{type:"input"}` to the PTY. An image clipboard item produces no text in a textarea, so the empty paste flows through and the CLI does its own clipboard read — which is exactly why `[Image #N]` already appears. No image data is captured anywhere in the webview. `ClipboardProvider` is `readText`/`writeText` only.

### 3. A complete, reusable hover-preview stack already exists

- `HoverPreviewController.ts` — per-terminal hover state machine: 300 ms debounce, leave-grace (150 ms), scroll/mousedown/Escape/blur dismissal, window-listener lifecycle, idempotent `dispose()`. Currently file-specific (posts `requestFilePreview` over IPC, has trust-policy override state).
- `HoverPreviewPopup.ts` — `document.body` `position: fixed` overlay (z-index 1001), viewport-clamped positioning (`computePosition`/`computeBounds`), drag-to-move + SE-resize via pointer capture, `show(anchor, FilePreviewResultMessage, theme)`, idempotent `dispose()`.
- `FilePathLinkProvider.ts` / `SubagentLinkProvider.ts` — dual `ILinkProvider` pattern; both registered per terminal; `SubagentLinkProvider` is the clean single-row matcher template (no wrap walk) to mirror.
- Wiring in `TerminalFactory.createTerminal` (controller+popup+providers per terminal; `hoverControllers` map L83/346); disposal in `main.ts` `removeTerminal` (L413 tab, L426 split panes) and split-close (L542/L550) → `factory.disposeHoverController` (`TerminalFactory.ts` L606-614).

### 4. CSP blocks images today (hard constraint)

`webviewHtml.ts` L75-79: `default-src 'none'` with `style-src`/`script-src`/`font-src` only — **no `img-src`**. Object-URL (`blob:`) or `data:` images will be blocked until `img-src` is added. `webviewHtml.test.ts` already asserts CSP content.

### 5. Per-session state has a home

`TerminalInstance` (`WebviewStateStore.ts` L19-41) holds the terminal + addons; `TerminalFactory` owns parallel per-session maps (`hoverControllers`). A per-terminal pasted-image cache fits the same pattern and must be disposed on the same teardown paths (cf. body-overlay-disposal memory: dispose on split + tab close, not just root close).

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Image capture | text-only paste path | grab `image/*` from `ClipboardEvent.clipboardData.items` at paste time | new document-level `paste` capture listener (observe-only, no `preventDefault`) |
| Per-session cache | `hoverControllers` map pattern | `PastedImageStore` (object URLs, paste-order index, revoke-on-dispose) | new module + factory map + disposal wiring |
| Placeholder detection | file + subagent providers | match `[Image #?N]` | new `ImagePlaceholderLinkProvider` + pure parser |
| Preview render | file preview via IPC round-trip | render cached blob locally as `<img>` | popup `showImage` + controller `attachImageHover` (no IPC) |
| Correlation | n/a | map placeholder N → cached image | decision needed (numbering differs/resets per tool) |
| CSP | no `img-src` | allow `blob:` | add `img-src ${webview.cspSource} blob: data:` |

## Options

### Option A — Read the CLI's on-disk image cache by placeholder number
Hover `[Image #N]` → extension host reads `~/.claude/image-cache/<session>/<N>.ext` (Claude) / temp PNG (Codex). Drift-free for Claude. **Rejected:** Claude-only filename=N correlation; requires discovering the CLI's session id, cross-boundary fs access + new IPC; nothing on disk for OpenCode; high complexity for partial coverage.

### Option B — Capture clipboard image in the webview at paste time, render locally (Recommended)
Document-level `paste` listener captures the `image/*` blob into the active terminal's `PastedImageStore` (object URL, paste-order index). A third link provider detects the placeholder; hover resolves the cached blob and renders it in the reused hover popup — entirely webview-side, no IPC. Uniform across all three CLIs; reuses the existing hover stack. Trade-off: placeholder-number correlation is approximate when numbering resets/diverges (mitigated by recency fallback — D3).

## Risks

1. **CSP omits `img-src`** — images silently fail to render. Mitigation: add `img-src ... blob: data:` + assert in `webviewHtml.test.ts` (design D6).
2. **Object-URL leak** — unrevoked URLs grow memory across terminals. Mitigation: `PastedImageStore.dispose()` revokes all URLs, called on every teardown path incl. split-pane close (design D2; body-overlay-disposal memory).
3. **Correlation drift** — Claude shares its counter with text pastes; OpenCode/Codex reset per prompt. Mitigation: recency-first fallback rule (design D3); documented limitation; dominant single-image-then-hover case is exact.
4. **Capture breaks the CLI's own clipboard read** — if the listener consumes the paste. Mitigation: observe-only, never `preventDefault` (design D1).
5. **Regressing the hardened file-preview hover** — controller/popup carry security gating + heavy tests. Mitigation: extract shared scaffolds without changing the file path's behavior; re-run existing `HoverPreviewController`/`HoverPreviewPopup` suites (design D4).
