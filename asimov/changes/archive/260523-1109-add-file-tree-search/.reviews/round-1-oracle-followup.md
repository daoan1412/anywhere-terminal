# Round 1 — Oracle follow-up

User feedback after the round-1 per-file review: *"code review không hiệu quả"* — too shallow. Spawned 3 oracle agents in parallel for second opinions at different angles (architecture, hidden coupling/debt, simplification). Oracles confirmed: round-1 missed the actual high-impact problems. Below is a fresh ranking — only NEW findings (round-1 stuff not repeated).

---

## TIER 1 — Real bugs round 1 missed

### B1 — Stale `Tree` ref after `remount()` (HIGH, P1)

`FileTreePanel.remount()` disposes `this.tree` and replaces it, but `this.searchController` is NOT cleared. `getOrCreateSearchController()` returns the cached controller, which still holds the disposed Tree it was constructed with.

- `FileTreePanel.ts:491-493` — tree disposed in remount
- `FileTreePanel.ts:820-823` — getOrCreateSearchController returns cached controller
- `FileTreePanel.ts:827-831` — controller construction binds `tree: this.tree` at that moment

After a workspace-folder change or out-of-root reveal (`setRoot`) while search is inactive, the NEXT `enterSearch()` will post results into a disposed Tree → silent failure (no rows render, no error). Triggered by mundane user flow.

**Fix:** Null `searchController` (or call `.dispose()` on it) inside `remount()`, mirroring how the tree itself is disposed there.

### B2 — `persistCurrentState()` clobbers `searchMode` (HIGH, P1)

Two writers, one storage key. `writePersistedSearchMode` does a read-modify-write spread that includes `searchMode`. `persistCurrentState()` does NOT include `searchMode` — it omits the field. Any subsequent expand/collapse/setOpen/setPosition/sash-drag will overwrite the persisted state and DROP the user's saved search-mode preference.

- `FileTreePanel.ts:801` — writes `{...persisted, searchMode: mode}`
- `FileTreePanel.ts:1078-1088` — writes `{open, position, expandedPaths, size}` — no searchMode

**Fix:** Either centralize through one `mergeState(partial)` helper that round-trips searchMode, OR have `persistCurrentState` read the existing persisted state and preserve searchMode explicitly.

### B3 — `revealPath` containment check uses `startsWith` — `/repo2` matches `/repo` (HIGH, P2)

`FileTreePanel.ts:250` — `!absPath.startsWith(this.workspaceRootPath)`. Two workspace folders `/work/repo` and `/work/repo2` both pass the prefix check from `/work/repo`. A reveal of a path in `repo2` walks segments in `repo` instead of triggering the re-root branch.

**Fix:** Use proper path-boundary check, e.g. `absPath === root || absPath.startsWith(root + sep)`.

### B4 — Search Enter posts `sessionId: ""` (HIGH, P3)

`FileTreePanel.ts:920-925` (search Enter handler) — `sessionId: this.deps.getActiveSessionId() ?? ""`.
`FileTreePanel.ts:342-353` (normal handleActivate) — returns EARLY when sessionId is null (no message posted).

Two open-file paths with subtly different host-side behavior. The host's `openFile` handler requires `sessionId`, so the empty-string version may either fail silently host-side or, worse, dispatch to a "first" terminal that doesn't match the user's intent.

**Fix:** Route Enter through `handleActivate(focused)` or extract `openFileNode(node)` and use it from both call sites.

### B5 — `handle()` cancels prior request BEFORE validating new one (LOW, P4)

`fileTreeSearchHandler.ts:178-181` cancels the in-flight token. Lines 186-211 then validate `rootGeneration` and `workspaceFolderPaths`. A stale or out-of-workspace request kills a valid in-flight enumeration before being rejected itself.

**Fix:** Reorder — validate the new request first, only cancel the prior once the new one is accepted.

---

## TIER 2 — Policy / design inconsistencies between modules

### P1 — Out-of-workspace policy inconsistent between browse and search (P2)

