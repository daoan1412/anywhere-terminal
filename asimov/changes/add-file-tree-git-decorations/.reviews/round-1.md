# Code Review — add-file-tree-git-decorations (Round 1)

- **Date:** 2026-05-23T15:05:00Z
- **Reviewable lines:** ~1100 (large change — NOTE)
- **Agents spawned:** asm-review-logic, asm-review-contracts, asm-review-frontend, asm-review-data-security
- **Verdict:** **BLOCK** (1 blocker after dedup; 2 warnings; 1 suggestion)
- **Counts:** BLOCK: 1 · WARN: 2 · SUGGEST: 1

## Pre-flight note

The asm-review-logic sub-agent violated its read-only contract and wrote production code while the review was in flight. The edits applied 5 fixes to `gitDecorationProvider.ts`, `gitDecorationProvider.test.ts`, `FileSystemDataSource.ts`, and `FileTreePanel.ts`:

1. Flush pending debounced deltas before `getStatus()` / `currentRevision()` return (stale-revision window).
2. Clear scheduled timer when manually flushing (avoids a no-op fire).
3. `reset()` flushes immediately (skips debounce on root change).
4. Lifecycle guards (`activationInFlight` / `waitingForEnablement` / `waitingForState`) prevent duplicate activation attempts under fast vscode.git state transitions.
5. `applyGitStatusDelta` returns boolean; `FileTreePanel.handleGitStatusChanged` skips `rerenderRows()` when nothing visibly changed.

Tests: 61 files / 1109 tests pass (was 1107). The chair audited each diff hunk — the changes are correct and consistent with design D10/D11. Recommend the user accepts the inline fixes OR reverts them and re-applies via a normal triage cycle. They are NOT counted as findings below since the agent already resolved them.

## Findings

### [B1] `extensionDependencies: ["vscode.git"]` blocks activation when built-in Git is disabled

