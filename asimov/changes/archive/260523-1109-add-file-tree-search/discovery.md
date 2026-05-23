# Discovery: add-file-tree-search

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Architecture Snapshot (file tree code surface) | Done | finder subagent |
| External Research (VSCode find widget + fuzzy libs) | Done | librarian → `docs/research/20260523-file-tree-search-mechanisms.md` |
| Prior research recall | Done | memory search + read archive `260523-0214-port-vscode-async-data-tree` |
| Constraint Check (bundle, deps, theme) | Done | direct read of package.json + check-bundle-size.mjs |

## Key Findings

### 1. We DO NOT have VSCode's tree find widget — only the list widget

Previous change (`260523-0214-port-vscode-async-data-tree`) deliberately took the **Option C-trim** path: vendor only `vs/base/browser/ui/list/`, hand-roll a thin `Tree<T>` on top, and explicitly **skip** everything `abstractTree.ts` pulls in (find widget, hover, contextview, actionbar, toggle, inputbox, findinput). The tree find widget closure is ~4.0k LOC with direct UI deps (`findInput` 421, `inputBox` 841, `actionbar` 678, `toggle` 523, `highlightedLabel` 164, `filters.ts` 950).

Implication: porting the full widget would re-litigate that decision and re-blow the bundle ceiling. Vendoring **just the scorer + match-highlight helpers** is still cheap and on-brand.

### 2. Header has a natural insertion point already

`FileTreePanel.ts:529-621` already renders a header with `.file-tree-header__root` (left: chevron + workspace name) and `.file-tree-header__actions` (right: move + close icon buttons). A search icon button drops into `.file-tree-header__actions` with zero structural change. State-mode toggle replaces the root row's text-label with an `<input>` styled via `--vscode-input-*` CSS vars.

### 3. `Tree<T>` has no filter plumbing

Tree's public API (`setInput`, `expand`, `collapse`, `refresh`, etc.) does not expose `setFilter` or any predicate hook. Filtering must be implemented at the **flattened-rows layer** inside `rebuildRows()` (Tree.ts L789) — either by wrapping the `ITreeDataSource` or by adding a `setFilter(predicate, query)` method on Tree itself. The latter is cleaner: filter sees the same data shape, no double-cache.

### 4. VSCode's find widget has two orthogonal modes worth knowing about

- **Filter mode** (default for Explorer): non-matching rows hidden; matching ancestors stay visible as "phantom parents".
- **Highlight mode**: tree shape preserved; matched substrings wrapped in `<span class="highlight">` via `HighlightedLabel`. Also pairs with a `CountBadge` on parents showing match counts.
- Two toggles: **Fuzzy ↔ Contiguous**, **Filter ↔ Highlight**. Common find toggles (case/whole-word) are **not** offered — fuzzy/contiguous is the real axis.

For v1 we don't need both modes. Filter mode is what people expect from a search icon click.

### 5. Search scope: visible subtree vs full workspace

VSCode Explorer's Filter mode delegates to `searchService.fileSearch()` with globs like `**/${pattern}` — i.e., it searches the **whole workspace**, not just expanded folders, then mounts "phantom parents" to show matches deep in collapsed subtrees.

We don't have a search service. Our options:
- **(a) Loaded-subtree only**: filter only nodes already loaded via `IFileSystemProvider.readDirectory`. Cheap, immediate, but misses files in unexpanded folders.
- **(b) Workspace-wide via extension host**: post `RequestFileTreeSearch` message, extension host runs `vscode.workspace.findFiles(glob, exclude, maxResults)` and returns paths. Matches VSCode Explorer parity.
- **(c) Hybrid**: filter loaded nodes immediately for instant feedback; after debounce, also fire workspace-wide RPC and merge.

### 6. Fuzzy algorithm landscape

| Algorithm | Type | Size | Behavior |
|---|---|---:|---|
| VSCode `fuzzyScore` (`filters.ts`) | DP subsequence aligner | ~950 LOC (tree-shake to ~300) | Rewards word starts, separators, camelCase, contiguous runs |
| `fzy.js` (npm) | fzy scoring | 13.3 KB unpacked | Word-start/separator biased; smallest |
| `fuzzysort` (npm) | Sublime-style | 45.6 KB unpacked | Prepared targets, fastest for repeated queries |
| `fuse.js` (npm) | Bitap | ~300 KB unpacked | Multi-key, "search engine" — overkill |
| Hand-roll | Subsequence | ~100 LOC | Smallest, fully custom |

For 10k visible items, all four fuzzy options score in <16ms; the differentiator is **ranking quality** (word-start bias for paths) and **bundle cost**.

### 7. Bundle headroom

Current ceiling raised to 3.6 MB in the vendor change. Post-vendor delta budget allowed up to 450 KB. Adding `fzy.js` (≤4 KB tarball) or porting `filters.ts` fuzzyScore (~10-15 KB after tree-shake) sits well within remaining room.

### 8. Theme & state plumbing exist

