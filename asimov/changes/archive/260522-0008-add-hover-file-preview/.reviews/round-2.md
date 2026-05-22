# Round 2 — add-hover-file-preview

- Date: 2026-05-21
- Reviewable lines: ~1500+ (NOTE: large change — accuracy may decrease)
- Agents spawned: data-security, logic, contracts, frontend + asm-oracle (independent)
- Agents skipped: none
- Verdict: **BLOCK**
- Counts: 1 BLOCK · 7 WARN · 10 SUGGEST-suppressed

## Round 1 status (verification by round 2 agents)

| ID | Round 1 status | Round 2 verification |
|----|----|----|
| B1 | accepted | **fixed** — `classifyTrust("out-of-workspace")` + `trustBasesFor` excludes currentCwd (verified at `previewFileLink.ts:117-141, 153-164`). HOWEVER, see new B1 below — the Cmd/Ctrl override mechanism designed alongside this fix has its own bypass path. |
| W1 | accepted | **fixed** — discriminated union at `messages.ts:345-383` |
| W2 | accepted | **fixed** — per-render `buildMd(theme)` |
| W3 | accepted | **fixed** — `previewValidation.isValidPreviewRequest` enforces 4096 + NUL + 128 caps |
| W4 | accepted | **fixed** — `whenHighlighterReady` + re-render (introduces W5/F1-FE regression below) |
| W5 | accepted | **partial** — post-read assertion is cosmetic vs memory-bound; re-raised below |
| W6 | accepted | **fixed** — finally owns dispose |
| W7 | accepted | **fixed** — shiki / @shikijs/langs / @shikijs/themes / markdown-it moved to devDependencies |

## Findings

### B1 · BLOCK · HIGH · P1 · oracle
- **File**: `src/webview/links/HoverPreviewController.ts:143-153`, `:415-425`, `:433-454`
- **Title**: Cmd/Ctrl override fires on ANY modifier keystroke during a hover — bypasses trust policy without user-confirmation gesture
- **Evidence**: `shouldTriggerOverride()` (`HoverPreviewController.ts:415-425`) only checks `overrideRequested`, `activePath`/`pendingTimer`, and modifier state. It does NOT require that the current popup result is `requires-confirmation`. Furthermore, `onKeyDown` (`:143-153`) triggers when `event.key === "Meta"` OR `event.metaKey` — so ANY keystroke with the modifier (e.g. `Cmd+C` copy, `Cmd+R`, `Cmd+Tab`) triggers `requestOverride()`. Concrete exploit: (1) attacker process emits `\e]7;file:///etc\e\\` (OSC-7) then prints `passwd`, (2) user hovers `passwd`, (3) user uses Cmd+anything in the same terminal (or simply has Cmd held while moving the mouse) → override fires → host bypasses `classifyTrust` and reads the file. The 300 ms debounce window between hover and result widens the race — override can also fire during debounce, sending a parallel request that races the original.
- **Impact**: Breaks the entire trust-policy + user-consent narrative. The "Press Cmd/Ctrl to preview" placeholder UX is meaningless if Cmd/Ctrl ALSO triggers override for ANY hover, including ones that already passed the trust check. Combined with OSC-7 path injection (which `currentCwd` is still used to resolve in `buildCandidates`), an attacker can leak arbitrary file contents whenever the user happens to use Cmd in the same session.
- **Suggested fix**: Two changes:
  1. Track `activeRequiresConfirmation` (set only after receiving a matching `requires-confirmation` result from the host); only allow override when this is true.
  2. Require `event.key === "Meta"` / `"Control"` exactly (a fresh modifier-key press), NOT `event.metaKey` / `event.ctrlKey` (which fire for ANY keystroke with the modifier held).
  3. Cancel any pending debounce timer when override is posted, so there's only one in-flight request.
- **Status**: pending
- **Triage**: (pending user decision)

