## 1. Foundations — deps, IPC types, theme bridge

- [x] 1_1 Add Shiki + markdown-it deps
  - **Deps**: none
  - **Refs**: design.md D1, D12 (no @shikijs/markdown-it), D13; docs/research/20260521-shiki-v3-api.md (exact versions and import paths)
  - **Scope**: `package.json`, `pnpm-lock.yaml`
  - **Acceptance**:
    - Outcome: `package.json` adds `shiki@^4.1.0`, `@shikijs/langs@^4.1.0`, `@shikijs/themes@^4.1.0`, `markdown-it@^14.1.1` to `dependencies` and `@types/markdown-it@^14.1.2` to `devDependencies`. `@shikijs/markdown-it` MUST NOT be installed (per D12). `pnpm install` is clean.
    - Verify: manual `pnpm install && pnpm run check-types` exits 0.
  - **Plan**:
    1. `pnpm add shiki@^4.1.0 @shikijs/langs@^4.1.0 @shikijs/themes@^4.1.0 markdown-it@^14.1.1`
    2. `pnpm add -D @types/markdown-it@^14.1.2`
    3. Confirm `@shikijs/markdown-it` is NOT in `package.json` (remove if present).

- [x] 1_1b **EARLY GATE** — bundle-size smoke build
  - **Deps**: 1_1
  - **Refs**: design.md D1 ("Bundle ceiling"), D11; design.md "Shiki bundle size" risk
  - **Scope**: new `scripts/check-bundle-size.mjs`, throwaway probe file under `src/webview/` (deleted after task 1_1b), `tsconfig.json` (set `moduleResolution: "Bundler"` so Shiki's ESM-only exports type-check from `.ts`).
  - **Acceptance**:
    - Outcome: Production build (`pnpm run check-types && node esbuild.js --production`) produces a `media/webview.js` whose size, including the curated grammar+theme static imports from D1, is ≤ **3 MB** (raised from 1.6 MB after first probe measured 2.74 MB — webview build skips identifier/syntax minification for xterm compat; user-confirmed). If the size exceeds the ceiling, this task FAILS and the plan halts (do not proceed to task 2_*) — the failure mode is captured in workflow.md and the plan re-enters discovery for an alternative (smaller grammar set, ESM build, alternative renderer).
    - Verify: manual — run the new `node scripts/check-bundle-size.mjs` after build; assert exit 0 and that the printed total is below the ceiling.
  - **Plan**:
    1. Create a throwaway `src/webview/__bundle-probe.ts` that statically imports `createHighlighterCore` from `shiki/core` plus the 20 curated grammars and 4 themes (TS/TSX/JS/JSX/JSON/YAML/HTML/CSS/MD/Python/Go/Rust/C/C++/Java/Kotlin/Shellscript/SQL/Ruby/PHP × github-light/light-plus/github-dark/dark-plus) and re-exports `createHighlighterCore`.
    2. Import the probe from `src/webview/main.ts` (or wherever esbuild's webview entry resolves).
    3. Run `pnpm run check-types` and the existing esbuild build (or invoke `node esbuild.js` directly).
    4. Write `scripts/check-bundle-size.mjs`: `fs.statSync('media/webview.js').size <= 1.6 * 1024 * 1024`; print actual size; `process.exit(1)` if over.
    5. Run the script; record actual size in the Revision Log.
    6. If under ceiling: leave the probe + script in place (task 4_2 will hook the script into the build pipeline). If over: STOP, raise the issue in workflow.md.

- [x] 1_2 Add new IPC message types
  - **Deps**: none
  - **Refs**: design.md D4, D8 ("Interfaces" section); specs/file-link-hover-preview/spec.md#requirement-ipc-contract--requestfilepreview--filepreviewresult; specs/file-link-hover-preview/spec.md#requirement-theme-synchronization
  - **Scope**: `src/types/messages.ts`
  - **Acceptance**:
    - Outcome: `RequestFilePreviewMessage`, `FilePreviewResultMessage`, `ThemeChangedMessage`, and `FilePreviewStatus` are exported and added to the relevant unions (`WebViewToExtensionMessage` gets `RequestFilePreviewMessage`; `ExtensionToWebViewMessage` gets `FilePreviewResultMessage` + `ThemeChangedMessage`). `ThemeChangedMessage.kind` MUST be the 4-value union `"light" | "dark" | "hc-light" | "hc-dark"` (D8).
    - Verify: manual `pnpm run check-types` exits 0.
  - **Plan**:
    1. Append interface declarations as in design.md "Interfaces".
    2. Extend the `WebViewToExtensionMessage` and `ExtensionToWebViewMessage` unions in the same file.

- [x] 1_3 Wire VSCode theme bridge → webview
  - **Deps**: 1_2
  - **Refs**: design.md D8; specs/file-link-hover-preview/spec.md#requirement-theme-synchronization
  - **Scope**: `src/providers/TerminalViewProvider.ts`, `src/providers/TerminalEditorProvider.ts`, `src/providers/TerminalViewProvider.test.ts`
  - **Acceptance**:
    - Outcome: On webview ready and on every `vscode.window.onDidChangeActiveColorTheme`, the host posts `{ type: "themeChanged", kind }` per the four-way mapping: `Light` → `"light"`, `Dark` → `"dark"`, `HighContrastLight` → `"hc-light"`, `HighContrast` → `"hc-dark"`. Provider disposes the theme-change subscription on `dispose()`.
    - Verify: unit `src/providers/TerminalViewProvider.test.ts` — add four cases (one per `ColorThemeKind`) that mock `vscode.window.onDidChangeActiveColorTheme` firing and assert the corresponding `postMessage` payload; one case that disposes the provider and asserts no further posts on subsequent theme changes.
  - **Plan**:
    1. Add a `private static themeKindFor(kind: vscode.ColorThemeKind): ThemeChangedMessage["kind"]` static.
    2. On webview attach + on `onDidChangeActiveColorTheme`, call `webview.postMessage(themeChangedMsg)`.
    3. Track the `Disposable` returned by `onDidChangeActiveColorTheme` in the provider's disposables list.
    4. Mirror in `TerminalEditorProvider` (same provider pattern, same subscriptions).

## 2. Host-side resolution + read

- [x] 2_1 Extract shared candidate-building helper
  - **Deps**: none
  - **Refs**: design.md "Path-resolution divergence" risk; specs/file-link-hover-preview/spec.md#requirement-first-hit-path-resolution-for-hover
  - **Scope**: `src/providers/openFileLink.ts`, new `src/providers/pathResolution.ts`, new `src/providers/pathResolution.test.ts`
  - **Acceptance**:
    - Outcome: `buildCandidates` (currently in `openFileLink.ts`) moves to `pathResolution.ts` and is imported by `openFileLink.ts`. Existing test suite for `openFileLink.ts` still passes byte-for-byte. New shared helper has its own focused tests covering candidate ordering across the 5 sources.
    - Verify: unit `src/providers/pathResolution.test.ts` + the existing `src/providers/openFileLink.test.ts` green via `pnpm run test:unit`.
  - **Plan**:
    1. Cut `buildCandidates` + its private helpers into `pathResolution.ts`; export them.
    2. Replace the call site in `openFileLink.ts` with the import; preserve type signatures.
    3. Move `pathPreprocess` / `resolveCwdRelative` imports as appropriate.
    4. Add `pathResolution.test.ts` mirroring the existing buildCandidates tests.

- [x] 2_2 Implement `previewFileLink` (resolver + reader)
  - **Deps**: 1_2, 2_1
  - **Refs**: design.md D5, D6 (two-tier cap), D9; specs/file-link-hover-preview/spec.md#requirement-first-hit-path-resolution-for-hover; specs/file-link-hover-preview/spec.md#requirement-file-size-guard-and-read-limits; specs/file-link-hover-preview/spec.md#requirement-binary-file-detection; specs/file-link-hover-preview/spec.md#requirement-host-cancellation-on-supersession
  - **Scope**: new `src/providers/previewFileLink.ts`, new `src/providers/previewFileLink.test.ts`, new `src/providers/readFileForPreview.ts`, new `src/providers/readFileForPreview.test.ts`
  - **Acceptance**:
    - Outcome: `previewFileLink(msg, deps, token)` returns a `FilePreviewResultMessage`. Resolver matches D5 exactly (first hit; `findFiles` ≥2 → `"ambiguous"`; none → `"not-found"`; directory → `"not-found"`; OOW returns content silently). Reader implements the **two-tier cap** (D6): `stat` first; `size > 1_000_000` → return `{ status: "too-large", totalBytes }` WITHOUT calling `readFile`; otherwise `readFile` and slice to 200 KB; NUL scan in first 8 KB → `"binary"`; UTF-8 decode with `fatal: false`; line cap = 500 lines. `truncated` is set when either bytes were sliced or lines were dropped. Cancellation token is checked before AND after `stat`, before AND after `readFile`, and before posting the result.
    - Verify: unit `src/providers/previewFileLink.test.ts` (resolver paths — exhaustive) + `src/providers/readFileForPreview.test.ts` covering: (a) `size > 1 MB` returns `too-large` and asserts `readFile` mock was NEVER called, (b) `size = 100 KB`, 600 lines → `truncated: true` with 500 lines, (c) NUL byte in first 8 KB → `binary`, (d) NUL byte AFTER 8 KB → treated as text (replacement chars), (e) cancellation aborts before posting, (f) UTF-8 multi-byte at byte 200 000 boundary yields replacement chars not throw.
  - **Plan**:
    1. Implement `readFileForPreview(uri, fs, token)` per D6: (a) `await fs.stat(uri)`; (b) if `size > HARD_LIMIT_BYTES (1_000_000)` return `{ status: "too-large", totalBytes: size }` immediately; (c) `await fs.readFile(uri)` → `Uint8Array all`; (d) `const bytes = all.subarray(0, PREVIEW_LIMIT_BYTES = 200_000)`; (e) scan `bytes.subarray(0, 8192)` for `0x00` → if found, return `{ status: "binary", totalBytes: size }`; (f) `new TextDecoder("utf-8", { fatal: false }).decode(bytes)`; (g) `split(/\r?\n/)`, slice 500, compute `truncated = lines>500 || all.byteLength>PREVIEW_LIMIT_BYTES`; (h) token-check between each await.
    2. Implement `previewFileLink(msg, deps, token)` calling the shared `buildCandidates` + new `findFirstFile` helper + (on miss) workspace `findFiles`, then `readFileForPreview`.
    3. Map outcomes to `FilePreviewStatus` values.
    4. Add a `LANGUAGE_BY_EXTENSION` map (per design.md D13, copy from `docs/research/20260521-shiki-v3-api.md` § 3) and a `languageIdFromUri(uri): string` helper that lowercases the path, matches `/\.[^.]+$/`, and returns the map value or `"plaintext"`. Use this for the `languageId` field (no `openTextDocument` call).
    5. Detect markdown by `languageId === "markdown"` OR `uri.fsPath` extension matches `/\.(md|markdown|mdx)$/i`.

- [x] 2_3 Wire host dispatcher branch for `requestFilePreview` + token-map lifecycle
  - **Deps**: 1_2, 2_2
  - **Refs**: design.md "Architecture" diagram, D9, D10; specs/file-link-hover-preview/spec.md#requirement-host-cancellation-on-supersession
  - **Scope**: `src/providers/TerminalViewProvider.ts`, `src/providers/TerminalEditorProvider.ts`, `src/providers/TerminalViewProvider.test.ts`
  - **Acceptance**:
    - Outcome: On receiving `{ type: "requestFilePreview", ... }` the provider creates a fresh `CancellationTokenSource` keyed by `sessionId`, calls `cancel()` + `dispose()` on any prior token for that session, calls `previewFileLink(msg, deps, token)`, and posts the result back on the same webview. After posting, the entry is removed from the map. On session close (existing session-close event wired through `SessionManager`) AND on provider `dispose()`, all remaining token sources MUST be cancelled, disposed, and the map cleared. A result MUST NOT be posted if the token is cancelled.
    - Verify: unit additions to `TerminalViewProvider.test.ts` — (a) two back-to-back `requestFilePreview` arrivals for the same session → first token's `cancel()` was called; (b) session-close event → all entries for that session removed and disposed; (c) provider `dispose()` → all entries cleared; (d) `previewFileLink` resolves AFTER cancellation → result is NOT posted.
  - **Plan**:
    1. Add a `private readonly previewTokens = new Map<string, vscode.CancellationTokenSource>()` field on the provider.
    2. On message arrival for `requestFilePreview`: cancel + dispose any existing source for the session, create a new one, store in the map, await `previewFileLink`, and post result ONLY if `!token.isCancellationRequested`. In `finally`, delete the map entry if the token still equals the current map value.
    3. Subscribe to the existing session-close emit (find via `SessionManager`); on emit, cancel + dispose + delete for that session.
    4. In the provider's `dispose()`: iterate the map, cancel + dispose each, clear.
    5. Mirror in `TerminalEditorProvider`.

## 3. Webview — controller + popup + rendering

- [x] 3_1 Hover state machine — `HoverPreviewController`
  - **Deps**: 1_2
  - **Refs**: design.md D2, D3; specs/file-link-hover-preview/spec.md#requirement-hover-trigger-and-debounce; specs/file-link-hover-preview/spec.md#requirement-cancellation-correctness
  - **Scope**: new `src/webview/links/HoverPreviewController.ts`, new `src/webview/links/HoverPreviewController.test.ts`
  - **Acceptance**:
    - Outcome: Class exposes `attachHover(link)`, `onMessage(result)`, `dismiss()`, `dispose()`. Timer fires at 300 ms; `leave`/`dismiss`/new-different-link clears the timer and invalidates the pending `requestId`. Stale `filePreviewResult` (`requestId` mismatch) is silently dropped.
    - Verify: unit `src/webview/links/HoverPreviewController.test.ts` — fake timers; assert (a) hover→300 ms→postMessage called once, (b) hover→leave-before-300 ms→no postMessage, (c) hover→new-link→old request invalidated, (d) stale result dropped.
  - **Plan**:
    1. Implement state: `pendingTimer | null`, `activeRequestId | null`, `activeLinkKey | null`, `popup | null`.
    2. `attachHover` installs `link.hover` + `link.leave` callbacks that drive the state machine.
    3. `onMessage` checks `requestId === activeRequestId`; if not, return; otherwise hand off to popup renderer.

- [x] 3_2 Popup DOM component — `HoverPreviewPopup`
  - **Deps**: 3_1
  - **Refs**: design.md D2; specs/file-link-hover-preview/spec.md#requirement-preview-popup-dom-contract; specs/file-link-hover-preview/spec.md#requirement-preview-popup-positioning; specs/file-link-hover-preview/spec.md#requirement-popup-states-for-non-ok-results; specs/file-link-hover-preview/spec.md#requirement-popup-header-path-disclosure; specs/file-link-hover-preview/spec.md#requirement-accessibility--inertness
  - **Scope**: new `src/webview/links/HoverPreviewPopup.ts`, new `src/webview/links/HoverPreviewPopup.test.ts`, `src/providers/webviewHtml.ts` (CSS additions only)
  - **Acceptance**:
    - Outcome: `mount(terminalElement, anchorEvent, viewModel)` attaches a `<div class="xterm-hover anywhere-hover-preview" role="tooltip">…</div>` as a child of `terminal.element`. The element renders (a) a single-line header showing `absPath` or fallback `path` (ellipsis-truncated, `title` attribute = full path); (b) a body containing either the rendered code/markdown element or the appropriate placeholder. Position math implements the spec exactly: anchor = `(event.clientX - rect.left, event.clientY - rect.top)`; popup top-left = anchor + (0, 12); clamp right to `terminal.element.clientWidth`; if overflow bottom, flip to anchor - (0, 12) - popupHeight. Max dimensions = `min(560, clientWidth-16) × min(360, clientHeight-16)`; content overflowing scrolls. CSS sets `z-index: 100`. The popup installs and self-removes the following listeners on mount/unmount: window `mousedown` (outside the popup → unmount), `terminal.element` `wheel` (→ unmount), document `keydown` (Escape → unmount).
    - Verify: unit `src/webview/links/HoverPreviewPopup.test.ts` using JSDOM — assert (a) DOM has `role="tooltip"` and class list; (b) header shows absPath, truncated, with `title`; (c) all 5 placeholder strings match spec; (d) position math: with a 400×300 terminal and an anchor near the right edge, popup shifts left; near the bottom edge, popup flips above; (e) mousedown outside the popup triggers unmount; (f) Escape key triggers unmount; (g) wheel event on terminal triggers unmount; (h) `z-index: 100` is present in the computed style.
  - **Plan**:
    1. Implement static helpers `formatBytes(n)` ("Binary file (12.3 KB)") and `computePosition(anchorX, anchorY, popupW, popupH, terminalW, terminalH)`.
    2. Implement `mount(terminalElement, anchorEvent, viewModel)` that creates the element, computes position, applies inline styles, and attaches dismissal listeners.
    3. Implement `unmount()` that removes the element AND detaches all listeners.
    4. Add CSS rules under a `.anywhere-hover-preview { ... }` block in `webviewHtml.ts` using `--vscode-editorHoverWidget-background` / `--vscode-editorHoverWidget-border` / `--vscode-editorHoverWidget-foreground` / `--vscode-editor-foreground` for theme-awareness.

- [x] 3_3 Shiki renderer — static curated grammar bundle
  - **Deps**: 1_1, 1_1b, 3_2
  - **Refs**: design.md D1 (curated list), D8 (theme map), D11 (no dynamic imports); specs/file-link-hover-preview/spec.md#requirement-popup-rendering--code-files
  - **Scope**: new `src/webview/links/syntaxRenderer.ts`, new `src/webview/links/syntaxRenderer.test.ts`. The throwaway probe from task 1_1b is **replaced** (or absorbed) by `syntaxRenderer.ts`.
  - **Acceptance**:
    - Outcome: `createSyntaxRenderer({ getTheme })` returns `render(content, languageId): Promise<HTMLElement>`. The renderer initialises a singleton `createHighlighterCore` with statically imported grammars: TS, TSX, JS, JSX, JSON, YAML, HTML, CSS, Markdown, Python, Go, Rust, C, C++, Java, Kotlin, Shellscript, SQL, Ruby, PHP — and statically imported themes: `github-light`, `light-plus`, `github-dark`, `dark-plus`. Language IDs outside the curated set fall back to `<pre>`-escaped plain text. The renderer MUST contain ZERO occurrences of dynamic `import(...)` or `require(...)`. Theme selection follows `getTheme()` per D8.
    - Verify: unit `src/webview/links/syntaxRenderer.test.ts` — (a) TypeScript sample → `<pre class="shiki ...">` with token `<span>` children; (b) `plaintext` and unknown lang → `<pre>` text with no shiki classes; (c) the four theme kinds produce different highlighted output for the same sample; (d) **static-import audit**: a grep test asserts the file source contains no `import(` or `require(` calls.
  - **Plan**:
    1. Use `createHighlighterCore` from `shiki/core` plus `createOnigurumaEngine` replaced with `createJavaScriptRegexEngine` from `shiki/engine-javascript`.
    2. Statically import each of the 20 grammars as `import langTypescript from "@shikijs/langs/typescript"` (et al.) and the 4 themes from `@shikijs/themes`. Pass them all in the `langs` + `themes` arrays at construction.
    3. `render(content, languageId)`: normalise `languageId` (e.g. `typescriptreact` → `tsx`); if not in the curated set, return a `<pre>` wrapper with text-escaped content. Otherwise call `highlighter.codeToHtml(...)` with the theme chosen by `getTheme()`; wrap in `<div class="anywhere-hover-preview-code">`.
    4. Manually load `pnpm run watch` and open Extension Development Host with DevTools; hover a code file; assert zero CSP errors in the console (record finding in workflow.md).

- [x] 3_4 Markdown renderer for `.md` (via markdown-it `highlight` callback)
  - **Deps**: 1_1, 3_2, 3_3
  - **Refs**: design.md D1, D8, D12 (no @shikijs/markdown-it); specs/file-link-hover-preview/spec.md#requirement-popup-rendering--markdown-files
  - **Scope**: new `src/webview/links/markdownRenderer.ts`, new `src/webview/links/markdownRenderer.test.ts`
  - **Acceptance**:
    - Outcome: `createMarkdownRenderer({ syntaxRenderer, getTheme })` returns `render(content): HTMLElement` using `markdown-it` initialised with `{ html: false, linkify: false, highlight: (code, lang) => syntaxRenderer.renderHtml(code, lang) }` and `md.validateLink = () => false`. Fenced code blocks call into the shared Shiki renderer from task 3_3 with the current theme. No use of `@shikijs/markdown-it`.
    - Verify: unit `src/webview/links/markdownRenderer.test.ts` — (a) `# Title` renders as `<h1>`; (b) ```` ```ts\nconst x = 1;\n``` ```` produces a Shiki-classed `<pre>` with token spans; (c) raw `<script>foo</script>` markdown is escaped not parsed; (d) Markdown links produce `<a>` elements with NO `href` (and the CSS `.anywhere-hover-preview-md a { pointer-events: none; }` is present).
  - **Plan**:
    1. Add to `syntaxRenderer.ts` a sibling `renderHtml(code, lang): string` (synchronous; assumes highlighter is already initialised — top-level `await` in webview makes this safe).
    2. `const md = new MarkdownIt({ html: false, linkify: false, highlight: (code, lang) => syntaxRenderer.renderHtml(code, lang) }); md.validateLink = () => false;`
    3. Wrap parsed HTML in a `<div class="anywhere-hover-preview-md">` container.
    4. Add CSS in `webviewHtml.ts`: `.anywhere-hover-preview-md a { pointer-events: none; text-decoration: underline; }`.

- [x] 3_5 Wire controller + renderers + theme bridge + lifecycle
  - **Deps**: 1_3, 3_1, 3_2, 3_3, 3_4
  - **Refs**: design.md "Architecture", D10; specs/file-link-hover-preview/spec.md#requirement-lifecycle--disposal
  - **Scope**: `src/webview/main.ts`, `src/webview/links/FilePathLinkProvider.ts`, `src/webview/links/FilePathLinkProvider.test.ts`, `src/webview/terminal/TerminalFactory.ts`
  - **Acceptance**:
    - Outcome: For each link returned by `FilePathLinkProvider.provideLinks`, the controller's `attachHover(link)` is invoked once. Webview's central message router (in `main.ts`) routes `filePreviewResult` → `controller.onMessage(...)` and `themeChanged` → a webview-local theme store (which the controller's `getTheme` reads). On `FilePathLinkProvider.dispose()` (driven by `TerminalFactory.dispose()` on terminal disposal), `controller.dispose()` is invoked. After dispose, a late `filePreviewResult` arrival is silently dropped.
    - Verify: unit additions to `src/webview/links/FilePathLinkProvider.test.ts` — (a) for a fake link list of length 3, assert `controller.attachHover` was called 3 times with the same `ILink` refs; (b) calling `provider.dispose()` calls `controller.dispose()`; (c) after dispose, a posted `filePreviewResult` does NOT mutate the DOM. Manual smoke also covered by task 4_1.
  - **Plan**:
    1. In `FilePathLinkProvider.constructor` accept a `controller: HoverPreviewController` dep; in `provideLinks`, call `this.controller.attachHover(link)` per link before invoking `callback(links)`.
    2. In `FilePathLinkProvider.dispose()` (add it if missing — the class currently has no explicit dispose) call `this.controller.dispose()`.
    3. In `TerminalFactory.ts`, instantiate the controller (passing the renderers + `getTheme`) once per terminal; pass it into the link provider; ensure the factory disposes the provider on terminal disposal.
    4. In `main.ts`, add a webview-local `themeStore = { kind: "dark" as ThemeChangedMessage["kind"] }`; route `case "filePreviewResult"` → `controller.onMessage(msg)`, `case "themeChanged"` → `themeStore.kind = msg.kind`.

## 4. Validation

- [x] 4_1 Manual smoke pass
  - **Deps**: 1_1, 1_1b, 1_2, 1_3, 2_1, 2_2, 2_3, 3_1, 3_2, 3_3, 3_4, 3_5
  - **Refs**: specs/file-link-hover-preview/spec.md (whole file)
  - **Scope**: none (verification only — repo state from prior tasks)
  - **Acceptance**:
    - Outcome: A documented manual run confirms every spec requirement on macOS (the primary dev host). Findings recorded inline in this task.
    - Verify: manual — run `pnpm run check-types && pnpm run lint && pnpm run test:unit`, then open the extension in the Extension Development Host and walk the checklist:
      (1) hover a `.ts` link → popup appears within ~300 ms with syntax-highlighted preview; popup header shows the absolute path;
      (2) hover a `.md` link → popup renders markdown with fenced code blocks highlighted; links inside markdown are not navigable;
      (3) hover, then move cursor off before 300 ms → no popup ever appears;
      (4) hover one link, then immediately hover a different link → only the second popup renders;
      (5) hover a binary file (e.g. an image in the repo) → "Binary file" placeholder with absPath header;
      (6) hover a 5 MB+ file (`stat.size > 1 MB`) → "File too large" placeholder (NOT a truncated preview); confirm via DevTools that the host did not call `readFile` for this URI;
      (7) hover a path that doesn't exist → "File not found" placeholder;
      (8) hover a path outside the workspace (e.g. `/etc/hosts`) → popup renders silently with absPath header; no modal appears;
      (9) toggle VSCode theme through all four kinds (Light → Dark → HighContrastLight → HighContrast) → next hover renders with the corresponding mapped Shiki theme (`github-light`/`github-dark`/`light-plus`/`dark-plus`);
      (10) scroll the terminal while a popup is shown → popup dismisses;
      (11) mousedown anywhere outside the popup while it is shown → popup dismisses;
      (12) press Escape while popup is shown → popup dismisses;
      (13) DevTools console open during all hovers → zero CSP errors;
      (14) close the terminal while a `requestFilePreview` is in flight → no error appears in host logs; no result is delivered to the now-closed webview.
  - **Plan**:
    1. Run `pnpm run check-types && pnpm run lint && pnpm run test:unit`.
    2. Launch Extension Development Host (`F5` or `code --extensionDevelopmentPath=.`).
    3. Walk the 10 checklist items; record pass/fail per item back into this task in the build phase.

- [x] 4_2 Webview bundle size assertion — wire as post-build gate
  - **Deps**: 1_1b, 3_3, 3_4
  - **Refs**: design.md Risk Map "Shiki bundle size"; design.md D11
  - **Scope**: `scripts/check-bundle-size.mjs` (from 1_1b — extend if needed), `package.json` (npm script wiring)
  - **Acceptance**:
    - Outcome: The script created in task 1_1b is wired as a post-build step so any later commit that pushes the bundle over the 3 MB ceiling fails the build. Script targets the actual webview output path `media/webview.js` (not `dist/webview*.js`). Console output prints the actual byte count.
    - Verify: manual — `pnpm run check-types && (existing build command) && node scripts/check-bundle-size.mjs` exits 0 with the current bundle. Then temporarily decrease the ceiling to a smaller value, re-run, and assert exit 1.
  - **Plan**:
    1. Confirm the script from 1_1b targets `media/webview.js` (correct path per `esbuild.js:83-88`). If not, fix.
    2. Add an npm script `"build:check-size": "node scripts/check-bundle-size.mjs"` and chain it from the existing build script as `"build": "... && pnpm run build:check-size"` (do NOT remove existing steps).
    3. Run end-to-end build to confirm the chain works.
