# Review Record — add-file-tree-fs-watcher · Round 3

**Date:** 2026-05-24
**Reviewer:** oracle (independent, third pass)
**Session ID:** `aa69bab523913b8ab`
**Verdict:** WARN → resolved (APPROVE after fix)
**Counts:** BLOCK 0 | WARN 1 | SUGGEST 0
**Reviewable lines:** ~5500+ (cumulative)

## Scope

Six patches since round-2:
1. Round-2 W2 race fix (in-flight counter)
2. `Tree.rebuildRows` diff splice (eliminates blink #1)
3. `Tree.refresh` skip-intermediate render (eliminates blink #2)
4. `FileTreePanel.revealPath` no focus-steal on `source:'autoReveal'`
5. `Tree.revealElement` bails when row already visible
6. D11 host-side per-directory descendant bucket aggregation

## Findings

### [W-D11] Stale snapshot bucket not cleared when host re-stamps directory as clean — accepted, FIXED in round-3.5
- **File:line:** `src/webview/fileTree/FileSystemDataSource.ts:361-372`
- **Confidence:** HIGH
- **Evidence:** When an unexpanded folder's last dirty descendant got cleaned/deleted, the host's next `readDirectory` re-stamped the directory entry with NO `dirtyDescendantCountsByStatus` (correct — no dirty descendants). The webview's code path `if (e.dirtyDescendantCountsByStatus !== undefined) { set }` had no `else` branch → cached node kept its prior bucket → folder stayed tinted dirty forever (no leaf walks would ever fire for the never-loaded subtree).
- **Impact:** False-positive folder badge persists indefinitely after the dirty state actually cleared. Visible misinformation about repository state.
- **Suggested fix (applied):** Add `else if (e.gitRevision !== undefined)` branch that clears the bucket + sum. The `gitRevision` gate distinguishes "host made an authoritative clean statement" from "no git provider wired" (the latter shouldn't touch the prior cached value — used by tests / non-git folders).
- **Regression tests:** 2 added in `FileSystemDataSource.test.ts`:
  - clear-on-rebump: directory re-listed without bucket clears the prior `{untracked: 3}` snapshot
  - preserve-when-no-provider: directory re-listed without gitRevision keeps the prior `{modified: 1}` value

## Blessed (no changes recommended)

- **W2 race fix** (`FileSystemDataSource.ts:293-309`) — subscribes before read, counts concurrent reads by path, only unsubscribes on last rejection with no cached listing. Root vs subdir + dispose-during-rejection paths handled.
- **Diff splice** (`Tree.ts:69-76` + `:1040-1066`) — `flatRowEquals` covers element + depth + expanded + hasChildren + matchData. No silent stale-render scenarios found.
- **Tree.refresh skip-intermediate** (`Tree.ts:647-659`) — accepts stale-until-response tradeoff; preferable to guaranteed blink. Parent refresh/eviction is the normal deletion path.
- **autoReveal no-focus-steal** (`FileTreePanel.ts:257-265`) — intentional; selection-changing-while-search-focused is less bad than stealing focus from Explorer/editor.
- **revealElement bail** (`Tree.ts:727-737`) — may skip centering a partially edge-visible row, but that matches the no-jarring-movement goal.

## Snapshot/delta ordering note

`gitDecorationProvider.ts:595-606` flushes pending emits before status/bucket reads — reduces stale revision races between snapshot stamping and in-flight delta. D11 inherits this guarantee for the per-directory bucket aggregation.

## Final state

1196/1196 unit tests pass; type-check clean; biome auto-formats clean.