- `fileTreeRpcHandler.ts:97-102` — explicitly accepts ANY absolute path for `read-directory`, because the file tree follows terminal `cd` outside the workspace.
- `fileTreeSearchHandler.ts:201-210` — REJECTS any scope outside `workspaceFolderPaths` with `OUT_OF_WORKSPACE`.
- `FileTreePanel.ts:771-777` — webview resolves search scope from `rootNode.path`, which CAN be out-of-workspace (after `setRoot`).

User-visible: navigate via OSC 7 / right-click into an out-of-workspace folder, then click the search icon → search bar appears but never returns results (or shows OUT_OF_WORKSPACE error). Tree itself worked fine in that folder.

**Fix:** Align policies. Either: search also accepts out-of-workspace scopes (use the same `path.resolve` containment-or-not logic the browse handler uses), OR the search icon is hidden / disabled when the current root is out-of-workspace and the panel surfaces a "search not available outside workspace" hint.

### P2 — Exclusion-glob policy inconsistent between browse and search (P3)

- Browse: `files.exclude` only, compiled to basename-regex (`fileTreeRpcHandler.ts:29-35,58-69`)
- Search: `files.exclude` + `search.exclude` combined into a `findFiles` glob (`fileTreeSearchHandler.ts:88-111`)

A file shown in the tree (e.g. matched only by `search.exclude` like a pattern in `*.log`) cannot be found by search. The tree shows it, the search hides it.

**Fix:** Extract one "file-tree visibility policy" and have both handlers consult it. Then decide deliberately: does in-panel search mean "files in the tree" (use files.exclude only) or "files in VS Code Search" (combine both)? Document the decision.

### P3 — `exit()` doesn't cancel host-side work via protocol (P3)

`FileTreeSearchController.exit()` clears local state and `pendingRequestId` but doesn't notify the host. The host only cancels when a NEWER `request-file-tree-search` arrives. Escape / panel close / workspace-root change leaves the host enumeration running to completion (findFiles + gitignore spawn), with the response then dropped on arrival.

For a 2000-file scope this is ~100ms of wasted work. For a slow filesystem / large repo it can be seconds.

**Fix:** Add a `cancel-file-tree-search` message (no requestId echo needed; host cancels whatever is current) OR have `handleRootChanged` route through a host-side cancellation. Cheapest: have webview send a synthetic enumeration with a sentinel scope-path that the host validates → fails → cancels current. Cleanest: add the explicit cancel message.

---

## TIER 3 — Structural design (architectural pushback)

### D1 — `Tree<T>` is now two widgets sharing a class (oracle-architecture)

Tree-walk mode AND flat-list mode coexist via `_flatItems` / `_flatMatchData` / `setFlatItems`. Container is stamped `role="tree"` (Tree.ts:249) but flat search rows are rendered as `role="treeitem"` even though they have no parent/child relationships — WAI-ARIA violation under the search-active state.

**Suggested refactor:** Either (a) split into `Tree<T>` + `FlatList<T>` sharing a common lower-level list wrapper, swap which is mounted in the panel body based on search-active state; OR (b) accept the dual-mode and switch the container role to `role="listbox"` (and rows to `role="option"`) during flat-list mode.

### D2 — `FileNode.searchRow` bleeds presentation concerns into filesystem type (already in round 1, but the architectural framing matters)

Combine with: synthetic `__overflow__` / `__error__` paths, dual `FileNode.name` vs `searchRow.relativePath` carrying the same string for match/non-match rows. **Three symptoms of one error**: the row view-model is being modelled as a `FileNode`. Fix the modelling, not each symptom.

**Suggested refactor:** Introduce `FileTreeRow = RealFileRow | SearchResultRow | SearchStatusRow`. Renderer dispatches at row-type level, not via early-return on a discriminator. Synthetic rows lose their fake paths entirely.

---

## TIER 4 — Delete this code (oracle-simplify)

### X1 — `Tree.setFilter()` + `ITreeFilter<T>` is dead production code

- `Tree.ts:41-71, 175-181, 731-747, 1020-1034` — interface + field + method + filter branch in rebuildRows (~90 LOC)
- `Tree.filter.test.ts:1-176` — 176-LOC test file
- Production callers: 0. `rg setFilter\(` only matches tests.

