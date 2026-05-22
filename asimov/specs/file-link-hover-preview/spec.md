# file-link-hover-preview Specification
## Requirements

### Requirement: Hover trigger and debounce

The webview SHALL trigger a file-preview request only after the mouse remains within a file-path link's xterm range for a continuous **300 ms**. Movement off the link, scroll, focus loss, terminal `leave` callback, a hover crossing into a different link, or a `mousedown` / `wheel` event anywhere in the terminal MUST cancel any pending (timer-armed) request AND invalidate any in-flight `requestId` so the eventual response is discarded. Cancellation of an in-flight request need not abort the host-side work for that request — supersession by a newer request for the same `sessionId` is the host's cancellation trigger (see "Host cancellation on supersession").

### Requirement: Preview popup DOM contract

The popup SHALL be attached as a direct child of `terminal.element` and MUST carry the CSS class `xterm-hover` (xterm.js's documented marker that causes its mouse events not to fall through to other links). The popup MUST be removed from the DOM when dismissed and MUST NOT remain hidden in-place.

### Requirement: Preview popup positioning

The popup's anchor point SHALL be computed by subtracting `terminal.element.getBoundingClientRect().{left,top}` from the hover `MouseEvent.clientX/clientY`, yielding coordinates local to `terminal.element`'s padding box. The popup's top-left corner SHALL be placed 12 px below and 0 px right of this anchor. If the popup's right edge would exceed `terminal.element.clientWidth`, the popup MUST be shifted left until it fits (clamped at left=0); if its bottom edge would still exceed `terminal.element.clientHeight` after that shift, the popup MUST flip to appear 12 px ABOVE the anchor. Maximum popup dimensions MUST be `min(560 px, terminal.element.clientWidth - 16 px)` wide × `min(360 px, terminal.element.clientHeight - 16 px)` tall; content overflowing those bounds MUST scroll inside the popup. The popup MUST set CSS `z-index: 1000` (above the existing drag-drop-tip and insert-path-flash overlays at z-index 50, and above xterm's own decoration layers at z-index ≤ 8). The popup MUST be a direct child of `terminal.element` (the `.xterm` root), NOT of `terminal.element.querySelector('.xterm-screen')`.

### Requirement: IPC contract — requestFilePreview / filePreviewResult

The webview SHALL send `{ type: "requestFilePreview"; requestId: string; sessionId: string; path: string; line?: number; col?: number }` over `WebViewToExtensionMessage`. The host SHALL reply with `{ type: "filePreviewResult"; requestId: string; status: "ok" | "not-found" | "binary" | "too-large" | "ambiguous" | "error"; content?: string; languageId?: string; isMarkdown?: boolean; truncated?: boolean; totalBytes?: number; totalLines?: number; absPath?: string }` over `ExtensionToWebViewMessage`. `requestId` MUST be unique per request (UUID v4 or `crypto.randomUUID()`) and MUST be echoed exactly in the reply.

### Requirement: First-hit path resolution for hover

On `requestFilePreview` the host SHALL resolve `path` using the same candidate chain as `openFile` (live PID cwd → OSC cwd → initial cwd → workspace folders → `findFiles`) but MUST stop at the **first** candidate that exists as a file. Hover resolution MUST NOT show a quickPick on `findFiles` ambiguity (≥2 matches → reply `status: "ambiguous"`), MUST NOT show a "File not found" toast (zero matches → reply `status: "not-found"`), and MUST NOT show the out-of-workspace modal confirm. Directories MUST NOT be treated as preview targets — they fall through to `status: "not-found"`.

### Requirement: File size guard and read limits

Before reading content, the host MUST `vscode.workspace.fs.stat(uri)` the resolved URI and capture `size` as `totalBytes`. The behavior then splits:

- If `size > 1 000 000` bytes (the **hard limit**), the host MUST reply `status: "too-large"` and MUST NOT read the file's bytes. `content` MUST be omitted.
- If `size ≤ 1 000 000`, the host SHALL read the file via `vscode.workspace.fs.readFile(uri)`, then slice to the first **200 000** bytes (the **preview limit**). If the original `size > 200 000`, the host MUST set `truncated: true`.
- After byte slicing, the host MUST decode UTF-8 with replacement chars (`new TextDecoder("utf-8", { fatal: false })`) and split on `\r?\n`. The host SHALL emit at most **500 lines** in `content`; lines beyond the 500th MUST be dropped and `truncated: true` MUST be set.

`totalBytes` MUST always reflect the file's `stat` size, not the bytes returned.

### Requirement: Binary file detection

The host SHALL treat a file as binary when its first 8 192 bytes contain at least one NUL byte (`0x00`). Binary files MUST reply with `status: "binary"`, omit `content`, and include `totalBytes`.

### Requirement: Popup rendering — code files

For non-markdown files with `status: "ok"`, the popup SHALL render `content` with Shiki using a theme matching VSCode's current `colorTheme.kind` (`Light` → `github-light`; `HighContrastLight` → `light-plus`; `Dark` → `github-dark`; `HighContrast` → `dark-plus`). Unknown languages (`languageId === "plaintext"` or grammar not in the bundled set) MUST render as `<pre>`-escaped plain text. The Shiki bundle MUST be statically composed at build time from the curated language list defined in `design.md` D1 (no runtime dynamic imports of grammars, themes, or oniguruma resources — these are incompatible with the webview's IIFE bundle + nonce-CSP).

### Requirement: Popup rendering — markdown files

For files where `isMarkdown` is `true` and `status: "ok"`, the popup SHALL render `content` with `markdown-it` (initialised with `{ html: false, linkify: false }`; `md.validateLink = () => false`). Fenced code blocks MUST be highlighted via markdown-it's `highlight(code, lang) => html` option which calls the shared Shiki renderer with the current theme (per `design.md` D12). `@shikijs/markdown-it` MUST NOT be used (its CSS-variable multi-theme output is incompatible with the four-way theme model in `design.md` D8). Links inside the rendered markdown MUST be rendered as inert text (no `href`, no `onclick`).

### Requirement: Popup header (path disclosure)

Every popup, regardless of `status`, MUST display a header row showing the resolved `absPath` when present, otherwise the original `path` from the request. The header MUST be visually distinct from the content area (a muted-color, single-line, ellipsis-truncated string).

### Requirement: Popup states for non-ok results

The popup SHALL render distinct placeholders (not the empty state) for each non-ok status: `not-found` → "File not found", `binary` → "Binary file (<formatted bytes>)", `too-large` → "File too large (<formatted bytes>)", `ambiguous` → "Multiple matches — click to choose", `error` → "Could not load preview". Each placeholder MUST display the original `path` text in addition to the header (see "Popup header").

### Requirement: Out-of-workspace files

The host SHALL preview files outside any workspace folder silently — no modal, no toast. The popup's header (see "Popup header") MUST display `absPath` for ALL results so the user always sees which file is being previewed regardless of workspace boundary. The existing out-of-workspace modal confirm for `openFile` (click) MUST remain unchanged.

### Requirement: Webview-side stale-response invalidation

The webview MUST track an `activeRequestId` per `HoverPreviewController` instance (one per terminal). When a `filePreviewResult` arrives whose `requestId` does not match the `activeRequestId`, the result MUST be discarded without DOM update. `activeRequestId` MUST be reset to `null` on dismiss, leave, mousedown/wheel anywhere in the terminal, or controller dispose.

### Requirement: Host cancellation on supersession

The host MUST maintain at most ONE in-flight `requestFilePreview` per `sessionId`. When a new `requestFilePreview` arrives for a `sessionId` that already has an in-flight request, the host MUST cancel the prior request's `vscode.CancellationTokenSource` and dispose it BEFORE starting the new request. `previewFileLink` and `readFileForPreview` MUST check `token.isCancellationRequested` between awaits. The host MUST NOT post a result for a cancelled request. On `sessionId` close / terminal disposal, the host MUST cancel and dispose any in-flight token for that session and remove the map entry.

### Requirement: Theme synchronization

The webview SHALL receive `{ type: "themeChanged"; kind: "light" | "dark" }` whenever `vscode.window.onDidChangeActiveColorTheme` fires, and any popup currently displayed MUST be re-rendered with the new theme on the next hover (already-rendered popups MAY remain in the prior theme until dismissed).

### Requirement: Performance caps for hover

The webview MUST NOT keep more than one popup attached to the DOM at any time. The webview MUST NOT issue a new `requestFilePreview` while one is in flight for the same link unless 300 ms have elapsed and the hover has moved off and back onto the link.

### Requirement: Lifecycle / disposal

When `HoverPreviewController.dispose()` is invoked (called by `FilePathLinkProvider.dispose()` and on terminal disposal), the controller MUST: (1) clear any pending debounce timer; (2) invalidate `activeRequestId` (set to `null`); (3) unmount any visible popup from the DOM; (4) detach `mousedown` / `wheel` / `blur` listeners it installed on `terminal.element` / `window`. After `dispose()` the controller MUST be inert — any later `filePreviewResult` arrival for a previously-issued `requestId` MUST be dropped silently.

### Requirement: Accessibility / inertness

The popup root element MUST carry `role="tooltip"` and MUST NOT trap or steal keyboard focus. The popup MUST NOT contain any focusable controls (no buttons, links with `href`, or `tabindex`). Pressing `Escape` while the popup is visible MUST dismiss it. The popup MUST NOT consume `wheel` or `mousedown` events for the purpose of scrolling the popup's own content unless the user is actively over the popup; clicks outside the popup MUST dismiss it.

