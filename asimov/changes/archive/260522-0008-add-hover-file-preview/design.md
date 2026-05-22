# Design: add-hover-file-preview

## Architecture

```
┌──────────────────────── webview ────────────────────────┐    ┌───────────── extension host ─────────────┐
│                                                         │    │                                          │
│  FilePathLinkProvider.provideLinks(...)                 │    │  TerminalViewProvider                    │
│       │                                                 │    │       │                                  │
│       └─ for each ILink: attach hover(event,text)       │    │       └─ onDidReceiveMessage             │
│                  │                                      │    │                │                         │
│                  ▼                                      │    │                ▼                         │
│      HoverPreviewController (per-terminal)              │    │   case "openFile"          ─► openFileLink(...)         │
│         · 300ms debounce + cancel                       │    │   case "requestFilePreview"─► previewFileLink(...)     │
│         · currentRequestId, currentLinkKey              │    │                │                         │
│         · postMessage(requestFilePreview)               │◀───┤────────────────┘                         │
│         · onResult(filePreviewResult) → render          │    │                                          │
│                  │                                      │    │   previewFileLink:                       │
│                  ▼                                      │    │     1. resolveFirstFile(path, deps)      │
│      HoverPreviewPopup (DOM, .xterm-hover sibling)      │    │     2. readFileForPreview(uri, caps)     │
│         · pre/Shiki render (code)                       │    │     3. classify lang + isMarkdown        │
│         · markdown-it+@shikijs/markdown-it (md)         │    │     4. postMessage filePreviewResult     │
│         · lazy-imported grammars                        │    │                                          │
│         · theme = vscodeThemeKind                       │    └──────────────────────────────────────────┘
└─────────────────────────────────────────────────────────┘
```

## Decisions

### D1: Shiki + `@shikijs/markdown-it` for in-popup rendering — **static curated grammar bundle**

Shiki reuses VSCode's TextMate grammars and themes, giving by-construction "looks like VSCode" output. `@shikijs/markdown-it` is the supported integration for highlighted code fences inside markdown. Monaco gives the same fidelity but is a full editor (~3 MB+) and is overkill for a read-only popup. `highlight.js` is smaller but produces visibly different output from VSCode (themes are not TextMate).

**Bundle strategy** (revised after oracle review):