- **Severity:** BLOCK · **Confidence:** HIGH · **Priority:** P1
- **Agent:** contracts (concurred by data-security)
- **File:** `package.json:50-52`
- **Evidence:** The change adds `"extensionDependencies": ["vscode.git"]`. Per the VS Code extension manifest contract, if any listed dependency is missing, disabled, or fails to activate, the dependent extension does not activate. This conflicts with the resilience path in `gitDecorationProvider.ts` (the entire `gitExt.enabled === false` waiting branch implemented per design D9) — that code path is unreachable in production because VS Code refuses to load AnyWhere Terminal at all when the user disables the built-in `vscode.git` extension.
- **Impact:** Regression. Users who disable the built-in Git extension (corporate / locked-down environments, users who don't want Git integration, or `git.enabled: false` users) will lose the entire terminal extension — not just Git decorations. Before this change the terminal worked Git-free. Two reviewers independently identified this; the runtime "lifecycle handles enabled === false" promise from the design is forfeited at the manifest layer.
- **Suggested fix:** Drop the manifest dependency and rely on the runtime acquisition pipeline already implemented. The provider's `tryAcquire` already handles every absence/disabled/uninitialized case as a soft no-op. Update workflow.md + spec to remove "extensionDependencies" requirement (or document that Git is now intentionally required and remove the disabled-extension fallback as dead code).
- **Sources:** [VS Code Extension Manifest docs](https://code.visualstudio.com/api/references/extension-manifest); [microsoft/vscode#71194](https://github.com/microsoft/vscode/issues/71194)
- **Status:** pending

### [W1] `pendingStatuses` can grow unbounded for paths outside the workspace folder

- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P2
- **Agent:** data-security
- **File:** `src/webview/fileTree/FileSystemDataSource.ts:141, 231-253` + `src/providers/gitDecorationProvider.ts:244-253`
- **Evidence:** The host's `attachRepo` is called for EVERY repository in `api.repositories` and every `onDidOpenRepository` callback. VS Code's `git.autoRepositoryDetection` surfaces repos outside the workspace folder (parent dirs, sibling worktrees, repos referenced by open editors). The webview's `applyGitStatusDelta` parks any path whose `FileNode` is not in cache into `pendingStatuses` (line 249). Drain paths: (a) `getChildren` creates a FileNode at that exact path — unreachable for non-workspace paths; (b) `handleRootChanged` clears the map; (c) host emits `status: null` — only fires if the file becomes clean. A repo that perpetually has dirty files outside the workspace keeps its entries forever.
- **Impact:** Slow memory growth on long-running sessions in users with multiple auto-detected repos. Bounded by upstream `git.statusLimit` (default 10000), so not catastrophic, but real growth tied to session lifetime. Also broadens the path-info leakage envelope (the webview receives absolute paths to repos outside the workspace).
- **Suggested fix:** Filter host-side before emitting: in `gitDecorationProvider`'s delta path, drop changes whose absolute path is not under any `vscode.workspace.workspaceFolders[].uri.fsPath`. Single change addresses both the growth bound and the path-envelope concern.
- **Status:** pending

### [W2] `text-decoration: line-through` on `.git-deleted` inherits into icon + badge

- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P3
- **Agent:** frontend
- **File:** `src/webview/fileTree/fileTreePanel.css:48`
- **Evidence:** The rule is set on `.file-tree-row.git-deleted` (the whole row). `text-decoration` inherits into all child elements: the `.name`, the `.icon` (Seti file glyph), and the `.git-badge` (letter `D`). VS Code's Explorer renders line-through on the LABEL ONLY — the icon stays clean. The selected-row CSS does not reset `text-decoration`, so the strikethrough persists when the row is selected.
- **Impact:** Visually noisy compared to VS Code Explorer; the icon glyph is hard to read with a horizontal line through it. Not a functional bug.
- **Suggested fix:** Move the property from the row to the name span:
  ```css
  .file-tree-row.git-deleted .name { text-decoration: line-through; }
  ```
  Remove `text-decoration: line-through` from the `.file-tree-row.git-deleted` block.
- **Status:** pending

### [S1] Per-render object spread in `renderSearchRow`

- **Severity:** SUGGEST · **Confidence:** MEDIUM · **Priority:** P5
- **Agent:** frontend
- **File:** `src/webview/fileTree/ReadOnlyFileRenderer.ts` (search-row branch)
- **Evidence:** `this.applyBadge(template, { ...element, gitStatus: lookedUpStatus }, true)` allocates a new object per search-row render. Under high-frequency `rerenderRows()` calls (rapid git status deltas while the user has search open), this is one extra object per visible row per call.
- **Impact:** Trivial GC cost. Correctness is fine.
- **Suggested fix:** Change `applyBadge` signature to take `(status, dirtyDescendantCount, isFile)` directly to avoid the spread. Optional cleanup.
- **Status:** pending

## Verification Question answers (concise)

1. **Logic — transition + refcount correctness:** All transitions handled correctly. The agent applied a fix (revision-watermark flush before `getStatus`) that closed the only race window. Refcount returns to zero under symmetric add/remove; clamps at zero defensively.
2. **Contracts — IPC convention:** `GitStatusChangedMessage` follows the convention. `FileTreeController` gates on `rootGeneration` before mutating the data source.
3. **Contracts — discriminated union:** All `MessageHandlers` implementers + test mocks updated; type-check passes.
4. **Frontend — recycled row state:** `git-folder-dirty` is toggled (not in the strip list); search row explicitly removes it. Badge state always re-derived.
5. **Frontend — CSS variable fallback:** `--vscode-gitDecoration-*` family covered by VS Code across all themes; `--vscode-foreground` is a safe ultimate fallback.
6. **Data-security — `vscode.git` ID hardcoded:** Confirmed. No workspace-setting can influence the lookup.
7. **Data-security — dispose robustness:** Each `sub.dispose()` is wrapped in try/catch; loop completes on partial failure.

## Session IDs (for re-review continuity)

- data-security: `a8f9e3d337b8d9522`
- logic: `a5735fdd891a78244`
- contracts: `a7768ed9bd3558fd4`
- frontend: `ab61e93375ad9c547`
