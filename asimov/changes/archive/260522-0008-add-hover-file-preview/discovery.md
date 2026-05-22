# Discovery: add-hover-file-preview

## Workstreams

| Workstream            | Status | Method                                                                  |
| --------------------- | ------ | ----------------------------------------------------------------------- |
| Architecture Snapshot | Done   | finder subagent (existing file-link plumbing, CSP, IPC)                 |
| Internal Patterns     | Done   | finder subagent (resolution chain, tests, terminal mount point)         |
| External Research     | Done   | librarian subagent (VSCode source + Shiki/Monaco/highlight.js)          |
| Constraint Check      | Done   | direct read of `package.json`, xterm.js `ILink` typings, webview CSP    |

## Key Findings

### 1. xterm.js already exposes a hover/leave callback on every link

`@xterm/xterm` `ILink` defines optional `hover(event, text)` and `leave(event, text)` methods alongside `activate` (see `node_modules/@xterm/xterm/typings/xterm.d.ts`). The docs say: to render a DOM tooltip, attach a child of `Terminal.element` with class `xterm-hover` so its mouse events don't fall through. The existing `FilePathLinkProvider.provideLinks` (`src/webview/links/FilePathLinkProvider.ts:40-92`) returns `ILink` objects but only sets `activate` — `hover` / `leave` are open extension points.

### 2. The webview ↔ host IPC is ready to extend

`WebViewToExtensionMessage` / `ExtensionToWebViewMessage` unions live in `src/types/messages.ts:111-141, 284-300`. Adding a new request/response pair (`requestFilePreview` → `filePreviewResult`) follows the same shape as the existing `openFile` flow. The host-side dispatch in `TerminalViewProvider.ts:261-281` already routes `openFile` to a free function `openFileLink(...)`; we'd add a sibling route to a `previewFileLink(...)` function.

### 3. The file-path resolution chain is reusable as-is

`buildCandidates` (`src/providers/openFileLink.ts:210-255`) plus the multi-source cwd resolution (live PID cwd → OSC cwd → initial cwd → workspace folders → `findFiles`) returns a list of candidate URIs with their source attribution. For hover preview we want the **first** unambiguous hit; ambiguity (`findFiles` returns ≥2 matches) should fall through to "no preview" rather than show a quickPick (passive UX). This extraction is a small refactor: expose a `resolveFirstFile(path, sessionId, deps): Promise<vscode.Uri | null>` that calls the same candidate generators but stops at the first existing file and never opens a quickPick.

### 4. Webview composition root supports a sibling overlay

