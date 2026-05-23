# Review Round 1 — port-vscode-async-data-tree

- **Date (UTC):** 2026-05-23
- **Reviewable lines:** ~5,919 (excluding `src/vendor/vscode/**`, `asimov/changes/**`, docs, media bundle artifacts) — large change, accuracy may decrease
- **Diff base:** `git diff HEAD` (uncommitted working tree)
- **Agents spawned:** data-security, logic, contracts, frontend (all 4)
- **Agents skipped:** none
- **Verdict:** **BLOCK** — one HIGH-confidence memory leak in `Tree<T>` must be fixed before ship
- **Counts:** 1 BLOCK · 4 WARN · 3 SUGGEST · 4 suppressed (over 8-finding cap)

---

## Findings

### B1 — `Tree<T>` maps unbounded growth on `collapse()` / `refresh()`

- **Severity:** BLOCK · **Confidence:** HIGH · **Priority:** P1
- **Agent:** logic
- **File:** `src/webview/fileTree/Tree.ts:513-527` (`collapse`), `534-551` (`refresh`)
- **Status:** pending
- **Triage:** pending

**Evidence:**
`collapse()` flips `node.expanded = false` and clears `childrenPromise` only. `refresh()` clears `node.children` and `node.childrenPromise` only. Neither walks the cleared sub-tree to remove descendants from `this.nodes`, `this.parents`, or `this.elementToRowDom`. The data source side worsens this: `FileSystemDataSource.getChildren` constructs FRESH `FileNode` objects on every call (`src/webview/fileTree/FileSystemDataSource.ts:89-96` — `entries.map((e) => ({ name, path, kind, ignored }))`), so the identity-keyed cache lookup `if (!this.nodes.has(child))` in `Tree.loadChildren` (Tree.ts:748) ALWAYS misses for the freshly-constructed objects on re-expansion. Each expand adds new entries; previous entries are orphaned but never deleted. Only `setInput` (re-root) and `dispose` fully clear these maps.

**Impact:**
In a long-running session, a user who repeatedly expands a directory, collapses it, and re-expands (or anything that calls `refresh()`) accumulates O(visible-children × cycles) dead `Map` entries indefinitely. For a 1,000-file directory browsed 50 times this is ~50,000 stale `NodeState` + `parent` + DOM-ref entries, preventing GC of the underlying `FileNode` objects. WAI-ARIA helpers iterate over a progressively-larger `elementToRowDom`, so per-event cost also grows.

**Suggested fix:**
In `collapse()`, recursively walk `node.children` (the cached value before clearing) and for each descendant call `this.nodes.delete(d); this.parents.delete(d); this.elementToRowDom.delete(d);`. Same recursive purge at the top of `refresh()` BEFORE clearing `node.children`. Alternatively, dedupe `FileNode` identity inside `FileSystemDataSource` by maintaining a `path → FileNode` cache so reloads reuse the same object (bounded by total-files-ever-seen rather than total-loads).

---

### W1 — Header button has no visible keyboard focus indicator (WCAG 2.4.7)

- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P2
- **Agent:** frontend
- **File:** `src/webview/fileTree/fileTreePanel.css:149-155`
- **Status:** pending
- **Triage:** pending

**Evidence:**
The defensive outline-kill rule uses the descendant selector `.file-tree-panel *:focus, .file-tree-panel *:focus-visible { outline: none !important; }`. This universal descendant selector matches the move-file-tree `<button class="file-tree-header__btn">` (the only interactive control in the panel header) with `!important`, suppressing even the browser default `:focus-visible` ring. No replacement focus indicator is defined for `.file-tree-header__btn:focus-visible` — only `:hover` and `:active` get styled.

**Impact:**
Keyboard-only users who Tab into the panel see no visible focus on the header button. Fails WCAG 2.4.7 Focus Visible. The kill rule was introduced to suppress orange `active-pane`/list-row outlines but was scoped too broadly.

**Suggested fix:**
Narrow the kill-list to the exact selectors that need it (`.monaco-list:focus`, `.monaco-list-row.focused`, `.split-leaf.active-pane`) — drop the `.file-tree-panel *:focus`/`*:focus-visible` lines. Add an explicit `.file-tree-header__btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }` rule.

