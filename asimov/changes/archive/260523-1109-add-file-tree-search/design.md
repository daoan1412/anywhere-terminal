# Design: add-file-tree-search

## Decisions

### D1: Vendor `fuzzyScore` subset ONLY — do NOT vendor `HighlightedLabel`

We import `fuzzyScore` + `createMatches` + the minimal compile-required helpers from `vs/base/common/filters.ts`. We do NOT import `abstractTree.ts`, `FindWidget`, `FindController`, `FindInput`, `InputBox`, `ActionBar`, `Toggle`, OR `HighlightedLabel`. The find-widget closure is ~4.0k LOC; `HighlightedLabel` further drags in hover, icon-label, lifecycle, and DOM observers — none of which we need.

**Rationale**: The earlier change (`port-vscode-async-data-tree`) deliberately chose "Option C-trim" to avoid the find-widget closure. We honor that boundary. `HighlightedLabel` was initially planned to be vendored for parity, but D10 already commits to a 30-LOC inline highlight renderer, so vendoring `HighlightedLabel` would add dependencies for an unused class — pure cost.

**Bundle measurement gate**: After vendoring `filters.ts`, run `node esbuild.js --production` and `node scripts/check-bundle-size.mjs` BEFORE writing any consumer code. If delta exceeds 50 KB, stop and trim further.

**Rejected alternative**: `fzy.js` (13 KB) gives "good enough" file-finder ranking but a different scoring shape (no camelCase weighting, no separator boost). The user asked about applying `/Users/huybuidac/Projects/ai-oss/vscode` — answer: yes for the scorer, no for the widget, no for `HighlightedLabel`.

### D2: Search scope = active folder in tree, NOT workspace-wide

The scope at search-entry time is resolved as:

```
scope = (selection is a folder) ? selection.path : workspaceFolders[0].uri.fsPath
```

We pass this to the extension host as an absolute `scopePath` and use `new vscode.RelativePattern(scopeUri, '**/*${escapedQuery}*')`.

**Rationale**: User explicit request. Also matches mental model — if the user has drilled into `src/webview/fileTree`, searching there returns relevant results without 5000 hits from `node_modules`-adjacent paths. Workspace-root fallback covers "nothing selected" and "first-time use".

**Rejected alternative**: workspace-wide (matches VSCode Explorer) — would surface too many irrelevant results in large repos, and the user gave a clear directional preference.

### D3: Display mode = flat list of `relativePath` strings (pinned format)

When the panel is in search-active mode, the tree widget switches to flat-list mode (`setFlatItems(items, matchDataMap)`). Each row renders **exactly** the `relativePath` string (forward slashes, relative to the active scope folder). No basename/dirname split styling in v1.

**Rationale**: User explicit request for flat display. Pinning the format to `relativePath` removes builder ambiguity flagged by oracle review. Also simplifies highlight rendering — match ranges produced against `relativePath` map directly to the rendered string.

**Constraint**: `setFlatItems(null)` restores the prior tree from the still-cached `setInput(root)` data source — no re-fetch.

### D4: Filter/Highlight toggle semantics tied to scope enumeration (see D11)

Backed by the enumeration strategy in D11 (enumerate up to 2000 files in scope), the two modes mean:

- **Filter mode (default)**: from the enumeration, keep ONLY rows where `fuzzyScore(query, relativePath)` returned non-null. Sort by score desc, tie-break by shorter `relativePath` then alphabetic. Display all matches (no further cap; matches are bounded by the 2000 enumeration cap).
- **Highlight mode**: from the enumeration, render ALL files (up to the enumeration cap). Matched rows sorted to the top by score; non-matched rows alphabetically below them, rendered with `--vscode-disabledForeground` color. Character-level highlights apply only to matched rows.

If the enumeration was truncated (returned exactly 2000), an overflow footer reads `Showing first 2000 files in scope — narrow your scope to see more`.

**Rationale**: Oracle review flagged that the prior "Highlight = ALL files capped at 500" wording was misleading because `findFiles` capping at 500 by `**/*<query>*` would not be "all" in any honest sense. With D11's enumeration strategy, "all files in scope" has a concrete bounded meaning: up to 2000 files actually present in the scope folder.

**Rejected alternative**: Drop Highlight mode for v1 entirely (oracle suggested this). Kept because the user explicitly asked for "Filter + Highlight toggle như VSCode" at Gate 1, and the redefinition above is coherent.

### D11: Enumerate scope ONCE, fuzzy-score client-side, cache by (scope, rootGeneration)

