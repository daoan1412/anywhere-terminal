# Discovery: add-file-tree-git-decorations

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Memory Recall | Done | direct (`bun run asm memory search` + spec reads) |
| Architecture Snapshot | Done | finder subagent |
| External Research | Done | librarian subagent — saved to `docs/research/20260523-vscode-git-decorations.md` |
| Constraint Check | Done | spec reads (file-tree-*, theme-manager, vendoring) |

## Key Findings

### 1. Existing file-tree pipeline (extension side)
- `src/providers/fileTreeHost.ts` is the composable host; `src/providers/fileTreeRpcHandler.ts` answers `request-read-directory` and applies `files.exclude` + gitignore annotations via `getIgnoredPaths`.
- `src/providers/gitIgnoreChecker.ts` is the **only** existing git touch-point — it shells out to `git check-ignore -z --stdin` (1.5 s timeout) to populate `FileEntry.ignored`. No use of `vscode.extensions.getExtension('vscode.git')` anywhere in the repo.
- Wiring of the FileTreeHost into providers lives in `src/providers/TerminalViewProvider.ts`; extension activation is in `src/extension.ts`.

### 2. Existing file-tree pipeline (webview side)
- `FileSystemDataSource.ts:94-140` maps host `FileEntry` → webview `FileNode` and currently copies `ignored` at line 137.
- `Tree.ts` is the generic widget; row rendering is delegated to `ITreeRenderer<T>.renderElement(element, depth, template, matchData?)`.
- `ReadOnlyFileRenderer.ts:51-158` builds the row DOM (chevron / icon / name); already applies `.is-ignored` (line 138). This is the extension point for a `.git-{modified|added|deleted|untracked|conflicted|ignored}` class and an optional badge span.
- CSS lives in `src/webview/fileTree/fileTreePanel.css:30-38`.

### 3. Shared message types
- `src/types/messages.ts:22-38` defines `FileEntry { name, path, kind, ignored? }` — needs an optional `gitStatus?: GitStatus` field, where `GitStatus` is a small union string.
- New RPC: a host→webview push message (`GitStatusChanged`) for incremental deltas after the initial directory load.
- Every host→webview message in this codebase already carries `requestId` + `rootGeneration` (file-tree-rpc spec). New messages MUST follow that convention so `WorkspaceRootChanged` invalidation works.

### 4. VSCode reference behavior (from research doc)
- VSCode's git extension fires `Repository.state.onDidChange` once per status update (`extensions/git/src/repository.ts:2788-2796`).
- Each change is exposed as four arrays: `workingTreeChanges`, `indexChanges`, `mergeChanges`, `untrackedChanges` — all containing `{ uri, status }` where `status` is an enum from `git.d.ts`.
- Letter / color mapping is enumerated in `extensions/git/src/repository.ts:54-149,246-257` and theme colors are `gitDecoration.{modified,added,deleted,untracked,conflict,ignored}ResourceForeground` — all standardized CSS vars (`--vscode-gitDecoration-modifiedResourceForeground`, etc.).
- Parent-folder propagation: VSCode marks each resource decoration with `bubble: true` (except deletions) and uses a `TernarySearchTree.findSuperstr` to roll up to ancestors. Folders are rendered as "dirty" if any descendant has a bubbled decoration.