`WebviewState.FileTreeState` is already additive — `searchTerm?: string` and `searchActive?: boolean` can be added without migration. CSS variables `--vscode-input-background`, `--vscode-input-foreground`, `--vscode-input-border`, `--vscode-inputOption-activeBackground`, and `--vscode-list-filterMatchBackground` (the match-highlight background) are all available since the panel already follows VSCode theming.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Search icon button | `move`/`close` icon buttons in header actions | One more icon (`$(search)`) | ~20 LOC + CSS |
| Header→input mode switch | static title row | swap title for `<input>` on click | mode flag on `FileTreePanel` + DOM swap |
| Search input UI | `tabRenameOverlay` precedent | inline input in header w/ Escape to dismiss | new component (~80 LOC) |
| Fuzzy scorer | none | `(query, label) → score|null + match positions` | port `fuzzyScore` OR add `fzy.js` |
| Tree filter hook | none | `Tree<T>.setFilter(predicate, matchData)` | new method + reuse `rebuildRows` |
| Match highlighting in renderer | plain text label | `<span class="match">` for matched chars | port `HighlightedLabel` OR inline 30-LOC helper |
| Persistence | `FileTreeState` (open/position/expandedPaths) | `searchTerm?`, `searchActive?` | extend interface (additive) |
| Workspace-wide search RPC | `RequestReadDirectory` only | `RequestFileTreeSearch` if we go scope (b)/(c) | new message + extension handler |
| Match navigation | none | ↑/↓ to move between matches, Enter to open | new keymap in search-mode |

## Options

### Decision matrix (recommended path bolded)

**Search scope** (what's filterable)

- A1: Loaded-subtree only — instant, no RPC, but misses unexpanded folders
- **A2: Workspace-wide via extension host `findFiles` (Recommended)** — VSCode Explorer parity; uses already-available API; one RPC roundtrip ≤200ms even for large repos
- A3: Hybrid (filter loaded + RPC merge) — best UX, most complexity; defer to v2

**Fuzzy algorithm**

- B1: Port VSCode `fuzzyScore` from `filters.ts` + `createMatches` + minimal `HighlightedLabel` — tree-shake to ~300 LOC, exact VSCode ranking behavior. Consistent with existing vendor strategy.
- **B2: Use `fzy.js` npm package (Recommended)** — 13 KB, 1-file, file-finder-tuned ranking, zero vendoring overhead, easy to swap later
- B3: Hand-roll ~100 LOC subsequence scorer — smallest but we own ranking edge cases
- B4: `fuzzysort` — slightly heavier; prepared-targets caching is nice but our list re-builds anyway

Trade-off: B1 = "vendor-pure" + visual parity with VSCode behavior. B2 = pragmatic + smallest. The user explicitly asked "should we apply VSCode?" — there is a real case for B1 if we value behavior parity, but the existing change archive's stated principle is "skip the find widget closure". Recommending B2 keeps that promise; B1 stays as an upgrade path if v2 wants exact VSCode ranking.

**Filter mode**

- C1: Filter only (hide non-matching, show phantom parents) — simplest, matches expected mental model
- C2: Highlight only — preserves tree shape but click-to-open is awkward when results are mixed in
- C3: Both with toggle — VSCode parity; UI overhead
- **Recommended: C1 (filter only)** for v1, defer C3 toggle to v2 once we know the use-case

**UX mode switch** (per user request — already decided)

- Header transforms: click search icon → root row's title becomes input. Escape or empty-input blur returns to title.
- Icon stays visible (becomes ✕/close-search when active) so users can exit.

**Match navigation**

- ↑/↓: cycle through matches (revealing as needed)
- Enter: open first/focused match
- Escape: exit search, restore tree state

## Risks

1. **Workspace-wide `findFiles` perf on huge repos** — `vscode.workspace.findFiles` respects `.gitignore` and `search.exclude` by default, but worst-case (no excludes, 100k files) can take seconds. Mitigation: cap `maxResults` at 500, add 250ms debounce on input, use cancellation token from the latest keystroke.
2. **Match highlighting cost in renderer** — re-rendering 10k tree rows each keystroke for highlights is wasteful. Mitigation: only render highlights for rows currently in the viewport (listWidget already does virtualization); match-data carried as part of the row template, computed once on filter apply.
3. **Filter scope confusion** — if we go A2 (workspace-wide), search results may show files in folders the user has not expanded. UX answer: in search-active mode, render results as a **flat list** (relative paths) rather than tree, like VSCode Explorer's filter result; switch back to tree on exit.
4. **State persistence of search across panel close/reopen** — current `FileTreeState` is per-location. We should NOT persist `searchTerm` (it's transient); only `searchActive` may be persisted optionally, but cleaner to reset every time the panel closes.
5. **Bundle delta** — `fzy.js` (≤4 KB tarball) is negligible. Porting `fuzzyScore` adds ~10-15 KB. Both fit comfortably within the 450 KB delta budget set by `vscode-list-widget-vendor`.
6. **Search input keyboard shortcuts conflicting with tree navigation** — when input has focus, ↑/↓/Enter should not navigate caret in the textbox. Need to intercept those keys ourselves.

## Open questions for Gate 1

1. **Search scope** — A1 (loaded only), **A2 (workspace-wide, recommended)**, or A3 (hybrid)?
2. **Fuzzy algorithm** — B1 (vendor VSCode `fuzzyScore`), **B2 (`fzy.js` npm, recommended)**, B3 (hand-roll), or B4 (`fuzzysort`)?
3. **Filter behavior** — **C1 (filter-only, recommended)** or C3 (filter+highlight toggle)?
4. **Search-active rendering** — keep tree structure with phantom parents, OR flatten to a list of relative paths during active search?
5. **Apply VSCode source from `/Users/huybuidac/Projects/ai-oss/vscode`?** — recommendation: NO for the find widget (4k LOC closure breaches the vendor-skip decision), YES for the `fuzzyScore` algorithm if we choose B1.
