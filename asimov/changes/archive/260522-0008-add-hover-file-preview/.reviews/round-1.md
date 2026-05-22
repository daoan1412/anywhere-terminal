# Round 1 — add-hover-file-preview

- Date: 2026-05-21
- Reviewable lines: ~1100 (after subtracting test files from 1460-line diff)
- Agents spawned: data-security, logic, contracts, frontend
- Agents skipped: none
- Verdict: **BLOCK**
- Counts: 1 BLOCK · 8 WARN · 4 SUGGEST · 5 suppressed-by-priority-cap

## Verification Questions (Phase 1)

1. Is path-resolution safe against traversal/glob-injection from arbitrary terminal output?
2. Memory: 1MB read-into-RAM under hover bursts safe?
3. IPC validation depth sufficient (`typeof string` only)?
4. Token-map race: 3rd request between set + await?
5. Out-of-workspace path exposure via `findFiles`?
6. `_currentTheme` module-scope theme bleed?
7. Forward-declared `let hoverController` TDZ risk?
8. Both controller+popup mousedown listeners — race?
9. Module resolution `Node16 → Bundler` safety?
10. shiki/markdown-it in `dependencies` vs `devDependencies`?

## Findings

### B1 · BLOCK · HIGH · P1 · chair+data-security
- **File**: `src/providers/previewFileLink.ts:181-202` (resolveFirstFile candidate loop), `src/providers/pathResolution.ts:101-105` (currentCwd in sources)
- **Title**: Hover silently previews arbitrary out-of-workspace files via shell-controlled OSC 7 cwd
- **Evidence**: `buildCandidates` includes `currentCwd` (shell-emitted OSC 7/633, attacker-controllable). Click flow gates this via out-of-workspace modal at `openFileLink.ts:472-481`; existing code already documents the OSC-7 attack at `openFileLink.ts:457-462`. Hover flow at `previewFileLink.ts:187-202` walks candidates and returns first hit with NO trust-base check (per design D7). Concrete exploit: a process running in terminal emits `\e]7;file:///\e\\` then prints `etc/passwd`. Hover resolves to `/etc/passwd`, `readFileForPreview` reads up to 200 KB, contents posted to webview popup including `absPath`. Same vector works for `.aws/credentials`, `.ssh/id_rsa` (text portion), `.env`, shell histories, etc. Even without OSC injection, plain absolute paths printed by `cat`/`find` (`/etc/passwd`) preview silently with zero confirmation.
- **Impact**: Hovering arbitrary terminal text exposes file contents from anywhere on the filesystem, with no user consent. Regression of the existing trust boundary that click flow explicitly defends. D7 mitigation ("show absPath header") doesn't prevent disclosure — content is in the popup BEFORE user reads the header.
- **Suggested fix**: Mirror click flow's `bases` check (initialCwd + workspaceFolders only — explicitly NOT `currentCwd`) in `previewFileLink.ts`. When resolved `uri.fsPath` is outside trust bases, return new `out-of-workspace` status (or `not-found`) instead of `ok` + content. Popup shows "Out of workspace — click to open" placeholder without contents.
- **Status**: pending
- **Triage**: (pending user decision)

### W1 · WARN · HIGH · P2 · contracts
- **File**: `src/types/messages.ts:293-330`
- **Title**: `FilePreviewResultMessage` flat-optional shape makes status/content invariant unenforced
- **Evidence**: `content`, `languageId`, `isMarkdown`, `truncated`, `totalBytes`, `totalLines`, `absPath` all top-level optional. Invariant ("`ok` has content, `binary`/`too-large` don't") only in JSDoc, not in the type system. Consumer switching on `status` must use non-null assertions or risk runtime undefined access.
- **Impact**: Future consumers will introduce bugs or `!` assertions. Fixing later is a breaking schema change.
- **Suggested fix**: Replace with discriminated union on `status` — `ok` variant requires `content`, `binary`/`too-large` variant requires `absPath`+`totalBytes`, `not-found`/`ambiguous`/`error` variant has only base fields.
- **Status**: pending

