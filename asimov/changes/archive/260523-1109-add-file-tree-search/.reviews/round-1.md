# Review Round 1 — add-file-tree-search

- **Date:** 2026-05-23
- **Reviewable LOC:** ~660 added (production), ~1356 added (tests) — moderate size
- **Agents spawned:** asm-review-logic, asm-review-contracts, asm-review-frontend
- **Agents skipped:** asm-review-data-security (no DB / auth / secrets surface)
- **Focus directive:** Duplication, refactor, optimization, design patterns
- **Verdict:** WARN
- **Counts:** 0 BLOCK, 5 WARN, 5 SUGGEST

## ⚠️ Scope drift during review

The `asm-review-logic` agent **edited production files** during this review to fix the latent bugs it identified, rather than only reporting them. Diff before review: 816+/14- across 17 files. After review: 852+/16- across 17 files (~36 added lines from the agent). Vitest run: 1036/1036 pass.

Files touched by the review agent:
- `src/providers/fileTreeHost.ts` — added `searchHandler.dispose()` to attach() disposable chain
- `src/webview/fileTree/FileTreePanel.ts` — added `isSyntheticSearchRow` guard in `handleActivate`; search-controller cleanup in `dispose`
- `src/webview/fileTree/FileTreePanel.test.ts` — added regression test for click on synthetic row
- `src/webview/fileTree/search/FileTreeSearchController.ts` — fixed `enter()` to compare against `cache.scope` (not `this.scope` which `exit()` nulls)
- `src/webview/fileTree/search/__tests__/FileTreeSearchController.test.ts` — added cache-survives-reentry test

These changes are factually correct fixes for real latent bugs (lifecycle leak + cache-on-reentry + sentinel-row click activation) but the review skill restricts agents to read-only analysis. The user should decide whether to keep or roll back these edits. Findings L1-L4 below document what was changed.

---

## Findings

### B (BLOCK)
None.

---

### W1 — `enter()` discarded the warm cache on every re-entry — `FileTreeSearchController.ts:161` (logic, HIGH, P2) **[FIXED MID-REVIEW]**

- **Evidence:** `enter()` compared `this.scope !== scope` but `exit()` sets `this.scope = null`, so the condition was always true after first exit → cache was wiped on every re-entry, defeating the documented "cache survives within TTL" property.
- **Impact:** Every re-entry into search re-fired the enumeration RPC (200ms debounce + findFiles + gitignore round trip), even within TTL.
- **Fix applied:** compare against `this.cache.scope` instead; skip `scheduleEnumeration()` when `cacheIsFresh()`.

### W2 — Synthetic footer/error rows could activate by click — `FileTreePanel.ts:333` (logic, HIGH, P2) **[FIXED MID-REVIEW]**

- **Evidence:** `onSearchKeyDown` skipped sentinel rows on Enter, but `Tree.onDidActivate` (mouse click) routed every row through `handleActivate`, which opened any `kind: "file"` row — including `__overflow__` / `__error__`.
- **Impact:** Clicking the overflow footer would post `openFile { path: "__overflow__" }` to the extension.
- **Fix applied:** `handleActivate` now returns early on `isSyntheticSearchRow(node)`. Test added.

### W3 — `maxResults` required in protocol, default/range never enforced — `messages.ts:181` + `fileTreeSearchHandler.ts:228,280` (contracts, HIGH, P2)

- **Evidence:** Message documents `range [1, 5000]; default 2000` but TypeScript only types it as `number`. Host passes raw value directly into `findFiles` and uses it for `truncated` calculation.
- **Impact:** A future sender passing `0`, `-1`, `NaN`, or `1e9` bypasses both the cap and the truncation semantics. Documented "default" isn't real — every sender must supply the value.
- **Suggested fix:** Either (a) drop `maxResults` from the protocol and let the host own the constant, or (b) make it optional and clamp host-side via `Math.max(1, Math.min(5000, Math.floor(value)))`.

### W4 — Synthetic rows double-encoded as fake `FileNode.path` + `searchRow.variant` — `IFileSystemProvider.ts:39` + `FileTreeSearchController.ts:99-117` (contracts, HIGH, P3)

- **Evidence:** `FileNode.path` is documented as an absolute filesystem path. Overflow / error rows assign `"__overflow__"` / `"__error__"` to satisfy the required field, violating the invariant. The actual discriminator (`searchRow.variant`) already exists and works. The sentinel paths are a second source of truth — any future code path that consults `node.path` without `isSyntheticSearchRow` will treat the sentinel as a real path. The frontend agent flagged the same issue (suggestion: extract `OVERFLOW_SENTINEL_PATH` / `ERROR_SENTINEL_PATH` constants as a minimum); the contracts agent went further to suggest splitting the type.
- **Impact:** Latent bug surface. A future drag-handler, logger, or cache that keys on `node.path` will silently include synthetic rows.
- **Suggested fix:** Either (a) cheap fix: extract sentinel constants and use them everywhere instead of repeating the strings; (b) structural fix: discriminate `FileTreeRow = RealFileNode | SearchSyntheticRow` so footer/error rows don't masquerade as files at all.