- The webview is built as a single IIFE (`media/webview.js`, see `esbuild.js:83-89`) under a strict nonce-CSP (`webviewHtml.ts:35-39`). Dynamic `await import('shiki/langs/...')` chunks would not carry the script nonce and would violate CSP. Converting the build to ESM + outdir is out of appetite.
- **Therefore**: all grammars are **statically imported** at build time. The bundle composes `shiki/core` (from `shiki` package, v4.1.0) + the JavaScript regex engine (from `shiki/engine/javascript`) + a curated grammar list. No Oniguruma WASM (lighter, no separate WASM fetch under CSP).
- **Curated languages** (20 grammars, each statically imported from `@shikijs/langs/<id>`): `typescript`, `tsx`, `javascript`, `jsx`, `json`, `yaml`, `html`, `css`, `markdown`, `python`, `go`, `rust`, `c`, `cpp`, `java`, `kotlin`, `shellscript`, `sql`, `ruby`, `php`.
- **Themes** (statically imported from `@shikijs/themes/<id>`): `github-light`, `light-plus`, `github-dark`, `dark-plus`. The 4-way mapping in D8 picks one per render call via `highlighter.codeToHtml(content, { lang, theme })`.
- **Files in unsupported languages**: render as `<pre>`-escaped plain text (the popup's plain-text fallback path).
- **Bundle ceiling**: librarian estimate was ~1.1–1.3 MB minified, but the webview build keeps `minifyIdentifiers: false` + `minifySyntax: false` for xterm v6 compatibility (`esbuild.js:95-103`). Measured ceiling after task 1_1b: **2.74 MB** for the curated set. Task 4_2 enforces `media/webview.js` ≤ **3 MB** post-build. Acceptable because the webview loads from local disk (no network), and VSCode itself ships hundreds of MB. The headroom (~250 KB) is small but covers minor renderer code additions.
- **Canonical imports** (full sample is in `docs/research/20260521-shiki-v3-api.md` — the builder MUST follow it byte-for-byte):

```ts
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import typescript from "@shikijs/langs/typescript";
// ...19 more grammar imports...
import githubLight from "@shikijs/themes/github-light";
// ...3 more theme imports...
```

### D2: xterm's `ILink.hover`/`leave` + `xterm-hover` class for the popup

xterm.js explicitly documents this integration. The popup MUST be a child of **`terminal.element`** (the `.xterm` root) — NOT `screenElement` (`.xterm-screen`) — because the linkifier operates on `screenElement` coords and a child of `screenElement` would be subject to xterm's own decoration / overlay layering (`xterm-decoration` z-index 6, `xterm-decoration-top-layer` z-index 7, `xterm-decoration-overview-ruler` z-index 8). The popup carries class `xterm-hover` so xterm's `Linkifier._handleMouseMove` (checks `classList.contains('xterm-hover')` on any element in `composedPath()`) does not treat hovers over the popup as falling through to other links.

We do NOT introduce a separate floating-UI library (Floating UI / Popper) — the popup is a single rectangular surface and we can solve positioning with `terminal.element.getBoundingClientRect()` + manual viewport clamping in ~30 lines. Adopting Floating UI adds dependency surface for marginal gain.

### D3: 300 ms hover delay, single global state machine per terminal

Matches VSCode's editor hover delay (`HoverOperation` default = 300 ms in `vs/editor/contrib/hover/browser/hoverOperation.ts`). A per-terminal `HoverPreviewController` owns three pieces of state: the active timer, the active `requestId` (UUID), and the active link key (`sessionId:bufferY:rangeStartX:rangeEndX`). Any of `leave`, scroll, blur, or a new hover on a DIFFERENT link MUST clear the timer and bump `requestId`. A new hover on the SAME link within 300 ms MUST be a no-op (debounce). Late responses whose `requestId` doesn't match the active one are dropped.

### D4: New IPC pair, request/response correlated by `requestId`

`requestFilePreview` and `filePreviewResult` are added to the existing message unions in `src/types/messages.ts`. `requestId` is generated webview-side via `crypto.randomUUID()` (supported in webviews under modern VSCode and our `engines.vscode: ^1.105.0`). The host's reply must echo `requestId` verbatim. This shape mirrors how PTY ack-routing already correlates messages today, so reviewers will find the pattern familiar.

### D5: First-hit-only resolver, reuses `buildCandidates` infrastructure

We extract a `resolveFirstFile(path, sessionId, deps): Promise<{ uri: vscode.Uri; absPath: string } | { kind: "ambiguous" | "not-found" }>` from `src/providers/openFileLink.ts`. It reuses `buildCandidates(...)` for steps 1–5 of the existing chain and runs `findFiles(...)` for step 6, with the same input sanitization (no glob meta-chars, no traversal). The hover variant differs from the click variant in three ways:

1. On any candidate that resolves as a file → return immediately.
2. On step 6 returning **≥2 matches** → return `{ kind: "ambiguous" }` (no quickPick).
3. On zero matches anywhere → return `{ kind: "not-found" }` (no toast).

Refactor scope: `openFileLink.ts` stays as-is for click flow; we add a sibling `previewFileLink.ts` that imports the shared helpers. No behavior change for the existing click path.

### D6: File-read caps and binary heuristic (revised)

Oracle flagged the prior design (`workspace.fs.readFile` + slice) as unsound because `workspace.fs.readFile` loads the entire file into memory before any slicing happens. Revised algorithm:

`readFileForPreview(uri, token)`:

1. `const stat = await vscode.workspace.fs.stat(uri);` → returns `totalBytes = stat.size`.
2. If `stat.size > HARD_LIMIT_BYTES` (1 000 000), return `{ status: "too-large", totalBytes }` WITHOUT calling `readFile`.
3. Else `const all = await vscode.workspace.fs.readFile(uri);` then slice: `const bytes = all.slice(0, PREVIEW_LIMIT_BYTES);` where `PREVIEW_LIMIT_BYTES = 200 000`.
4. Scan `bytes.slice(0, 8 192)` for NUL (`0x00`) → if found, return `{ status: "binary", totalBytes }`.
5. Decode via `new TextDecoder("utf-8", { fatal: false })` so partial multi-byte sequences at the slice boundary become replacement chars.
6. Split on `/\r?\n/`. If `lines.length > 500`, keep first 500 and set `truncated = true`. If `all.byteLength > PREVIEW_LIMIT_BYTES`, also set `truncated = true`.
7. Check `token.isCancellationRequested` between (1)/(3) and before returning.

**Rationale for the two-tier cap (HARD_LIMIT vs PREVIEW_LIMIT)**:

- HARD_LIMIT (1 MB) protects the extension host from reading huge files into memory at all. Anything larger short-circuits to `too-large`.
- PREVIEW_LIMIT (200 KB) protects the popup IPC payload and rendering time. For files between 200 KB and 1 MB we accept the in-memory bloat (1 MB max) but still cap the popup payload.

This is the simplest implementation that doesn't require migrating off `workspace.fs.*` to `node:fs.open + read` for partial local reads. Local-only partial reads would shave that 1 MB ceiling but introduce complications for SSH / remote / virtual file system providers — out of appetite for v1. The two-tier cap is the explicit trade-off.

The 8 KB NUL scan matches VSCode's own binary detection (`vs/platform/files/common/files.ts`).

### D7: Out-of-workspace files preview silently — mitigated by always-visible `absPath` header

Hover is a passive disclosure of content the user's terminal output already referenced. Existing OPEN flow keeps its modal confirm (`src/providers/openFileLink.ts`'s out-of-workspace branch). Oracle flagged the silent variant as more accident-prone than the click variant; the mitigation is the spec's mandatory **popup header** showing `absPath` for every result. That way users see exactly which file is being previewed regardless of workspace boundary. No new setting in v1; revisit only if user feedback asks.