### W1 · WARN · HIGH · P2 · data-security
- **File**: `src/providers/readFileForPreview.ts:83-94`
- **Title**: Post-read `byteLength` check is cosmetic — does NOT defend against TOCTOU memory blow-up (round-1 W5 not fully fixed)
- **Evidence**: The "fix" at lines 92-94 runs AFTER `await fs.readFile(uri)` (line 85) has fully completed. `vscode.workspace.fs.readFile` has no max-bytes parameter and returns full file contents. The TOCTOU window between `stat` reporting 100 KB and `readFile` reading what the inode now points to (e.g. a 10 GB file after symlink swap) is unchanged: the read STILL allocates the full buffer before the check fires.
- **Impact**: Adversarial process racing `stat` → `readFile` with symlink swap can cause multi-GB allocation per hover. Sustained hover amplifies. Post-read check only prevents leaking oversize content to IPC — does NOT prevent the memory blow-up itself.
- **Suggested fix**: Use `fs.promises.open()` + `fileHandle.read(buf, 0, HARD_LIMIT_BYTES + 1, 0)` for true partial read with pre-allocated bounded buffer. If out of scope, document explicitly: "limit is content-export bound, not memory bound."
- **Status**: pending

### W2 · WARN · HIGH · P2 · oracle
- **File**: `package.json:102-112` (configuration scope), `src/providers/hoverPreviewSettings.ts:31-36`, `src/providers/previewFileLink.ts:441-444`
- **Title**: `blockSensitive` setting can be overridden by workspace `.vscode/settings.json` — turns security boundary into a project preference
- **Evidence**: `anywhereTerminal.hoverPreview.blockSensitive` has no `scope` declared in `contributes.configuration` (default scope is `window` — overrideable per-workspace). `readHoverPreviewSettings()` reads merged config via `vscode.workspace.getConfiguration().get()` which honors workspace overrides. `previewFileLink.ts:441-444` skips `classifyTrust` entirely when `blockSensitive === false`. Net effect: a malicious or careless workspace can ship `.vscode/settings.json` with `"anywhereTerminal.hoverPreview.blockSensitive": false` to disable the trust policy without any user gesture.
- **Impact**: Security boundary downgrades to project preference. Cloning a hostile repo + opening it as a workspace + hovering a path could leak arbitrary files.
- **Suggested fix**: Add `"scope": "application"` (or `"machine"`) to `anywhereTerminal.hoverPreview.blockSensitive` in `package.json`. In `readHoverPreviewSettings`, use `cfg.inspect("blockSensitive")` and read only `globalValue` / `defaultValue`, ignoring workspace + folder values. Keep `delay` as `window` scope.
- **Status**: pending

### W3 · WARN · HIGH · P2 · oracle
- **File**: `src/providers/previewFileLink.ts:111-118` (classifyTrust no-bases branch), `:134-140` (trustBasesFor)
- **Title**: Trust classification fails OPEN when there are no trust bases — empty-workspace + unknown-session combination auto-previews any absolute path
- **Evidence**: `classifyTrust()` checks out-of-workspace only when `trustBases.length > 0` (line 112). When the user has no folder open AND `getInitialCwd(sessionId)` returns undefined (stale or unknown session), `trustBases = []`, and the out-of-workspace check is skipped — `null` is returned, treating the file as freely previewable. `isValidPreviewRequest` validates shape but does NOT verify the session id is live in the SessionManager registry.
- **Impact**: Hovering an absolute path like `/etc/passwd` in a no-workspace window with a stale/forged session id auto-previews. Same with files outside any conceivable workspace.
- **Suggested fix**: Fail closed. When `trustBases.length === 0`, return `"out-of-workspace"`. Separately, reject `requestFilePreview` for unknown `sessionId` in `TerminalViewProvider` / `TerminalEditorProvider` before resolving.
- **Status**: pending

### W4 · WARN · HIGH · P2 · oracle
- **File**: `src/providers/previewFileLink.ts:299-306`, `:429-445`, `src/providers/readFileForPreview.ts:83-87`
- **Title**: Symlink / reparse targets trusted lexically — `classifyTrust` operates on `uri.fsPath`, not realpath
- **Evidence**: `resolveFirstFile` accepts any non-directory stat (`(stat.type & deps.directoryFileType) !== 0` is the only filter — symlinks pass). `classifyTrust(absPath, ...)` then classifies the LEXICAL path. `readFileForPreview` reads through the symlink. No `FileType.SymbolicLink` check, no realpath resolution.
- **Impact**: Attacker (or careless repo) places a symlink inside a workspace directory pointing to `~/.ssh/id_rsa` or `/etc/passwd`. Hover preview classifies the path as workspace-internal (trusted), reads the symlink target, displays content. Trust boundary fails to follow logical file identity.
- **Suggested fix**: Pass `FileType.SymbolicLink` into deps. In `resolveFirstFile`, after stat, if `(stat.type & deps.symbolicLinkFileType) !== 0`, either (a) reject for hover preview, or (b) use `fs.promises.realpath(absPath)` to resolve target and re-run `classifyTrust` against the realpath.
- **Status**: pending

