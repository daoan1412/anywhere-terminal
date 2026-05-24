# Review Record — add-file-tree-fs-watcher · Round 2

**Date:** 2026-05-24
**Reviewer:** oracle (independent, second pass)
**Session ID:** `a7da7304634535e08`
**Verdict:** WARN → resolved
**Counts:** BLOCK 0 | WARN 1 | SUGGEST 0
**Reviewable lines:** ~5500 (cumulative, change start to round-2 review point)

## Scope

Post round-1 fix-loop + new D10 (folder-dirty-color) capability. Validated:
- Round-1 fixes: W1 unsubscribe gen-gate bypass, W2 readDirectory rollback, S1 fanout membership re-check
- New D10 work: per-status descendant buckets + dominant-status renderer + per-kind CSS

## Findings

### [Race] W2 concurrency race in `getChildren` — accepted, FIXED in round-2.5
- **File:line:** `src/webview/fileTree/FileSystemDataSource.ts:280-288`
- **Confidence:** HIGH
- **Evidence:** Two concurrent `getChildren(samePath)` calls share one subscription, but a rejection from either call unconditionally tore the subscription down — killing the watcher the surviving caller needed. The old `subscribedHere`-only gate (computed before `ensureSubscribed`) was too narrow; race window happens whenever `Tree.refresh` overlaps with focus-rehydrate or two FileTreeHosts share a directory.
- **Impact:** Watcher leaks for the surviving caller; subsequent fs events silently lost until next root change / dispose.
- **Suggested fix (applied):** Replace `subscribedHere` gate with per-path in-flight read counter (`inflightReadsByPath: Map<string, number>`). Rollback only when `remaining === 0 && !childrenByParent.has(path)`. +2 regression tests cover both orderings (one rejects + one succeeds; both reject sequentially).

## Blessed (no changes recommended)

- **W1** (`fileTreeHost.ts:284`) — per-host map invariant airtight; unsubscribe gen-gate bypass is safe.
- **D10** (`FileSystemDataSource.ts` + `folderDirtyState.ts` + `ReadOnlyFileRenderer.ts` + `fileTreePanel.css`) — bucket transitions sound for clean→dirty-A, dirty-A→dirty-B, dirty-A→clean across snapshot/delta/pending paths.
- **CSS folder-dirty cascade** — selector ordering ensures folder-dirty colours win at equal specificity.
- **Dispose ordering** — fine assuming VS Code preserves per-webview message order (documented as constraint).