### D8: Theme bridge (high-contrast aware) — per-render theme selection

VSCode theme kind is observable via `vscode.window.activeColorTheme.kind`. The extension host posts `{ type: "themeChanged", kind }` to the webview on init and on every `onDidChangeActiveColorTheme`. `kind` is the 4-value union `"light" | "dark" | "hc-light" | "hc-dark"`:

| `ColorThemeKind`         | Posted `kind`  | Shiki theme   |
| ------------------------ | -------------- | ------------- |
| `Light`                  | `"light"`      | `github-light`|
| `Dark`                   | `"dark"`       | `github-dark` |
| `HighContrastLight`      | `"hc-light"`   | `light-plus`  |
| `HighContrast`           | `"hc-dark"`    | `dark-plus`   |

`light-plus` / `dark-plus` are VSCode's own default themes (shipped in Shiki) — confirmed available by name in `@shikijs/themes` (librarian research). Using them for the high-contrast kinds best preserves the accessibility intent.

**Render-time theme selection**: the Shiki highlighter is created ONCE with all four themes preloaded. Both code and markdown rendering invoke `highlighter.codeToHtml(content, { lang, theme })` at render time with the current theme. This gives us 4-way theme control. We do NOT use `@shikijs/markdown-it`'s CSS-variable multi-theme output (only supports 2 theme slots and decides via CSS, not JS — incompatible with our 4-way model) — see D12 for the markdown rendering decision.

### D9: Cancellation across IPC (revised semantics)

Cancellation is split into two layers — webview-side stale-response invalidation and host-side supersession — because the IPC has no `cancelFilePreview` message (oracle finding):

- **Webview**: `HoverPreviewController` tracks an `activeRequestId`. Any of `leave` / mousedown / wheel / dispose / scroll / blur / new hover sets `activeRequestId = null`. A `filePreviewResult` whose `requestId` doesn't match `activeRequestId` is dropped silently. There is no IPC message to "tell the host to stop"; the host just keeps working and the late response is discarded.
- **Host**: a `Map<sessionId, vscode.CancellationTokenSource>` ensures at most one in-flight `previewFileLink` per session. When a new request arrives for a session with an existing token, the host calls `prior.cancel()` then `prior.dispose()`, removes the map entry, and starts the new request with a fresh token. `previewFileLink` and `readFileForPreview` check `token.isCancellationRequested` between awaits. On session close / terminal disposal, the host cancels and disposes any in-flight token for that session and clears the entry. This is the only path that aborts host-side work.