### W5 · WARN · HIGH · P2 · frontend
- **File**: `src/webview/terminal/TerminalFactory.ts:214-223` + `src/webview/links/HoverPreviewPopup.ts:443-445, 465-479`
- **Title**: Async Shiki re-render destroys active-line highlight + scroll-to-line on first hover (regression of round-1 W4 fix interacting with line-focus feature)
- **Evidence**: `renderCodeWithRefresh` returns plain-text wrapper when Shiki not yet loaded, then schedules async re-render that replaces `el.innerHTML`. Meanwhile `show()` calls `markActiveLine(body, line)` to add `.anywhere-hover-preview-line-active` to the plain-text DOM, then `scrollToActiveLine(root)`. The `whenHighlighterReady().then(...)` later replaces `el.innerHTML` with Shiki output, destroying the old DOM including active-line class. The popup scroll stays at the plain-text offset (typically top), and new Shiki `.line` elements have no active class.
- **Impact**: First hover with a `:line` suffix (e.g. `foo.ts:42`) does NOT scroll to line 42. Self-heals on subsequent hovers (Shiki cached). Documented user-visible feature broken on first use.
- **Suggested fix**: In the `whenHighlighterReady().then(...)` callback, after `el.innerHTML = ...`, re-apply active-line class + re-scroll. Thread `line` through the refresh closure. Apply to both `renderCodeWithRefresh` and `renderMarkdownWithRefresh`.
- **Status**: pending

### W6 · WARN · HIGH · P2 · logic + oracle (merged)
- **File**: `src/webview/links/FilePathLinkProvider.ts:117-131` (false-positive) + `:133-193` (unbounded walk)
- **Title**: Wrap heuristic — (a) false-positive on adjacent unrelated rows when row 1 exactly fills cols; (b) walk-back-and-forward has no row/char cap before concatenation
- **Evidence**: Structural in-path wrap case (a): joins row N and row N+1 when `prevRaw.length === prevTrim.length` (no trailing spaces → "fills the terminal") AND last char of row 1 + first char of row 2 are both path chars. Fires for any adjacent rows where row 1 ends at column width. `user@host:/some/long/dir$` + `-rw-r--r--` → `-` matches `[A-Za-z0-9._\-/\\]` → join. Unbounded walk (b): backward + forward loops continue while `isWrapped || isPathContinuation` with no row count cap; concatenation builds `fullText` BEFORE the parser's `MAX_LINE_LENGTH = 2000` guard. A dense block of full-width hard-wrapped output triggers an O(N) string concatenation per hover.
- **Impact**: (a) Garbage paths emitted, popup shows "File not found" — no data corruption / security, but degraded UX. (b) Sustained hover on long wrapped output allocates large strings per link-provider call. Practical exploit limited but cost is real.
- **Suggested fix**: (a) Restrict structural in-path wrap to rows where row 1 starts with a tool-call prefix `^\s*(?:Update|Read|Write|Edit)\s*\(` OR the joined text starts with `/` / `~` / drive-letter. (b) Cap joined rows at 5-8 and joined characters at 2000-3000 BEFORE concatenation; bail if exceeded.
- **Status**: pending

### W7 · WARN · MEDIUM · P3 · data-security
- **File**: `src/providers/previewFileLink.ts:88-97`
- **Title**: `SENSITIVE_DIR_SEGMENTS` allowlist misses `.terraform`/`.terraform.d`, `.npm`, `.gem`, `.azure` — well-known credential stores
- **Evidence**: Narrowed allowlist covers `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.config`, `.git`, `node_modules` but not:
  - `.terraform.d/credentials.tfrc.json` — Terraform Cloud API tokens (basename has no dot prefix)
  - `.gem/credentials` — RubyGems API key
  - `.npm/_logs` — registry auth headers in error dumps
  - `.azure/`, `.bluemix/`, `.ibmcloud/` — cloud SDK token dirs