---

### W2 — `anywhereTerminal.ctx.revealInFileTree` missing `commandPalette` hide entry

- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P2
- **Agent:** contracts
- **File:** `package.json:259` (declaration), `~382-447` (commandPalette block)
- **Status:** pending
- **Triage:** pending

**Evidence:**
Every other `ctx.*` command (`ctx.clearTerminal`, `ctx.newTerminal`, `ctx.killTerminal`, `ctx.closePane`, `ctx.splitVertical`, `ctx.splitHorizontal`) has an entry under `menus.commandPalette` with `when: "false"` to hide it from the palette. The new `anywhereTerminal.ctx.revealInFileTree` does not. It is declared as a webview/context command (line 362 uses `webviewSection == 'splitPane'`), so invoking it from the palette cannot work — no `webviewSection` context is in scope outside the menu.

**Impact:**
Command appears in the VS Code command palette as "Reveal in File Tree" but no-ops or errors when invoked there. Contract regression vs. the established `ctx.*` pattern.

**Suggested fix:**
Add `{ "command": "anywhereTerminal.ctx.revealInFileTree", "when": "false" }` to the `commandPalette` array in `package.json`.

---

### W3 — OSC 7 handler stores unsanitized cwd payload

- **Severity:** WARN · **Confidence:** MEDIUM · **Priority:** P3
- **Agent:** data-security
- **File:** `src/webview/terminal/TerminalFactory.ts:382-401`
- **Status:** pending
- **Triage:** pending

**Evidence:**
After URL-decoding the OSC 7 payload, the handler writes `instance.cwd = decoded` with no validation. Existing `src/pty/processCwd.ts:74-98` `sanitize()` rejects control bytes (`\x00-\x1f\x7f`), ` (deleted)` suffixes, and non-absolute paths — that hardening is bypassed on the webview-frontend ingestion path. Any process running in the PTY (including remote SSH or potentially-malicious binaries) can emit `\e]7;file:///etc\x07` or arbitrary control characters and set `instance.cwd` to that.

**Impact:**
`instance.cwd` is consumed by `main.ts` as the fallback for `reveal-in-file-tree` when the extension's `getLiveCwd → getCurrentCwd → getInitialCwd` chain returns null (rare on Linux/macOS, realistic on Windows). Downstream consumer is `fileTreeRpcHandler` which only does `fs.readDirectory` (metadata-only — names + types — never file contents) and `path.resolve` normalizes traversal. Worst case: tree re-roots at a directory the local user can already `ls`. Not a confidentiality breach, but the defense-in-depth gap is worth closing — and a pathological 10 MB OSC payload would bloat the instance.

**Suggested fix:**
Reuse `sanitize()` from `processCwd.ts` (or extract a shared util). Reject when the decoded value is not an absolute path, contains control bytes, or exceeds a sensible length cap (~4 KB).

---

### W4 — Stale-response misrouting after rapid `setRoot`

- **Severity:** WARN · **Confidence:** MEDIUM · **Priority:** P3
- **Agent:** logic
- **File:** `src/webview/fileTree/FileSystemDataSource.ts:105`; `src/webview/fileTree/FileTreePanel.ts:287-290`
- **Status:** pending
- **Triage:** pending

**Evidence:**
`setRoot` disposes the data source and constructs a new one with the unchanged `rootGeneration`. The new instance's `requestCounter` starts at 0. The old in-flight request was already POSTed (`request-1700000000000-0`); if the new instance issues its first request within the same millisecond, the new `requestId` will be the same string. Old response routes through `main.ts` → `handleReadDirectoryResponse` → new data source. `rootGeneration` filter passes (same generation), `pending.get(msg.requestId)` matches the NEW pending entry, and the new request resolves with the OLD payload.

**Impact:**
Directory listing for the previous root populates children of a different-path node in the new tree. Wrong file names/paths shown; clicking a "file" opens a path under the old root. Reachable when user fires `revealPath` twice in rapid succession to different roots.

**Suggested fix:**
Make `requestId` globally unique — e.g. `this.sourceId = crypto.randomUUID()` at construction; `requestId = ${this.sourceId}-${this.requestCounter++}`. Or have `setRoot` bump `rootGeneration` locally so the generation filter rejects in-flight responses from the previous source.