Trade-off: under fast mouse movement the host may briefly perform reads whose results are never used. Acceptable — the read cap (D6) bounds the wasted work.

### D10: Lifecycle and disposal — explicit contract

Disposal flows from outer to inner:

```
terminal.dispose()  ─►  TerminalFactory.dispose()
                         ├─ FilePathLinkProvider.dispose()
                         │    └─ controller.dispose()
                         │         ├─ clearTimeout(pendingTimer)
                         │         ├─ activeRequestId = null
                         │         ├─ popup.unmount() if any
                         │         └─ unregister window/terminal listeners
                         └─ (host side, via session close event)
                              └─ tokenMap.get(sessionId)?.cancel()/dispose()
                                 tokenMap.delete(sessionId)
```

After `controller.dispose()` the controller is inert and silently drops any later `filePreviewResult`. This is codified by spec `Requirement: Lifecycle / disposal`. Unit tests in task 3_1 cover (a) dispose-mid-flight drops the response, (b) dispose clears timer, (c) dispose removes popup.

### D11: Bundle validation gate runs FIRST, not last

Oracle correctly flagged that "validate bundle size last" is risky for a feature whose viability depends on the bundle math. Task ordering is revised so the **smoke build runs immediately after task 1_1**: install deps, write a one-line `import` of Shiki + the curated grammars in a throwaway test file, build, measure `media/webview.js`. If the size exceeds the 1.6 MB ceiling, the plan stops and re-enters discovery. This converts a late risk into an early go/no-go gate.

### D12: Markdown rendering — markdown-it `highlight` callback (not `@shikijs/markdown-it`)

The `@shikijs/markdown-it` plugin emits multi-theme HTML using CSS variables and decides which theme wins via CSS at runtime — its API supports 2 themes (`light`/`dark`) and ties theme selection to CSS rather than the JS runtime. That's incompatible with our 4-way JS-controlled theme model (D8).

**Decision**: skip `@shikijs/markdown-it` entirely. Use markdown-it's built-in `highlight(code, lang) => html` option to call our shared Shiki highlighter with the current theme. This keeps a single render path and a single shared `createHighlighterCore` instance.

```ts
import MarkdownIt from "markdown-it";
const md = new MarkdownIt({
  html: false,
  linkify: false,
  highlight: (code, lang) => syntaxRenderer.renderHtml(code, lang, getTheme()),
});
md.validateLink = () => false;
```

Consequence: drop `@shikijs/markdown-it` from `package.json` (compared to the earlier plan). Only `shiki`, `@shikijs/langs`, `@shikijs/themes`, `markdown-it`, `@types/markdown-it` are needed.

### D13: VSCode `languageId` resolution — curated extension map (hot-path)

Hover hits the host on every link the user dwells on. `vscode.workspace.openTextDocument(uri)` would read the file and create a TextDocument just to get `.languageId` — wasteful for a read-only preview that already reads the file separately. Per librarian research, the recommended fast-path is a hand-maintained extension → `languageId` map for the 20 curated grammars.

The map lives in `src/providers/previewFileLink.ts` (or a small helper module). Optional later: layer `vscode.workspace.getConfiguration('files').get('associations')` on top to honour user overrides. v1 does NOT include the associations overlay — captured as out-of-scope.

```ts
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
  ".json": "json", ".yml": "yaml", ".yaml": "yaml", ".html": "html",
  ".css": "css", ".md": "markdown", ".py": "python", ".go": "go",
  ".rs": "rust", ".c": "c", ".cpp": "cpp", ".cc": "cpp",
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
  ".sh": "shellscript", ".sql": "sql", ".rb": "ruby", ".php": "php",
};
```

Unknown extensions → `"plaintext"` → popup renders as `<pre>`-escaped plain text.

### D14: Trust policy + Cmd/Ctrl override (round-2 BLOCK fix)