The webview HTML (`src/providers/webviewHtml.ts:30-308`) mounts `#terminal-container` as a flex child. The terminal itself lives inside `terminal.element` (xterm's host DOM). Per xterm docs we attach the popup as a child of `terminal.element` with class `xterm-hover` so xterm intercepts mouse events correctly. CSP is `default-src 'none'` with a script nonce; all popup CSS must use the same `cspSource` + `'unsafe-inline'` style channel already used by xterm.

### 5. There is NO public VSCode API that renders an arbitrary file like the editor does

The librarian confirmed:

- `HoverProvider` (`MarkdownString`) only fires inside a real `TextEditor`. Hovers inside webview DOM never trigger it.
- `createWebviewPanel` opens in a viewColumn — there's no anchored "floating" mode.
- Peek widgets are internal (`PeekViewWidget` / `ContentHoverController`) with no extension surface.
- Markdown rendering is done by `markdownDocumentRenderer.ts` — workbench-internal.
- The only public "use the real renderer" option is `showTextDocument(uri, { preview: true, preserveFocus: true })`, which opens an actual editor tab. That's a tab, not a hover popup.

**Conclusion**: to get VSCode-quality rendering inside the webview popup, we have to embed our own renderer. We cannot reuse VSCode's renderer for a true hover popup.

### 6. Shiki is the highest-fidelity renderer available

Shiki uses the same TextMate grammars + themes that VSCode itself uses. Full bundle is ~6.4 MB minified / 1.2 MB gzip, but its docs explicitly recommend fine-grained bundles (only the langs/themes you need) plus the JavaScript regex engine (lighter than Oniguruma WASM). Has `@shikijs/markdown-it` for markdown files with highlighted code fences. Monaco gives the same fidelity but is a full editor (~3 MB+) — overkill for a read-only popup. `highlight.js` / Prism are smaller but visibly not VSCode-quality.

### 7. VSCode editor hover timing as the model

`HoverOperation` (`src/vs/editor/contrib/hover/browser/hoverOperation.ts:54-62`) uses ~300 ms default delay, cancels on mouseleave/move/scroll. That's the timing target for our popup.

## Gap Analysis

| Component               | Have                                                | Need                                                                                       | Gap                                                  |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| xterm link `hover`/`leave` plumbing | typings + click `activate`                | wire `hover` callback → debounce → preview popup                                          | Hover handler + debounce + cancellation              |
| Path resolution (webview-triggered) | full chain inc. quickPick                | first-hit-only variant, no quickPick, no toast                                            | `resolveFirstFile(...)` helper                       |
| File read for preview               | none                                       | read file (cap bytes/lines), detect binary, return content + lang hint                    | New host-side `readFileForPreview(uri, limits)`      |
| IPC                                 | `openFile` request only                  | `requestFilePreview` request + `filePreviewResult` response (correlated by `requestId`)   | New message types + dispatcher branch                |
| Popup DOM/CSS                       | none                                       | floating panel sibling under `terminal.element`, with `xterm-hover` class, CSS theming    | New `HoverPreviewPopup` webview component            |
| Syntax / markdown render            | none                                       | Shiki (fine-grained bundle) + `@shikijs/markdown-it` for `.md`                            | New dependency + asset wiring under CSP              |
| Theme matching                      | xterm reads VSCode theme via existing path | preview popup needs same light/dark theme; Shiki theme picker mirroring `colorTheme.kind` | Theme bridge for popup                               |
| Cancellation / cache                | none                                       | per-link request token, cache by `path+mtime` keyed in webview, evict on session close   | New cache + cancellation token in webview            |
| Tests                               | parser + provider + resolver tests         | hover-handler unit, IPC contract unit, popup-render smoke                                | New test files                                       |

## Options

### Option A — `showTextDocument({ preview: true })` on hover (open preview tab)

On hover, host calls `vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true })`. Uses VSCode's actual editor → perfect rendering, markdown, image preview, language services — for free.

**Trade-off**: it opens a real editor tab. The first hover replaces the previously-hovered preview, but every hover still creates editor lifecycle churn (gutter, minimap, language activation). Not a "popup" — fails the user intent of a hover *dialog*. Visually disruptive when the user scrolls past many file paths.

### Option B — Shiki-powered overlay popup inside the webview *(Recommended)*

Hover triggers `requestFilePreview(path, sessionId, requestId)` → host resolves URI (reuses first-hit resolver) + reads file (capped) + returns `{ content, lang, truncated, lines }`. Webview renders the popup with Shiki (fine-grained bundle covering top ~15 languages) + `@shikijs/markdown-it` for `.md`. Popup is a `xterm-hover` DOM sibling, positioned near the cursor with viewport clamping, theme-matched to VSCode's current theme. Debounce 300 ms, cancel on `leave` / scroll / blur.

**Trade-off**: real engineering — bundle size, asset pipeline under CSP, hover state machine. But it directly delivers "dialog preview" with VSCode-quality formatting (same grammars + themes). Best fidelity:effort ratio.

### Option C — Monaco editor in the popup

Embed Monaco read-only in the popup. Highest fidelity (full tokenizer + bracket coloring + minimap if we want it). **Trade-off**: ~3 MB+ added to the webview, complex CSP wiring, slow init per popup. Overkill for read-only previews.

### Option D — Hybrid: lightweight metadata popup on hover, `showTextDocument` on click

Hover shows first 5–10 lines as plain pre-formatted text (no syntax color). Existing click still opens the file. **Trade-off**: cheap to ship, but the user explicitly asked for "format đẹp đẽ" (nice formatting) — this misses that goal.

### Option E — `highlight.js` popup instead of Shiki

Smaller bundle (~30 KB core + per-language), simple API, but themes / scopes are clearly inferior to VSCode's TextMate-based rendering. **Trade-off**: ships faster but the user's stated goal is *VSCode-quality* formatting.

## Risks

1. **Webview bundle bloat** — even fine-grained Shiki + 15 grammars + 2 themes is several hundred KB. *Mitigation*: lazy-load grammars on first hover via dynamic import; ship only common languages in the base bundle; cap popup file size to 500 lines / 200 KB.

2. **Hover race conditions** — fast cursor movement can interleave requests. *Mitigation*: in-webview request token; ignore late responses where `requestId !== currentHoverId`; abort host-side read with cancellation when a new request arrives for the same link cell.

3. **CSP violations** — Shiki dynamic-imports grammar JSON; webview CSP forbids `unsafe-eval` and `script-src` other than nonce. *Mitigation*: pre-bundle all chosen grammars/themes into the webview bundle (no dynamic external fetch); use `asWebviewUri` for any extra assets. Validate with a CSP audit task.

4. **Path-resolution ambiguity** — `findFiles` returning ≥2 matches currently triggers a quickPick. *Mitigation*: hover variant uses `resolveFirstFile` that does NOT run the quickPick fallback; on ambiguity it returns null and the popup silently does not appear (user can still click → existing quickPick UX).

5. **Binary / large / non-text files** — reading a 50 MB binary on hover would freeze the host. *Mitigation*: host-side hard cap (200 KB read), reject files whose first 8 KB contain non-text bytes (`\x00` heuristic). Popup shows "Binary file (N bytes)" placeholder.

6. **Theme drift** — VSCode theme can change at runtime. *Mitigation*: subscribe to `vscode.window.onDidChangeActiveColorTheme` already wired for the terminal; broadcast a `themeChanged` message; webview swaps Shiki theme.

7. **Out-of-workspace preview = passive disclosure** — current OPEN flow has a modal confirm for paths outside the workspace. *Mitigation*: deliberately decide whether hover preview also requires confirmation. Recommendation: NO — hover is non-committal and the file is one the user's own terminal output references. State this in proposal so reviewers can challenge.

## Open Questions (for GATE 1)

- **Direction**: confirm Option B (Shiki overlay).
- **Out-of-workspace policy**: silently preview, or skip preview unless user opts in via a setting?
- **Markdown render**: should `.md` files render as rendered markdown (Option B-rich) or stay as syntax-highlighted source (Option B-source)? Rendered is more impressive but adds `markdown-it` dependency.
- **Languages in the base bundle**: TS/JS/JSON/MD/YAML/Python/Go/Rust/Java/CSS/HTML/Shell/SQL/C/C++ — confirm or adjust?