- **Impact**: `cat ~/.terraform.d/credentials.tfrc.json` line, hovered, auto-previews — Terraform Cloud API token disclosure if home is workspace-resident.
- **Suggested fix**: Add `.terraform`, `.terraform.d`, `.npm`, `.gem`, `.azure`, `.bluemix` to `SENSITIVE_DIR_SEGMENTS`. Document criterion: "dot-folders vendors deposit raw API tokens into."
- **Status**: pending

---

## Suppressed by priority cap (kept for future rounds)

### F1-CO · WARN · HIGH · P2 · contracts (suppressed)
- **File**: `src/types/messages.ts:377` — `requires-confirmation.absPath?` is `optional` but producer always sets it. Type weaker than actual contract. Fix: make `absPath: string` required.

### F2-FE · WARN · HIGH · P3 · frontend (suppressed)
- **File**: `src/webview/links/HoverPreviewPopup.ts:251` — `role="tooltip"` on popup containing interactive `<input type="number">` violates ARIA. AT users cannot interact with footer. Fix: `role="dialog"` + `aria-label`.

### F2-CO · WARN · MEDIUM · P3 · contracts (suppressed)
- **File**: `src/webview/links/filePathParser.ts:139` — `CLAUDE_LINES_RE` lacks left-boundary anchor. `result:src/foo.ts · lines 42` matches starting at `result:`. Fix: add `(?<=^|[\s'"<({\[])` lookbehind.

### F2-LG · WARN · MEDIUM · P3 · logic (suppressed)
- **File**: `src/webview/links/HoverPreviewPopup.ts:25-37` — `hasAbsPath` return type still permits `string | undefined`. Trivially solved by F1-CO fix.

### O6 · WARN · MEDIUM · P3 · oracle (suppressed)
- **File**: `src/webview/links/FilePathLinkProvider.ts:218-254` — Link range math uses JS string offsets, not xterm cell columns. CJK / emoji / combining marks shift underline geometry. Fix: convert offsets via cell widths, or document ASCII-only geometry.

### F3-DS · SUGGEST · MEDIUM · P4 · data-security (suppressed)
- **File**: `previewFileLink.ts:441-467` — `override:true` bypasses ALL trust gates including OSC-7. Subsumed by B1 above (oracle).

### F4-DS · SUGGEST · MEDIUM · P4 · data-security (suppressed)
- **File**: `pathResolution.ts:27-29` — `hasTraversal` doesn't normalize URL-encoded forms. Latent fragility.

### F5-DS · SUGGEST · MEDIUM · P5 · data-security (suppressed)
- **File**: `previewFileLink.ts:413-415` — Trailing-separator guard is load-bearing for downstream `path.basename` → `escapeGlob` chain.

### F3-FE · SUGGEST · LOW · P5 · frontend (suppressed)
- **File**: `main.ts:293-300` — `onFilePreviewResult` broadcasts to all hoverControllers instead of routing by sessionId.

### F4-FE · SUGGEST · MEDIUM · P4 · frontend (suppressed)
- **File**: `HoverPreviewPopup.ts:418-429` — `.line` query scope on full body could mis-target in markdown with nested code blocks.

## Verification-Question Answers

1. **Sensitive-folder coverage**: NOT enough — see W7 + W4 (symlink lexical trust compounds this).
2. **Override race**: race exists — see B1.
3. **Wrap-heuristic false-positives**: real — see W6.
4. **Discriminated-union exhaustiveness**: type still permits undefined narrowly — see F1-CO + F2-LG (suppressed).
5. **Cancellation lifecycle**: CLEAN (round-1 W6 fix verified).

## Session IDs

- data-security: `af17a084c57c7df66`
- logic: `a77288cedd48fbb12`
- contracts: `a939aec28134cace3`
- frontend: `a7396ad68d6c87389`
- oracle: `a7b588c5d77fd2873`