### W2 · WARN · HIGH · P2 · logic
- **File**: `src/webview/links/markdownRenderer.ts:21, 32-39`
- **Title**: Module-scope `_currentTheme` mutable across all terminals — fragile, breaks silently if markdown-it ever introduces async
- **Evidence**: `let _currentTheme: HoverPreviewThemeKind = "dark"` is module-scope. `renderMarkdownElement` writes it then synchronous `md.render()` reads via closure. Today safe because JS single-threaded + `md.render` sync. Two terminals with different themes rendering in same tick: each sets `_currentTheme` before its own render, so today no bleed. But pattern is fragile — a future markdown-it plugin or Shiki API change introducing `await` would silently corrupt themes between terminals.
- **Impact**: Latent fragility. A future dependency upgrade could silently produce wrong syntax-highlight colors with no error.
- **Suggested fix**: Pass `theme` directly into the `highlight` callback via per-call closure: build a per-render `md` instance with theme captured in closure, OR thread `theme` through a per-render context.
- **Status**: pending

### W3 · WARN · HIGH · P2 · data-security
- **File**: `src/providers/TerminalViewProvider.ts:415-421`, `src/providers/TerminalEditorProvider.ts:323-331`
- **Title**: IPC validation accepts unbounded path strings and embedded NUL bytes
- **Evidence**: Both handlers gate `requestFilePreview` on `typeof === "string"` only. No length cap, no NUL rejection, no shape validation. Multi-megabyte hover path flows into `expandTildeAndFileUri` → `path.resolve` → `vscode.Uri.file` → `findFiles` with `escapeGlob(path)`. A giant glob runs a workspace-wide scan. NUL in non-`file://` path bypasses `pathPreprocess.ts:37` guard.
- **Impact**: Cheap webview-to-host DoS / log-injection vector. Single-in-flight token map caps but doesn't eliminate.
- **Suggested fix**: Reject `path.length > 4096`, reject `path.includes("\x00")`, reject `requestId.length > 128` or `sessionId.length > 128`.
- **Status**: pending

### W4 · WARN · HIGH · P2 · frontend
- **File**: `src/webview/links/syntaxRenderer.ts:166-180`
- **Title**: `renderHtml` falls back to plain `<pre>` when highlighter isn't yet cached — first hover before preload completes shows unstyled text
- **Evidence**: `renderHtml()` does `void getHighlighter();` (discards promise) then checks `if (!highlighterSync || !lang)`. Under normal conditions `preloadSyntaxHighlighter()` resolves before first hover, but on slow machines or with preload failures, the first N hovers always show plain text with no loading indicator.
- **Impact**: User experiences jarring "first hover ugly, second hover styled" behavior. Indistinguishable from a bug.
- **Suggested fix**: Either (a) expose `isReady()` and have the controller delay showing the popup until highlighter resolves, or (b) make `renderHtml` async and have the popup re-render once it resolves. Document the intentional silent-degrade if (b) is too invasive.
- **Status**: pending

### W5 · WARN · MEDIUM · P3 · data-security
- **File**: `src/providers/readFileForPreview.ts:78-83`
- **Title**: TOCTOU between `stat` and `readFile` can bypass the 1MB hard limit
- **Evidence**: `stat` first returns size (e.g. 100 KB). Between stat and `readFile`, a symlink swap or file truncation/expansion can produce a 1 GB content. `fs.readFile` (via VSCode API) doesn't accept a max-size param; whatever the inode now points to gets read. Subsequent slice to 200 KB doesn't help — the memory blow-up already happened.
- **Impact**: Adversarial symlink scenarios can cause memory blow-up. Not exploitable for data exfiltration (content still sliced to 200 KB before posting). Sustained-hover with large files across N split panes also amplifies memory pressure.
- **Suggested fix** (small): After `readFile`, assert `raw.byteLength <= HARD_LIMIT_BYTES` and bail to `too-large` otherwise. (Bigger fix: switch to `fs.promises.open()` + `fh.read(buf, 0, PREVIEW_LIMIT_BYTES, 0)` for true partial reads — out of scope here.)
- **Status**: pending