### 5. Prior decisions to respect (from memory + specs)
- IPC: discriminated-union messages with `requestId` + `rootGeneration`; invalidate on `WorkspaceRootChanged`; debounce coalescing precedent is **100 ms** (auto-reveal).
- Theming: bind to `--vscode-*` CSS variables only; theme switch already handled by MutationObserver on `document.body class` (theme-manager) — no extra JS needed if we use CSS vars.
- Webview owns visibility — host pushes status unconditionally; webview chooses whether to render (auto-reveal pattern).
- Vendoring policy (vscode-list-widget-vendor) exists but vendoring is **not needed** here — we consume the runtime git extension API, not source.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Git extension API client | none | activate `vscode.git`, get API v1, subscribe to `Repository.state.onDidChange`, maintain `Map<absPath, GitStatus>` | New module: `src/providers/gitDecorationProvider.ts` |
| Status delta IPC | host→webview RPC machinery exists | new `GitStatusChanged` push message + initial snapshot piggybacked on `request-read-directory` response | Add 1 message type to `messages.ts`; thread through `FileTreeHost` |
| FileEntry shape | `ignored?` field | `gitStatus?: GitStatus` field | One-line additive type change |
| Webview decoration cache | per-node `ignored` only | per-node `gitStatus` + ancestor "has-dirty-descendant" bit | Extend `FileNode` + post-update walk in `FileSystemDataSource` |
| Renderer badge/color | `.is-ignored` only | `.git-{M,A,D,U,C,I}` row class + optional badge letter span | Extend `ReadOnlyFileRenderer` + CSS in `fileTreePanel.css` |
| Theme colors | `--vscode-list-*`, `--vscode-sideBar-*` | `--vscode-gitDecoration-{modified,added,deleted,untracked,conflict,ignored}ResourceForeground` | CSS-only addition |
| Test coverage | `fileTreeHost.test.ts`, `ReadOnlyFileRenderer.test.ts`, RPC integration | unit-test for status→class mapping, snapshot serialization, parent-propagation walk | 2-3 new test files |

## Options

### Option A — Consume VSCode built-in Git extension API (Recommended)
Get `vscode.extensions.getExtension('vscode.git').activate().getAPI(1)`. Listen to each `Repository.state.onDidChange`. Maintain a `Map<absPath, GitStatus>` keyed off `Change.uri.fsPath` from the four change arrays (precedence: conflicted > deleted > modified > added > untracked > ignored). Debounce a `GitStatusChanged` postMessage at 100 ms. Add `extensionDependencies: ['vscode.git']` in package.json.

**Why recommended:** thinnest implementation (~150 LOC host-side), free multi-root + submodule support, free debouncing (git extension already coalesces), follows the same "consume a built-in extension" pattern VSCode itself recommends for third-party tree views. Theme tinting is free via VSCode CSS variables. The graceful-degradation path is trivial (if `getExtension` returns undefined or `getAPI(1)` throws, we simply don't decorate).

### Option B — Shell out to `git status --porcelain=v1 -z` + watch `.git/HEAD,index`
Reuse the `gitIgnoreChecker.ts` shell-spawn pattern. Run `git status --porcelain=v1 -z` on workspace changes and on a `fs.watch` of `.git/HEAD` + `.git/index`. Parse the porcelain output to a status map.

**Trade-off:** zero dependency on the built-in git extension (works even if user disabled it), but ~3× the code: porcelain parser, debouncer, watcher, multi-root walker, submodule discovery. Cold-start is slower (one process spawn per status check). Stale-output risk during rapid commits. We'd be rebuilding logic VSCode already exposes.

### Option C — Hybrid (try git extension; fall back to porcelain)
Run Option A; if `vscode.git` extension is unavailable or `getAPI(1)` rejects, fall back to Option B.

**Trade-off:** robust against `git.enabled: false`, but doubles the surface area and gives us two code paths to test. The fallback only matters for the ~0.5 % of users who disable the built-in git extension — they already accept "no git features" by doing so.

## Risks

1. **Built-in git extension activation race** — `getExtension('vscode.git')` can be `undefined` at activation. Mitigation: await `.activate()`; if still missing, subscribe to `vscode.extensions.onDidChange` and retry once. No-op gracefully on permanent absence.
2. **Initial-snapshot vs. delta-event ordering** — webview might receive `GitStatusChanged` for a path before the directory containing it has been read. Mitigation: webview keeps a pending-status map keyed by abs path; applied on next FileNode insert.
3. **Stale data after workspace root change** — every git status message must carry `rootGeneration` and be dropped if stale (file-tree-rpc convention).
4. **Large repos** — emitting a per-file delta for every status change in a 50 k file repo would flood the IPC channel. Mitigation: send a single deduped batch per debounce window (100 ms), capped to "all changes in this repo since last batch."
5. **Parent-propagation cost** — walking ancestors for every updated file naïvely is O(depth × changes). Mitigation: maintain a refcount Map on `FileNode` (`dirtyDescendantCount`); increment/decrement on status add/remove; folder is dirty iff count > 0.
6. **CSS specificity collision** — existing `.is-ignored` rule. Mitigation: use a separate `.git-*` class set; combine via cascade only when both apply (ignored AND untracked is possible).