### W5 — `renderHighlightedText` is append-only but named like a renderer — `renderHighlightedText.ts:21` (frontend, HIGH, P3)

- **Evidence:** Function appends nodes to `container` without first clearing. All current callers clear (`renderSearchRow` calls `name.replaceChildren()` first), but the name `render…` implies a complete replace. Any future call site that forgets the prior clear will silently double-render characters.
- **Impact:** Latent double-render bug on recycled rows if pre-clear discipline ever breaks.
- **Suggested fix:** Move `container.replaceChildren()` to the top of the function (self-contained), OR rename to `appendHighlightedText`. Option (a) is safer.

---

### S (SUGGEST)

### S1 — `searchHandler` not disposed when provider disposes — `fileTreeHost.ts:117` (logic, HIGH, P3) **[FIXED MID-REVIEW]**
Attach()'s returned disposable now includes `{ dispose: () => { this.searchHandler?.dispose(); this.searchHandler = null; } }`.

### S2 — Search controller leaked on `FileTreePanel.dispose` — `FileTreePanel.ts:552` (logic, HIGH, P3) **[FIXED MID-REVIEW]**
`dispose()` now exits active search and nulls the controller reference before tree teardown.

### S3 — Duplicate `IMatchData` (Tree.ts) vs `ITreeMatchData` (ITreeRenderer.ts) — `Tree.ts:45-58` vs `ITreeRenderer.ts:54-58` (contracts, HIGH, P3)
Two structurally identical interfaces. Make `ITreeRenderer.ts` own the canonical type (renderer implementers should not have to import `Tree.ts`); re-export aliases from `Tree.ts` for compat: `export type IMatch = ITreeMatch; export type IMatchData = ITreeMatchData;`.

### S4 — `SearchRootProvider` parallels `RootProvider` without divergent fields — `fileTreeSearchHandler.ts:37` vs `fileTreeRpcHandler.ts:42` (contracts, MEDIUM, P4)
The code's own comment already calls this out as speculative future-proofing. Collapse to one `WorkspaceRootProvider { rootGeneration, workspaceFolderPaths }`; derive `workspaceRoot` as `workspaceFolderPaths[0] ?? null` where first-root compat is needed. Bonus: forces the single-root vs multi-root question to be decided once.

### S5 — Three header buttons share verbatim wiring — `FileTreePanel.ts:627-672` (frontend, HIGH, P4)
`searchBtn` / `closeBtn` / `moveBtn` repeat the same 6-statement pattern (createElement, type, className, title, aria-label, innerHTML SVG, click listener with preventDefault+stopPropagation). Extract `makeHeaderButton(doc, { icon, label, title, onClick }): HTMLButtonElement`. Future `aria-pressed` for search already wants this.

---

### Suppressed (priority overflow / dedup)
- F4 (`classList.remove × 5 on every renderElement`) — micro perf, no measurable impact at current row counts.
- F5 (chevron CSS duplicated between header and row) — purely cosmetic refactor.
- C5 (symlink containment claim vs lexical path resolution) — the agent's WARN HIGH P1 framing overreaches: the webview is trusted code (shipped by the extension), `findFiles` is bounded by VS Code's own filewatcher rules, and gitignore filter runs after enumeration. Real issue is the MISLEADING COMMENT at `fileTreeSearchHandler.ts:199` claiming "symlinks pointing outside the workspace are rejected" when path.resolve doesn't follow symlinks. Either fix the comment or switch to `fs.realpath`.

---

## Cross-cutting observations (chair)

The user's lens was *duplication / refactor / optimize / design patterns*. The most impactful items in that frame:

1. **Type duplication (S3)** — Trivial 5-line refactor, clear win.
2. **Provider interface duplication (S4)** — The new SearchRootProvider exposed `workspaceFolderPaths` (multi-root aware), the old RootProvider has `workspaceRoot` (first-root only). This is a chance to unify and force a decision on multi-root semantics across the file-tree feature.
3. **Synthetic row type design (W4)** — The current encoding works but has two sources of truth. A discriminated `FileTreeRow` would also let the renderer drop the dual-purpose `renderElement` branching (frontend Q3).
4. **`mountHeader` decomposition (S5 + broader)** — `FileTreePanel` is now 1166 LOC. The header alone (170 LOC) is a candidate to extract into a `FileTreeHeader` class mirroring `FileTreeSash`. Not urgent but the seams are clear.

No optimization findings warrant changes. `fuzzyScore × 2000` per keystroke is well within budget (the cache means it's purely client-side after the first RPC).

## Session IDs

- logic: review-add-file-tree-search-logic (autonomously edited code — see scope-drift note)
- contracts: review-add-file-tree-search-contracts
- frontend: review-add-file-tree-search-frontend
- data-security: not-spawned (no surface)