**Backend strategy**: For each search session (entry to exit), the extension host enumerates files in the active scope via `vscode.workspace.findFiles(new RelativePattern(scope, '**/*'), undefined, 2000, token)` — no glob shaped from the query. The webview fuzzy-scores the returned list client-side via the vendored `fuzzyScore`.

**Why not glob-prefilter** (`**/*${query}*`): glob is contiguous-substring matching, but `fuzzyScore` is subsequence matching. Query `"fp"` against `FileTreePanel.ts` would NOT match the glob `**/*fp*` even though it scores well in `fuzzyScore`. Oracle flagged this as a feature-defeating bug in the earlier design.

**Caching**: The webview caches the enumeration per `(scopePath, rootGeneration)`. While the cache is fresh, query changes re-score without RPC. Cache invalidates on:
- `WorkspaceRootChanged` (rootGeneration bump)
- Scope change (user exits search and re-enters with different selection)
- 60 second TTL (defensive against silent fs changes; conservative)

**RPC firing rules**:
- Search ENTRY → fire enumeration once (debounced 200ms in case user types immediately)
- Subsequent keystrokes → no RPC, only re-score
- Mode toggle → no RPC, only re-sort
- Cache miss / TTL expiry → fire enumeration again with the latest query

**Enumeration cap = 2000**: Above this, scope is too large for in-panel search to be useful; user should narrow scope. 2000 paths × ~50 bytes average = ~100 KB payload, fine over postMessage. `fuzzyScore` runs in <30ms on 2000 paths in modern V8.

**Concurrency**: Only ONE in-flight enumeration per webview. New enumeration requests cancel the previous via shared `CancellationTokenSource.cancel()`; the host disposes the prior token in `finally`.

**Rationale**: Eliminates the glob-vs-fuzzy mismatch; turns most keystrokes into a no-RPC client-side re-score; caps payload deterministically; keeps mode-switching instant.

**Rejected alternative**: Per-keystroke `**/*<expanded>*` glob (e.g., `**/*f*p*`). Works for short queries but degenerates for long queries with many wildcards, and `findFiles` performance with multi-wildcard globs is unpredictable on large repos.

### D5: Debounce 200ms + cancellation via requestId

Every keystroke schedules an RPC firing after 200ms idle. A new keystroke clears the prior timer AND, if an RPC was already in flight, the webview ignores its response (matched by `requestId`); the extension host also cancels the underlying `findFiles` via `CancellationTokenSource.cancel()`.

**Rationale**: Avoids spamming `findFiles` on burst typing (1-second word = 5 keystrokes → 1 RPC instead of 5). The 200ms tier feels responsive without amplifying load. Matches VSCode Explorer's debounce tier.

**Rejected alternative**: No debounce — felt sluggish in initial mental model; `findFiles` can take 100-500ms on warm caches, longer cold.

### D6: maxResults = 500, with overflow indicator

Each `RequestFileTreeSearch` carries `maxResults: 500`. The extension host respects this cap. The response carries `truncated: boolean` set to true when `results.length === maxResults`. The webview shows a footer row in that case.

**Rationale**: Below 500, perf is fine in all profiled scenarios (10k-file workspace, 500 matches scored in <20ms). Above 500, ranking quality also degrades because top results are likely already in the first 500 returned. 500 is generous enough that nobody will see the cap during real search.

### D7: Match data passes through `IMatchData` — score ONLY against `relativePath`

We define a project-local `IMatchData = { matches: IMatch[]; score: number }` type, separate from VSCode's raw `FuzzyScore` tuple. The vendored `createMatches` is wrapped in a thin adapter inside `src/webview/fileTree/search/matching.ts` that returns `IMatchData`.

**Scoring target**: We always score `fuzzyScore(query, relativePath)`. We do NOT score against basename separately. Rationale: `fuzzyScore` already weights word starts heavily, so first-char-after-`/` (i.e., basename start) scores well naturally. This avoids range-offset gymnastics that an oracle-flagged "score basename, render highlights on relativePath" approach would require.

**Rationale**: Keeps the public Tree API (`ITreeFilter`, `ITreeRenderer`) free of vendor types. Adapter is the only file that imports from `src/vendor/vscode/vs/base/common/filters.ts` — refactoring or swapping the scorer later is contained. Single scoring target also means a single match-range domain — no offset math, no missed ranges.

### D8: Match navigation handled at the panel level, not inside Tree<T>

The `FileTreePanel` listens for `ArrowDown` / `ArrowUp` / `Enter` / `Escape` keydown events on the search input. ↓/↑ call `tree.focusNext()` / `tree.focusPrevious()` (already public on `Tree<T>` via underlying `List`); Enter resolves the focused element and posts `OpenFile`; Escape calls `panel.exitSearch()`.