D7's "silently preview anything the terminal references" was found to be exploitable: a hostile process in the terminal can emit OSC 7 (`\e]7;file:///\e\\`) to set `currentCwd` to `/`, then print `etc/passwd`. The hover handler — reusing `buildCandidates` which includes `currentCwd` as a resolution source — silently reads up to 200 KB of `/etc/passwd` into the popup. The click flow guards against this via the explicit `bases = [initialCwd, ...workspaceFolders]` check at `openFileLink.ts:457-471` (with security comment); hover defeats that protection.

**Trust policy** (after resolution, before read):

1. `classifyTrust(absPath, trustBases)` returns one of `dotfile` / `sensitive-dir` / `out-of-workspace` / `null`.
   - `dotfile`: basename starts with `.` (`.env`, `.bashrc`, `.gitignore`).
   - `sensitive-dir`: any non-basename segment starts with `.` (`.git/`, `.ssh/`, `.aws/`, `.config/`) OR equals a known-sensitive name (`node_modules`). Order matters — checked AFTER dotfile.
   - `out-of-workspace`: `absPath` is not inside any trust base. Trust bases = `[initialCwd, ...workspaceFolders]` — explicitly EXCLUDING `currentCwd` (OSC-7-injectable).
2. When `classifyTrust` returns non-null and `msg.override !== true`: return a new `requires-confirmation` status with `absPath` + `reason` (no `content`).
3. Webview popup renders the `requires-confirmation` placeholder with text "Hold Cmd to preview" (macOS) or "Hold Ctrl to preview" (Win/Linux), detected via `navigator.platform`.

**Override gesture**: HoverPreviewController watches `keydown` for Cmd (macOS) / Ctrl (Win/Linux). When pressed during an active hover (timer pending OR popup showing), the controller bumps `activeRequestId` and re-posts the request with `override: true`. The host's resolver skips the trust check when `override === true`. One-shot per hover — `overrideRequested` flag resets on new hover.

**Modifier semantics** match VSCode's own "open in new tab" click gesture (platform-aware). User clarification at GATE 1.5 (round 2): "Dotfiles + known-sensitive + outside workspace" + "Platform-aware Cmd on mac, Ctrl elsewhere".

### D15: Line-focus + scroll-to-line

The parser already extracts `line` / `col` from suffix patterns (`:42`, `:42:7`, `(42)`, `[42:7]`). Round 2 adds GitHub-style permalink fragments: `#L42` and `#42`. Suffix regex in `filePathParser.ts` gains a third alternative: `#L?(?<row3>\d+)`.

Flow: parser → `attachHover(link, path, line)` → controller stores `activeLine`, includes in request → host echoes `line` in `FilePreviewResultBase.line` → popup `renderOkBody` finds `<span class="line">` at index `line - 1`, calls `scrollIntoView({block:"center"})`, adds `anywhere-hover-preview-line-active` class for highlight.

Implementation note: Shiki's `codeToHtml` already wraps each line in `<span class="line">`. The plain-text fallback in `HoverPreviewPopup.renderOkBody` mirrors this wrapping so the line-focus mechanism works without Shiki. Markdown rendering does NOT preserve line structure — line-focus skipped for markdown.

### D16: Line-number gutter + word-wrap at 120 col

**Line numbers** are rendered via a CSS counter — no DOM mutation required:
- `.anywhere-hover-preview-body { counter-reset: anywhere-line; }`
- `.anywhere-hover-preview-body .line { counter-increment: anywhere-line; }`
- `.anywhere-hover-preview-body-numbers .line::before { content: counter(anywhere-line); width: 3ch; ... }`

The `-body-numbers` class is always applied (line numbers are always on). The `.line` spans come from Shiki's output (or the plaintext-fallback wrapping from D15), so the same gutter renders for both code and plain text.

**Word wrap** at 120 chars is a CSS-class toggle:
- `.anywhere-hover-preview-body-wrap pre { white-space: pre-wrap; word-break: break-all; max-width: 120ch; }`

`120ch` is character-width-aware in monospace fonts, so 120 characters before wrap. The class is applied conditionally based on the `wordWrap` setting (D17).

### D17: Settings contribution + footer toolbar