The search controller uses `setFlatItems`, not `setFilter`. The filter API was added speculatively for an earlier design where search would filter in place.

**Action:** Delete entirely. Net savings ~265 LOC.

### X2 — `SearchClock` injection seam duplicates `vi.useFakeTimers()`

`FileTreeSearchController.ts:33-45` (interface) + `:65-68, 132, 150, 238, 253, 266, 303, 315-320` (uses) + the corresponding test setup uses a hand-rolled fake instead of vitest's built-in. Vitest already supports `vi.useFakeTimers()` + `vi.setSystemTime()` + `vi.advanceTimersByTime()` for exactly this scenario.

**Action:** Delete `SearchClock` interface + `defaultSearchClock`. Use `setTimeout`/`Date.now()` directly. Update tests to use `vi.useFakeTimers()`. Net savings ~30 LOC + cleaner tests.

### X3 — `SearchVscodeApi` 6-field surface should be 2

Of the 6 injected fields, only `findFiles` (hits VS Code search) and `getIgnoredPaths` (spawns git subprocess) have meaningfully different test-vs-production behavior. `RelativePattern`, `Uri`, `CancellationTokenSource`, `getExcludeGlob` are all either pure constructors or pure config reads — the handler can import them directly from `vscode`.

**Action:** Shrink `SearchVscodeApi` to `{ findFiles, getIgnoredPaths }`. Inline the rest. Tests inject only the 2 real seams.

### X4 — Search-controller focus pass-through methods

`FileTreeSearchController.ts:275-288` — `focusNext()`, `focusPrevious()`, `getFocused()` are 1-line forwarders to `tree.focusNext()` etc. `FileTreePanel.ts:904-923` calls them, but the panel also owns `this.tree` directly.

**Action:** Delete the three forwarders. `FileTreePanel` calls `this.tree.focusNext()` etc. directly. Net savings ~15 LOC + a slimmer controller interface.

### X5 — `isSyntheticSearchRow` exported but only used in two `FileTreePanel.ts` callsites

Exposing this from the controller couples panel click/keyboard logic to controller internals. Inline as a local helper in `FileTreePanel`.

### X6 — `matching.ts` exports `scoreOne` + `isEmptyQuery` only for tests

Production only calls `scoreAndSort`. Make the other two private and test them indirectly via `scoreAndSort`.

---

## What round 1 got right vs missed

**Got right:** Type duplication (`IMatchData` vs `ITreeMatchData`), provider duplication (`RootProvider` vs `SearchRootProvider`), `renderHighlightedText` append-only naming, header button boilerplate × 3, the `maxResults` unenforced contract, the synthetic-row dual encoding (cheap framing).

**Missed (oracle caught):**
- 5 real bugs (B1-B5) — stale tree ref, searchMode clobbering, startsWith containment, sessionId fallback, cancel-before-validate
- 3 policy inconsistencies (P1-P3) — out-of-workspace, exclusion globs, no cancel-on-exit
- ~265 LOC of dead `setFilter`/`ITreeFilter` code
- ~30 LOC of needless `SearchClock` indirection
- ~4 of the 6 fields in `SearchVscodeApi` are ceremony
- The architectural framing: `Tree<T>` is two widgets, `FileNode` is the wrong row type

**Why round 1 missed them:** Per-file specialists optimized for catching obvious anti-patterns in isolation. Cross-module state (controller↔tree lifetime, two writers to one persisted key) and cross-handler policy drift (browse vs search) needed the wider lens. The oracle's "find what's missing" framing surfaced them naturally.

## Updated verdict

REJECT round-1 — at least B1 (stale Tree ref) and B2 (persisted state clobbering) should be fixed before merge. Several P-tier items deserve a documented decision, not silent inconsistency. Deletion candidates (X1-X4) are net wins worth ~310 LOC removed.

## Session IDs (Oracle round)

- oracle-architecture-add-file-tree-search
- oracle-debt-add-file-tree-search
- oracle-simplify-add-file-tree-search