---

### S1 — `git check-ignore --stdin` should use `-z` mode for newline-safe paths

- **Severity:** SUGGEST · **Confidence:** HIGH · **Priority:** P4
- **Agent:** data-security
- **File:** `src/providers/gitIgnoreChecker.ts:80`
- **Status:** pending
- **Triage:** pending

**Evidence:**
`proc.stdin.end(`${absolutePaths.join("\n")}\n`)`. Without `-z`, git splits stdin on newlines. POSIX filesystems legitimately allow `\n` in filenames.

**Impact:**
Not security — spawn is argv-based, no shell, no argument injection vector. Result paths flow back only as boolean "ignored" annotations via string equality on `e.path`. The annotation silently fails for paths containing newlines. Cosmetic / correctness annoyance only.

**Suggested fix:**
`spawn("git", ["check-ignore", "-z", "--stdin"], ...)`. Join input with `\0`; split git's stdout on `\0`.

---

### S2 — Dual-schema `fileTree?` + `fileTreeByLocation?` has no write-side guard

- **Severity:** SUGGEST · **Confidence:** MEDIUM · **Priority:** P4
- **Agent:** contracts
- **File:** `src/webview/state/WebviewState.ts:43-50`
- **Status:** pending
- **Triage:** pending

**Evidence:**
`WebviewState` keeps both `fileTree?` (marked `@deprecated — read-only fallback`) and `fileTreeByLocation?`. `WebviewStateStore.updateState` is a shallow merge — nothing structurally prevents a future caller from writing `updateState({ fileTree: {...} })` and resurrecting the deprecated slot. The "new writes always go to `fileTreeByLocation`" rule is purely a JSDoc comment.

**Impact:**
The dual-schema window widens over time if the legacy slot is accidentally written to, causing read-side ambiguity (which slot wins after divergence).

**Suggested fix:**
Either (a) remove `fileTree?` from the writable `WebviewState` type and introduce a separate read-only `LegacyWebviewState` for migration reads, or (b) add a unit test asserting `getState().fileTree === undefined` after any `updateState(...)` round-trip when `fileTreeByLocation` is present.

---

### S3 — Outline-kill rule also disables `:focus-visible` ring on tree rows

- **Severity:** SUGGEST · **Confidence:** MEDIUM · **Priority:** P4
- **Agent:** frontend
- **File:** `src/webview/fileTree/fileTreePanel.css:144-155`
- **Status:** pending
- **Triage:** pending

**Evidence:**
`.monaco-list:focus .monaco-list-row.focused` is included in the kill-list. Keyboard-arrow navigation moves the `focused` row trait; the focused row relies entirely on the selection background for visibility. The comment at lines 132-143 acknowledges this trade-off, but combined with the universal descendant kill there is no escape hatch for keyboard-only users.

**Impact:**
Selection background suffices when a row IS selected, but a keyed-through-to-empty-panel state has no row-focus indicator. Minor accessibility degradation, by design.

**Suggested fix:**
Add `.monaco-list:focus-visible .monaco-list-row.focused { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }`. `:focus-visible` qualifier ensures mouse-driven workflows don't see the orange ring the comment objects to.

---

## Suppressed (4 — over 8-finding cap)

- SUGGEST · `messages.ts` new message `type` literals use kebab-case while existing ones use camelCase. Stylistic only; agent acknowledged convention-not-bug framing.
- SUGGEST · `IFileSystemProvider.readDirectory` uses inline `import("...").FileEntry` despite a local re-export; trivial type-import polish.
- SUGGEST · `fileTreeRpcHandler.ts:143` propagates raw `err.message` to the webview on `FS_ERROR`; webview is same-origin trusted, no real leak.
- SUGGEST · `ReadOnlyFileRenderer.dragstart` doesn't call `setDragImage(...)`; cosmetic ghost only.

---

## Session IDs (for re-review resume)

- **data-security:** `review-port-tree-data-security` (a28c8e28b50b093d1)
- **logic:** `review-port-tree-logic` (a2ce60ff29494b885)
- **contracts:** `review-port-tree-contracts` (abe56acba82d868ec)
- **frontend:** `review-port-tree-frontend` (a3a85bd56ce45e048)