**Rationale**: Keeps tree widget renderer-agnostic. The input element keeps focus throughout search (so the user can keep typing), while the visual focus indicator on the result list is driven by `List.focusNext/Previous`.

**Rejected alternative**: Move focus to the list widget on first ↓ press. Rejected because losing focus from the input is jarring — VSCode's tree find keeps focus on the input the entire time too.

### D9: Search state persistence boundary

`searchMode: 'filter' | 'highlight'` is persisted (it's a real user preference). `searchActive: boolean`, `searchQuery: string`, and the current results list are NOT persisted — they are local panel state. On any panel close/reopen or webview reload, search exits and the tree restores to its persisted `expandedPaths` + `position`.

**Rationale**: Persisting query/active across reloads creates a "ghost search" UX where the user re-opens a sidebar and is confused by a stale flat list. The mode is a cheap, sticky preference users expect to survive.

### D10: Highlight rendering uses inline `<span>` injection, not `HighlightedLabel`

We vendor `HighlightedLabel` for parity / future use, but the v1 file-tree row renderer uses a small inline helper `renderHighlightedText(container: HTMLElement, text: string, matches: IMatch[])` that constructs alternating `Text` + `<span class="file-tree-search-match">` nodes directly. The vendored `HighlightedLabel` is too coupled to `IconLabel` for direct drop-in here.

**Rationale**: A 30-LOC inline renderer is simpler than re-wrapping `HighlightedLabel`'s constructor + lifecycle around our existing renderer. The vendored class remains available for future tree decorations.

## Architecture

```
                ┌────────────────────────────────────────────┐
                │ FileTreePanel  (search-active mode)        │
                │                                            │
                │  ┌──────────────────────────────────────┐  │
                │  │ .file-tree-search-bar                │  │
                │  │  <input> [Filter|Highlight] [close]  │  │
                │  └──────────────────────────────────────┘  │
                │  ┌──────────────────────────────────────┐  │
                │  │ Tree<FileNode>  (flat-list mode)     │  │
                │  │  <row class="match">...</row>        │  │
                │  └──────────────────────────────────────┘  │
                └─────────────────┬──────────────────────────┘
                                  │ keydown / input events
                                  ▼
                ┌────────────────────────────────────────────┐
                │ FileTreeSearchController                   │
                │  - debounce, requestId, in-flight tracker  │
                │  - active scope resolution                 │
                │  - calls matching.scoreAndSort()           │
                └─────────────────┬──────────────────────────┘
                                  │ RequestFileTreeSearch (postMessage)
                                  ▼
                ┌────────────────────────────────────────────┐
                │ Extension host                              │
                │  vscode.workspace.findFiles(RelativePattern)│
                │   → FileTreeSearchResponse                 │
                └─────────────────┬──────────────────────────┘
                                  │ FileTreeSearchResponse
                                  ▼
                ┌────────────────────────────────────────────┐
                │ matching.ts  (webview)                     │
                │  - fuzzyScore each path                    │
                │  - sort, attach IMatchData                 │
                │  - hand to Tree.setFlatItems(items, map)   │
                └────────────────────────────────────────────┘
```

## Target Layout (new files)

```
src/
  vendor/vscode/vs/
    base/common/filters.ts                    (subset)
    base/browser/ui/highlightedlabel/
      highlightedLabel.ts                     (full)
      highlightedLabel.css                    (full)
  webview/fileTree/
    search/
      FileTreeSearchController.ts             — debounce, RPC, lifecycle
      matching.ts                             — fuzzyScore adapter, IMatchData
      renderHighlightedText.ts                — inline highlight renderer
    FileTreePanel.ts                          — modified: header + mode switch
    Tree.ts                                   — modified: setFilter + setFlatItems
  providers/
    fileTreeSearchHandler.ts                  — new: extension-host handler
  types/
    messages.ts                               — modified: 2 new message types
  webview/state/
    WebviewState.ts                           — modified: FileTreeState.searchMode
```

## Interfaces

```ts
// src/webview/fileTree/Tree.ts  (additions)

export interface IMatch { start: number; end: number; }

export interface IMatchData {
  matches: IMatch[];
  score: number;
  targetField: 'basename' | 'relativePath';
}

export interface ITreeFilter<T> {
  shouldRender(element: T): boolean;
  matchData?(element: T): IMatchData | undefined;
}

export class Tree<T> {
  // existing API ...
  setFilter(filter: ITreeFilter<T> | null): void;
  setFlatItems(items: T[] | null, matchDataMap?: ReadonlyMap<T, IMatchData>): void;
  focusNext(): void;   // delegates to underlying List
  focusPrevious(): void;
  getFocused(): T | null;
}

// src/webview/fileTree/search/matching.ts

export function scoreAndSort(
  query: string,
  candidates: FileTreeSearchResult[],
  mode: 'filter' | 'highlight'
): Array<{ result: FileTreeSearchResult; matchData?: IMatchData }>;

// src/types/messages.ts  (additions, see file-tree-rpc spec for exact shape)
export interface RequestFileTreeSearchMessage { /* ... */ }
export interface FileTreeSearchResponseMessage { /* ... */ }
export interface FileTreeSearchResult { absolutePath: string; relativePath: string; }
```

## Design Constraints

- **Bundle ceiling**: 3.6 MB (raised by prior change). Hard fail above. Measured delta must stay under 50 KB per this change's spec.
- **Webview CSP**: no dynamic `eval`, no inline `<script>`. Inline DOM construction in `renderHighlightedText` uses `document.createTextNode` and `document.createElement` — both fine.
- **No new npm deps**: we vendor instead. Already-discussed reason: vendoring is auditable, npm deps drag in unknown transitives.
- **Webview ↔ Extension RPC ordering**: the existing `rootGeneration` mechanism (see `file-tree-rpc` spec) MUST cover the new search RPC. Reuse the same mechanism, don't invent a parallel one.
- **Codicons**: `$(search)` and `$(close)` icons. We do NOT have the full codicon font vendored. The existing close/move buttons use inline SVG sprites — extend the same pattern with a search SVG sprite (copied from VSCode's codicon source).

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| `fuzzyScore` tree-shake | Some helpers in `filters.ts` may transitively pull more than expected (charCode, map, Korean normalization helpers) | Vendor task copies the file, runs `pnpm run check-types`, then deletes unreferenced exports until the file compiles. Bundle measurement runs IMMEDIATELY after vendor (task 1_1), not at end. Fail loudly if delta > 50 KB |
| Glob-prefilter feature defeat | Earlier draft used `**/*${query}*` glob which is contiguous-substring, but `fuzzyScore` is subsequence — would have missed `"fp"` → `FileTreePanel.ts` | Fixed by D11: enumerate `**/*` (no query in glob), fuzzy-score client-side. Unit test in 1_2 includes the `"fp"` → `FileTreePanel.ts` case as a contract |
| `findFiles` enumeration perf on huge scopes | Workspace root with 100k files would still need to return 2000 → may take >500ms cold | Cap at 2000, debounce ENTRY by 200ms, cancel superseded enumeration, dispose token in `finally`. Document the cap in overflow footer |
| RPC lifecycle leaks | `CancellationTokenSource` not disposed; controller exit while response in-flight | Host wraps token in `try/finally`-disposes. Controller `exit()` clears pending requestId so late responses drop. Unit tests cover supersede, host-root-change-mid-search, exit-while-pending |
| Cache invalidation race | rootGeneration bumps after enumeration starts; response could be applied to stale tree | Host recheckS `rootGeneration` after `findFiles` returns; if changed, returns `STALE_ROOT`. Webview drops STALE_ROOT response without rendering |
| Tree restore after `setFlatItems(null)` | If we mutate the data source mid-search, restore could be incorrect | Search controller only READS from data source — never calls `refresh()` while search-active. Unit test in 2_3 exits search and verifies selection + expandedPaths match pre-search state |
| Mode toggle re-renders on each keystroke | `setFlatItems` rebuilds rows; toggling Filter↔Highlight requires re-sorting + re-emitting | Memoize `scoreAndSort` result per (query, mode, enumerationVersion). Recompute only when query changes or enumeration is replaced |
| Keyboard event collisions | `ArrowUp` on input element might move text caret if not preventDefault | Bind handler with `event.preventDefault()` whenever Tree handles the key; manual smoke check in 5_1 |
| Codicon SVG drift | Inline-copied SVG sprites from VSCode source may not match current codicon set | One-off copy with provenance comment `// from microsoft/vscode src/vs/base/browser/ui/codicons/codicon-modifiers.css @ <SHA>` |
| Edge cases (unicode, wildcard chars, empty query, folder-name match) | Builder could guess wrong | Specified in `file-tree-search/spec.md` requirement "Search input edge cases"; unit test in `matching.test.ts` covers each case |
| State migration if FileTreeState gains required fields | `searchMode` defaulting to `'filter'` for old persisted state must not break load | Read with `?? 'filter'` fallback; unit test 4_1 loads old shape |