Four user-facing settings via `contributes.configuration`:
- `anywhereTerminal.hoverPreview.enabled` — master switch (default `true`)
- `anywhereTerminal.hoverPreview.delay` — debounce ms (default `300`, range 100-2000)
- `anywhereTerminal.hoverPreview.wordWrap` — wrap at 120 col (default `false`)
- `anywhereTerminal.hoverPreview.blockSensitive` — trust policy on/off (default `true`)

**Settings bridge** (host ↔ webview):
- Host → webview: `hoverPreviewSettings` message posted on init + every `onDidChangeConfiguration` that affects `anywhereTerminal.hoverPreview.*`.
- Webview → host: `updateHoverPreviewSetting { key, value }` — host validates + clamps then calls `workspace.getConfiguration().update(key, value, Global)`. Re-broadcasts on the resulting config change event.

**Footer toolbar** is rendered as the popup's third row (header / body / footer). Three controls:
- Word-wrap checkbox → `updateHoverPreviewSetting("wordWrap", checked)`
- Auto-preview checkbox → `updateHoverPreviewSetting("enabled", checked)`
- Delay number input (min=100, max=2000, step=50) → `updateHoverPreviewSetting("delay", n)`

When `enabled: false`, the host returns `requires-confirmation` with `reason: "disabled"` for every request (unless overridden). When `blockSensitive: false`, the trust check from D14 is skipped (still subject to "enabled" gate).

Footer `mousedown` calls `stopPropagation()` so clicking a toggle doesn't trigger the popup's outside-mousedown dismissal.

User clarification at GATE 1.5 (round 2): "VSCode contributed settings + popup footer toggles" — settings persist as user-scope config (visible in settings.json, syncable across machines).

## Interfaces

```ts
// src/types/messages.ts — additions to existing unions

export interface RequestFilePreviewMessage {
  type: "requestFilePreview";
  requestId: string;       // crypto.randomUUID()
  sessionId: string;
  path: string;
  line?: number;
  col?: number;
}

export type FilePreviewStatus =
  | "ok"
  | "not-found"
  | "binary"
  | "too-large"
  | "ambiguous"
  | "error";

export interface FilePreviewResultMessage {
  type: "filePreviewResult";
  requestId: string;
  status: FilePreviewStatus;
  content?: string;
  languageId?: string;     // VSCode language id, e.g. "typescript"
  isMarkdown?: boolean;
  truncated?: boolean;
  totalBytes?: number;
  totalLines?: number;
  absPath?: string;
}

export interface ThemeChangedMessage {
  type: "themeChanged";
  kind: "light" | "dark" | "hc-light" | "hc-dark";
}
```

```ts
// src/providers/previewFileLink.ts — new file
export interface PreviewFileLinkDeps {
  fileSystem: Pick<vscode.FileSystem, "stat" | "readFile">;
  workspace: typeof vscode.workspace;
  // ...same shape as openFileLink deps for resolver reuse
}

export async function previewFileLink(
  msg: RequestFilePreviewMessage,
  deps: PreviewFileLinkDeps,
  token: vscode.CancellationToken,
): Promise<FilePreviewResultMessage>;
```

```ts
// src/webview/links/HoverPreviewController.ts — new file
export class HoverPreviewController {
  constructor(deps: {
    terminal: import("@xterm/xterm").Terminal;
    sessionId: string;
    postMessage: (msg: WebViewToExtensionMessage) => void;
    getTheme: () => "light" | "dark" | "hc-light" | "hc-dark";
  });
  attachHover(link: ILink): void;     // installs link.hover + link.leave
  onMessage(msg: FilePreviewResultMessage): void;
  dismiss(): void;                    // called on scroll/blur/dispose
  dispose(): void;
}
```

## Risk Map