### W6 · WARN · MEDIUM · P3 · logic
- **File**: `src/providers/TerminalViewProvider.ts:208-225`, `src/providers/TerminalEditorProvider.ts:130-150`
- **Title**: `cancelPreviewToken` disposes the CTS eagerly — `readFileForPreview` may still be awaiting `fs.readFile` with a stale token reference
- **Evidence**: `cancelPreviewToken` does `prior.cancel()` then `prior.dispose()`. Meanwhile a superseded `readFileForPreview` still holds `source.token` and checks `token.isCancellationRequested` between awaits. Accessing properties on a disposed token is an undocumented contract (VSCode currently safe, but assumption not enforced). The token-map race itself is safe (`finally` only deletes if still ours).
- **Impact**: Latent fragility on undocumented VSCode behavior. Could surface as silently swallowed exceptions on a future VSCode version.
- **Suggested fix**: Defer `dispose()` to the owning `handleRequestFilePreview` finally block. `cancelPreviewToken` should only `cancel()` + delete from map, not dispose. The finally always owns its own source — clear ownership.
- **Status**: pending

### W7 · WARN · MEDIUM · P3 · contracts
- **File**: `package.json:444-449`
- **Title**: shiki/@shikijs/langs/@shikijs/themes/markdown-it placed under `dependencies` inflate published `.vsix`
- **Evidence**: Libraries are statically bundled into `media/webview.js`; never `require()`-d at runtime. vsce includes `dependencies` trees in `.vsix`, strips `devDependencies`. `shiki@^4.1.0` + companions contains hundreds of TextMate grammar JSON files (typically 5-20 MB unpacked).
- **Impact**: Published `.vsix` carries `node_modules` subtrees as dead weight, increases marketplace download size for every user.
- **Suggested fix**: Move `shiki`, `@shikijs/langs`, `@shikijs/themes`, `markdown-it` from `dependencies` to `devDependencies`. `@types/markdown-it` is already correctly placed.
- **Status**: pending

---

## Suppressed by priority cap (kept for future rounds)

### W8 · WARN · MEDIUM · P4 · contracts (suppressed)
- **File**: `src/providers/TerminalEditorProvider.ts:278-286`
- **Title**: `requestCloseSplitPane` casts through `unknown` because the message type union may not include `sessionId` on that variant
- **Suggested fix**: Add `sessionId: string` to `RequestCloseSplitPaneMessage` interface so both providers can use typed access without casts.
- **Status**: pending

### W9 · WARN · MEDIUM · P4 · logic (suppressed)
- **File**: `src/webview/links/HoverPreviewController.ts:268-294`
- **Title**: `windowListenersAttached` guard prevents re-attach after xterm DOM replacement; detach uses live `terminal.element` not the attach-time reference
- **Suggested fix**: Store `attachedRoot` reference at attach time, use that for detach.
- **Status**: pending

### S1 · SUGGEST · MEDIUM · P4 · data-security (suppressed)
- **File**: `src/providers/previewFileLink.ts:241-262`
- **Title**: `findFiles` for bare filename matches arbitrary same-named files anywhere in workspace
- **Suggested fix**: Skip `findFiles` for bare filenames without separators AND no extension (`passwd`, `Makefile`).
- **Status**: pending

### S2 · SUGGEST · HIGH · P5 · data-security (suppressed)
- **File**: `src/providers/previewFileLink.ts:329`
- **Title**: `absPath` echoed verbatim to webview — leaks home directory/username for any hovered file
- **Suggested fix**: Tied to B1 fix — redact when out of trust bases.
- **Status**: pending

### S3 · SUGGEST · MEDIUM · P5 · contracts (suppressed)
- **File**: `src/providers/TerminalViewProvider.ts`, `src/providers/TerminalEditorProvider.ts`
- **Title**: `_previewTokens` + `cancelPreviewToken` + `cancelAllPreviewTokens` duplicated verbatim across two providers
- **Suggested fix**: Extract `PreviewTokenManager` into shared helper module.
- **Status**: pending

## Session IDs

- data-security: `review-add-hover-file-preview-data-security` (agent uuid `a84e146f712f22680`)
- logic: `review-add-hover-file-preview-logic` (agent uuid `aed366c17a3992b4f`)
- contracts: `review-add-hover-file-preview-contracts` (agent uuid `a74b8d3edce986ca6`)
- frontend: `review-add-hover-file-preview-frontend` (agent uuid `a011575a3ef63df30`)