| Component                       | Risk                                                                                                                  | Mitigation                                                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shiki bundle size               | Curated 20-grammar + 4-theme bundle exceeds the 3 MB ceiling                                                         | **Early gate** (D11): smoke-build at task 1_1b measured 2.74 MB; ceiling raised from 1.6 → 3 MB after observing webview build skips identifier/syntax minification (xterm compat). Future regressions over 3 MB fail the build via the post-build script (task 4_2).                                       |
| CSP / IIFE bundle compatibility | Dynamic `import()` chunks would not carry the script nonce; runtime CSP violations                                   | Curated grammar list is **statically imported** at build time (D1) — no runtime `import()` of Shiki assets. JS regex engine (not Oniguruma WASM) — no separate WASM fetch. Task 3_3 acceptance includes "DevTools shows zero CSP errors after loading a code-fence preview".                              |
| Hover race conditions           | Late responses overwrite a newer popup; cursor moving fast can leak DOM nodes                                         | Two-layer cancellation (D9): webview `activeRequestId` drops stale results, host token map cancels superseded reads. Unit-test `HoverPreviewController` (task 3_1) for: stale-response drop, leave-cancels-pending, new-hover-supersedes-old, dispose-mid-flight.                                          |
| Path-resolution divergence      | A future change to `openFileLink`'s resolver could leave hover behind                                                 | Extract `buildCandidates` into a shared helper module imported by BOTH `openFileLink.ts` and `previewFileLink.ts`. Cover with a parameterised unit test that runs both flows over the same scenarios.                                                                                                     |
| Binary / large files            | Reading a 100 MB file would freeze the host                                                                          | `stat` first; `> 1 MB` short-circuits to `too-large` WITHOUT reading (D6); ≤1 MB reads then slices to 200 KB; NUL scan in first 8 KB for binary. Unit-test (task 2_2) with a stat-mocked 5 MB fixture asserts `readFile` is never called.                                                                  |
| Out-of-workspace exposure       | Hover silently previews any file the terminal references                                                              | Deliberate decision (D7) mitigated by always-visible `absPath` header in the popup (spec "Popup header" + "Out-of-workspace files"). Resolver still respects `..` traversal rules from the existing chain.                                                                                                |
| Theme mismatch / high-contrast accessibility | Shiki popup uses a theme that clashes with the VSCode theme, especially in high-contrast mode             | Four-way theme bridge (D8) mapping `HighContrastLight` → `light-plus` and `HighContrast` → `dark-plus` (VSCode default themes shipped in Shiki). Manual smoke item in task 4_1 walks all four theme kinds.                                                                                                |
| xterm internal API drift        | `terminal.element` and `xterm-hover` class are stable but documented as integration points                            | These are part of xterm's documented public API surface (`@xterm/xterm` typings). If xterm changes them we'd lose all link-hover features. Acceptable risk — pinned via `package.json` and covered by `pnpm-lock.yaml`.                                                                                   |
| Markdown XSS                    | Rendered markdown could execute scripts if `markdown-it` is misconfigured                                             | `markdown-it` initialised with `html: false, linkify: false`; `md.validateLink = () => false`. `@shikijs/markdown-it` only modifies fence rendering. Spec mandates link inertness ("Popup rendering — markdown files" + "Accessibility / inertness").                                                      |
| Popup blocks terminal selection | `xterm-hover` class prevents mouse events from falling through; popup can block selection / right-click               | Hard maximum dimensions in spec ("Preview popup positioning") — 560×360 px. Spec "Accessibility / inertness" mandates dismiss on `mousedown` or `wheel` outside the popup so selection / scroll resume immediately. Unit test in task 3_2 covers click-outside-dismisses.                                |
| Host-side token-map leak        | `Map<sessionId, CancellationTokenSource>` could leak after session close                                              | Spec "Host cancellation on supersession" requires cancel + dispose + map.delete on session close. Task 2_3 acceptance includes "session close cleans the map entry" with a unit test driving a fake session-close event.                                                                                  |
| Accessibility                   | Hover-only content is invisible to keyboard users; could trap focus                                                  | Spec "Accessibility / inertness": `role="tooltip"`, no focusable controls, Escape dismisses, no focus traps. Task 3_2 acceptance includes the role attribute and Escape handler.                                                                                                                          |
| Overlay z-index collision       | Existing drag-drop tip / insert-path-flash overlays sit at z-index 50                                                 | Spec "Preview popup positioning" pins popup z-index at 100, above both existing overlays. Task 3_2 asserts the CSS rule.                                                                                                                                                                                  |
