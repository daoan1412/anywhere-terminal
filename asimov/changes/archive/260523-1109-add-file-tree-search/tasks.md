## 1. Vendor + IPC foundation

- [x] 1_1 Vendor `fuzzyScore` subset from VSCode `filters.ts` + measure bundle delta
  - **Deps**: none
  - **Refs**: specs/vscode-fuzzy-scorer-vendor/spec.md#requirement-vendored-fuzzyscore-subset; specs/vscode-fuzzy-scorer-vendor/spec.md#requirement-bundle-delta-budget-measured-at-vendor-time; specs/vscode-fuzzy-scorer-vendor/spec.md#requirement-manifest-entries-for-new-vendored-files; design.md D1; docs/research/20260523-file-tree-search-mechanisms.md
  - **Scope**: src/vendor/vscode/vs/base/common/filters.ts (new); src/vendor/vscode/MANIFEST.json
  - **Acceptance**:
    - Outcome: `import { fuzzyScore, createMatches, FuzzyScore, IMatch } from 'vs/base/common/filters'` resolves and `pnpm run check-types` passes; MANIFEST.json gains the new entry with upstream path + SHA matching existing entries; `node esbuild.js --production` succeeds AND `node scripts/check-bundle-size.mjs` passes AND measured webview.js delta vs pre-change is ≤ 50 KB (delta logged into workflow.md Notes).
    - Verify: unit src/vendor/vscode/vs/base/common/__tests__/filters.test.ts
  - **Plan**:
    1. Record pre-change webview.js size: `node esbuild.js --production && ls -l media/webview.js`.
    2. Copy `/Users/huybuidac/Projects/ai-oss/vscode/src/vs/base/common/filters.ts` preserving the MS copyright header.
    3. Run `pnpm run check-types` — note missing imports.
    4. Iteratively delete exports + helpers not transitively required by `fuzzyScore`, `createMatches`, `IMatch`, `FuzzyScore`, `FuzzyScoreOptions` until check-types passes and file is minimal (~300-500 LOC target). Skip Korean normalization helpers, unrelated filter functions.
    5. Append entry to `src/vendor/vscode/MANIFEST.json`.
    6. Build prod again, record new size, compute delta. STOP and re-scope if delta > 50 KB.

- [x] 1_2 Add Vitest unit test for vendored `fuzzyScore`
  - **Deps**: 1_1
  - **Refs**: specs/vscode-fuzzy-scorer-vendor/spec.md#requirement-unit-test-for-fuzzyscore-parity; design.md D1
  - **Scope**: src/vendor/vscode/vs/base/common/__tests__/filters.test.ts (new)
  - **Acceptance**:
    - Outcome: Vitest test covers the golden cases (`"fp"` → `"FileTreePanel.ts"` non-null; ranking order vs `"file-tree-panel.test.ts"`; `createMatches` length parity for exact-prefix match). `pnpm run test:unit` passes.
    - Verify: unit src/vendor/vscode/vs/base/common/__tests__/filters.test.ts
  - **Plan**:
    1. Create the test file with the four assertions from the spec.
    2. Run `pnpm run test:unit` and adjust assertions for actual scoring output (VSCode ranking semantics may differ subtly; the test pins behavior).

- [x] 1_4 Add new message types to `messages.ts`
  - **Deps**: none
  - **Refs**: specs/file-tree-rpc/spec.md#requirement-requestfiletreesearch-message-type; specs/file-tree-rpc/spec.md#requirement-filetreesearchresponse-message-type
  - **Scope**: src/types/messages.ts
  - **Acceptance**:
    - Outcome: `RequestFileTreeSearchMessage`, `FileTreeSearchResponseMessage`, `FileTreeSearchResult` exported; both added to their respective discriminated unions (`WebviewToExtensionMessage` and `ExtensionToWebviewMessage`).
    - Verify: none — type-only addition
  - **Plan**:
    1. Add `FileTreeSearchResult` interface near existing `FileEntry`.
    2. Add `RequestFileTreeSearchMessage` interface after `RequestReadDirectoryMessage`, with the exact field shape from the spec.
    3. Add `FileTreeSearchResponseMessage` interface after `ReadDirectoryResponseMessage`.
    4. Extend the two top-level union types to include the new members.

- [x] 1_5 Implement extension-host enumeration handler with cancellation
  - **Deps**: 1_4
  - **Refs**: specs/file-tree-rpc/spec.md#requirement-extension-host-enumeration-handler; specs/file-tree-rpc/spec.md#requirement-cancellation-and-token-lifecycle; specs/file-tree-rpc/spec.md#requirement-scope-path-validation; specs/file-tree-rpc/spec.md#requirement-stale-rootgeneration-handling-at-request-entry-and-post-findfiles; design.md D11; design.md D5
  - **Scope**: src/providers/fileTreeSearchHandler.ts (new); src/providers/anywhereTerminalWebviewProvider.ts (or wherever existing RequestReadDirectory is dispatched — extend dispatch); src/providers/__tests__/fileTreeSearchHandler.test.ts (new)
  - **Acceptance**:
    - Outcome: Posting a `RequestFileTreeSearchMessage` triggers `vscode.workspace.findFiles(new RelativePattern(scopeUri, '**/*'), undefined, maxResults, token)` (NO query in glob) and returns a `FileTreeSearchResponseMessage`. Out-of-workspace scopes return `OUT_OF_WORKSPACE`. Superseded requests cancel the previous token and discard its response. Stale `rootGeneration` at request entry returns `STALE_ROOT`. Stale `rootGeneration` AFTER findFiles returns drops the response (no postMessage). Every `CancellationTokenSource` is disposed in `finally`.
    - Verify: unit src/providers/__tests__/fileTreeSearchHandler.test.ts
  - **Plan**:
    1. Create `fileTreeSearchHandler.ts` exporting `class FileTreeSearchHandler` with method `handle(message: RequestFileTreeSearchMessage): Promise<FileTreeSearchResponseMessage | null>` (null = drop without post).
    2. Maintain `currentRequest: { requestId: string; tokenSource: vscode.CancellationTokenSource } | null`.
    3. On new request: if `currentRequest` exists, call its `tokenSource.cancel()`. Then construct new token source, store as currentRequest.
    4. Validate `scopePath` is inside any workspace folder — else `OUT_OF_WORKSPACE`.
    5. Check `rootGeneration` matches host current — else `STALE_ROOT`.
    6. In `try`: invoke `vscode.workspace.findFiles(new RelativePattern(vscode.Uri.file(scopePath), '**/*'), undefined, maxResults, tokenSource.token)`. Map to `FileTreeSearchResult` with forward-slash `relativePath` (use `path.posix.relative` or normalize backslashes).
    7. After findFiles returns, RE-CHECK `rootGeneration` — if changed, return null (drop).
    8. Return `{ results, truncated: results.length === maxResults }`. On exception other than cancellation → `error: { code: 'INTERNAL', message }`.
    9. In `finally`: dispose `tokenSource`; if `currentRequest.requestId === this.requestId`, clear `currentRequest = null`.
    10. Wire into existing webview message dispatcher.
    11. Unit tests: (a) happy path; (b) OUT_OF_WORKSPACE; (c) STALE_ROOT at entry; (d) STALE_ROOT post-findFiles (drop, no post); (e) supersede mid-flight (prior cancelled, prior response not posted); (f) cancellation token disposed in all paths (use spy).

## 2. Tree<T> filter + flat-list API

- [x] 2_1 Add `ITreeFilter<T>` and `IMatchData` types
  - **Deps**: none
  - **Refs**: specs/file-tree-widget/spec.md#requirement-itreefilter-interface; design.md D7
  - **Scope**: src/webview/fileTree/Tree.ts (or a sibling types file if Tree.ts already exports types from elsewhere)
  - **Acceptance**:
    - Outcome: `ITreeFilter<T>`, `IMatchData`, `IMatch` exported from the tree module. No behavior change yet.
    - Verify: none — type-only addition
  - **Plan**:
    1. Add the three interfaces at the top of the file alongside existing `ITreeDataSource<T>` and `ITreeRenderer<T>`.

- [x] 2_2 Implement `setFilter` on `Tree<T>`
  - **Deps**: 2_1
  - **Refs**: specs/file-tree-widget/spec.md#requirement-setfilter-method-on-tree-t; specs/file-tree-widget/spec.md#requirement-renderer-receives-match-data; design.md D7
  - **Scope**: src/webview/fileTree/Tree.ts
  - **Acceptance**:
    - Outcome: Calling `tree.setFilter(filter)` re-runs `rebuildRows` and only includes elements where `filter.shouldRender(el)` returns true. Renderer receives `matchData` from `filter.matchData?.(el)` if defined. Setting `null` restores full rendering.
    - Verify: unit src/webview/fileTree/__tests__/Tree.filter.test.ts
  - **Plan**:
    1. Add private field `_filter: ITreeFilter<T> | null = null` and public method `setFilter(filter)` that stores it and calls internal `_rebuildRows()`.
    2. In `_rebuildRows()`, when `_filter` is non-null, skip elements failing `_filter.shouldRender(el)`.
    3. Extend `ITreeRenderer<T>.renderElement` signature to accept an optional `matchData` arg (backward compatible — existing renderers ignore it).
    4. In the rendering call site inside `_rebuildRows`, pass `_filter?.matchData?.(el)` as the new arg.
    5. Add unit test exercising filter on a small tree (3-4 elements), verifying shouldRender exclusion and matchData passthrough via a spy renderer.

- [x] 2_3 Implement `setFlatItems` on `Tree<T>`
  - **Deps**: 2_2
  - **Refs**: specs/file-tree-widget/spec.md#requirement-flat-list-display-mode; specs/file-tree-widget/spec.md#requirement-filter-mutual-exclusion-with-flat-list; specs/file-tree-widget/spec.md#requirement-matchdata-passed-through-in-flat-list-mode; design.md D3
  - **Scope**: src/webview/fileTree/Tree.ts
  - **Acceptance**:
    - Outcome: `tree.setFlatItems(items, matchMap?)` switches the tree to a flat-list rendering of `items` (no indent, no chevron), preserving virtualization. `setFlatItems(null)` restores normal tree rendering from the last `setInput(root)` with prior expansion + selection intact.
    - Verify: unit src/webview/fileTree/__tests__/Tree.flat-list.test.ts
  - **Plan**:
    1. Add private field `_flatItems: T[] | null = null` and `_flatMatchData: ReadonlyMap<T, IMatchData> | null = null`.
    2. Add public `setFlatItems(items, matchMap?)` that stores both, suspends normal rebuild path, and calls `_rebuildFlat()`.
    3. Implement `_rebuildFlat()` that calls the underlying `List.splice(0, all, items)` and renders each row with depth=0 + matchData from the map.
    4. Implement `_rebuildRows()` reentry on `setFlatItems(null)` — restore from cached root + expansion set.
    5. Add unit test: setInput → expand a folder → select something → setFlatItems → setFlatItems(null) → assert selection and expansion equal pre-flat snapshot.

- [x] 2_4 Expose `focusNext` / `focusPrevious` / `getFocused`
  - **Deps**: 2_3
  - **Refs**: design.md D8; specs/file-tree-search/spec.md#requirement-keyboard-navigation-in-search-mode
  - **Scope**: src/webview/fileTree/Tree.ts
  - **Acceptance**:
    - Outcome: Tree public API has `focusNext()`, `focusPrevious()`, `getFocused(): T | null`. These delegate to underlying `List.focusNext / focusPrevious` and read the focused row index.
    - Verify: none — thin delegation only
  - **Plan**:
    1. Add three methods; each delegates to the underlying `_listWidget.focusNext()` / `focusPrevious()` / `getFocus()`.

## 3. Webview search controller + matching

- [x] 3_1 Implement `matching.ts` adapter
  - **Deps**: 1_1, 2_1
  - **Refs**: design.md D7; design.md D4; specs/file-tree-search/spec.md#requirement-fuzzy-ranking-using-vendored-fuzzyscore-against-relativepath; specs/file-tree-search/spec.md#requirement-search-input-edge-cases
  - **Scope**: src/webview/fileTree/search/matching.ts (new); src/webview/fileTree/search/__tests__/matching.test.ts (new)
  - **Acceptance**:
    - Outcome: `scoreOne(query, candidate)` returns `IMatchData | null` from `fuzzyScore(query, candidate.relativePath)`. `scoreAndSort(query, candidates, mode)` returns sorted array: filter mode → only non-null scores; highlight mode → all entries, matches first by score, non-matches alphabetic below. Empty query and whitespace-only query handled per spec. Wildcard chars in query treated literally.
    - Verify: unit src/webview/fileTree/search/__tests__/matching.test.ts
  - **Plan**:
    1. Implement `scoreOne(query, candidate)`: returns null for empty/whitespace query; else `fuzzyScore(query, query.toLowerCase(), 0, target, target.toLowerCase(), 0, options)`. Convert raw tuple to `IMatchData` using `createMatches`.
    2. Implement `scoreAndSort(query, candidates, mode)` per spec — Filter excludes nulls; Highlight keeps all with matches first.
    3. Unit tests covering: (a) `"fp"` matches `"FileTreePanel.ts"`; (b) `"fp"` ranks `FileTreePanel.ts` above `file-tree-panel.test.ts`; (c) wildcard `"*"` in query is literal, not glob; (d) unicode filename `"日本.md"` with query `"日"` matches; (e) empty query in filter mode → empty result; (f) empty query in highlight mode → all candidates, alphabetic, no IMatchData; (g) tie-break by relativePath length then alphabetic.

- [x] 3_2 Implement `renderHighlightedText` helper
  - **Deps**: 2_1
  - **Refs**: design.md D10; specs/file-tree-search/spec.md#requirement-match-highlighting-in-result-rows
  - **Scope**: src/webview/fileTree/search/renderHighlightedText.ts (new)
  - **Acceptance**:
    - Outcome: Calling `renderHighlightedText(container, "FileTreePanel.ts", [{start:0,end:1},{start:4,end:6}])` populates the container with alternating Text nodes and `<span class="file-tree-search-match">` spans. Non-overlapping, in-order; out-of-range ranges are clamped.
    - Verify: unit src/webview/fileTree/search/__tests__/renderHighlightedText.test.ts
  - **Plan**:
    1. Implement the function in ≤30 LOC: walk matches in order, emit Text node for gap, emit span for match.
    2. Unit test against the JSDOM environment Vitest provides.

- [x] 3_3 Implement `FileTreeSearchController` with enumerate-once cache
  - **Deps**: 1_4, 2_3, 2_4, 3_1
  - **Refs**: design.md D11; design.md D5; specs/file-tree-search/spec.md#requirement-enumerate-once-re-score-per-keystroke; specs/file-tree-search/spec.md#requirement-enumeration-cap-and-overflow-indicator; specs/file-tree-search/spec.md#requirement-active-scope-folder-resolution
  - **Scope**: src/webview/fileTree/search/FileTreeSearchController.ts (new); src/webview/fileTree/search/__tests__/FileTreeSearchController.test.ts (new)
  - **Acceptance**:
    - Outcome: Controller exposes `enter(scope: string)`, `setQuery(q: string)`, `setMode('filter'|'highlight')`, `exit()`. ONE enumeration RPC per (scope, rootGeneration) tuple, debounced 200ms after entry/first keystroke. Keystroke changes re-score client-side WITHOUT new RPC. Mode change re-sorts without RPC. Cache invalidates on `WorkspaceRootChanged`, scope change, or 60s TTL. Pending RPC dropped on exit. Late responses with stale requestId discarded.
    - Verify: unit src/webview/fileTree/search/__tests__/FileTreeSearchController.test.ts
  - **Plan**:
    1. Constructor takes `tree: Tree<FileNode>`, `messageBridge: { post, on }`, `getRootGeneration: () => number`.
    2. State: `scope`, `query`, `mode`, `cache: { scope, rootGeneration, results, fetchedAt } | null`, `pendingRequestId`, `debounceTimer`.
    3. `enter(scope)`: store scope; clear stale cache (if cache.scope !== scope). Trigger debounced enumeration in 200ms.
    4. `setQuery(q)`: store q. If cache fresh → `_render()` immediately (no RPC). If no cache and no pending RPC → trigger debounced enumeration.
    5. `setMode(mode)`: store mode; if cache fresh → `_render()`.
    6. `_render()`: run `scoreAndSort(query, cache.results, mode)`; if empty query in Filter mode → `tree.setFlatItems([])`; else build `matchDataMap`, call `tree.setFlatItems(items, matchDataMap)`. Append overflow footer item if `cache.truncated`.
    7. `_fireEnumeration()`: generate new requestId. Post `RequestFileTreeSearch`. On response: if requestId matches latest, populate cache with `fetchedAt = Date.now()`; call `_render()`. If error → render error marker.
    8. `_onWorkspaceRootChanged()`: clear cache, drop pending.
    9. Cache TTL check on every `_render()` call: `Date.now() - cache.fetchedAt > 60_000` → invalidate + re-fire.
    10. `exit()`: clear timer, drop pendingRequestId, call `tree.setFlatItems(null)`. Cache survives for next enter (until invalidated).
    11. Unit tests: (a) typing 3 chars triggers 1 RPC (debounce); (b) typing 3 chars after cache populated triggers 0 RPCs; (c) mode toggle triggers 0 RPCs; (d) WorkspaceRootChanged invalidates cache; (e) exit drops pending response; (f) cache TTL expiry re-fires; (g) late stale-requestId response discarded.

## 4. Panel UI: header transform + integration

- [x] 4_1 Extend `FileTreeState` with `searchMode`
  - **Deps**: none
  - **Refs**: specs/file-tree-panel/spec.md#requirement-state-persistence-schema; specs/file-tree-panel/spec.md#requirement-mode-toggle-persists-per-webview-session; design.md D9
  - **Scope**: src/webview/state/WebviewState.ts; src/webview/state/WebviewStateStore.ts
  - **Acceptance**:
    - Outcome: `FileTreeState` interface has new field `searchMode: 'filter' | 'highlight'` defaulting to `'filter'`. Old persisted state without this field loads cleanly with the default. No new persisted fields beyond this one.
    - Verify: unit src/webview/state/__tests__/WebviewStateStore.searchMode.test.ts
  - **Plan**:
    1. Add `searchMode?: 'filter' | 'highlight'` to `FileTreeState`.
    2. In `getState()`, default missing `searchMode` to `'filter'`.
    3. Add unit test loading legacy state shape and verifying default value.

- [x] 4_2 Add search icon button to header actions
  - **Deps**: none
  - **Refs**: specs/file-tree-panel/spec.md#requirement-header-search-button; specs/file-tree-search/spec.md#requirement-search-icon-in-file-tree-header
  - **Scope**: src/webview/fileTree/FileTreePanel.ts; src/webview/fileTree/FileTreePanel.css (or wherever existing panel CSS lives)
  - **Acceptance**:
    - Outcome: Header `.file-tree-header__actions` contains three buttons in order: search (first), move (middle), close (last). Search button has `aria-label="Search files"`. Visual smoke matches existing buttons.
    - Verify: manual — open extension dev host, view file tree, see three icon buttons in header
  - **Plan**:
    1. Inside `mountHeader` (FileTreePanel.ts ~L584-613), insert a new button BEFORE the existing move button.
    2. Use the same `<button class="file-tree-header__btn">` pattern, with an inline SVG sprite for `$(search)` copied from VSCode codicon source (provenance comment included).
    3. Wire `onclick` to `this.toggleSearch()` (defined in 4_4).
    4. Add CSS for `.file-tree-search-bar`, `.file-tree-search-input`, `.file-tree-search-mode-toggle` using VSCode CSS vars per the spec.

- [x] 4_3 Implement search bar DOM swap
  - **Deps**: 4_2, 4_1
  - **Refs**: specs/file-tree-panel/spec.md#requirement-header-root-row-swapped-for-search-input; specs/file-tree-search/spec.md#requirement-click-to-enter-search-mode; specs/file-tree-search/spec.md#requirement-search-input-visual-styling; specs/file-tree-panel/spec.md#requirement-mode-toggle-persists-per-webview-session
  - **Scope**: src/webview/fileTree/FileTreePanel.ts
  - **Acceptance**:
    - Outcome: Clicking the search button hides `.file-tree-header__root`, mounts `.file-tree-search-bar` containing an input + a two-segment mode toggle (`Filter` / `Highlight`). Input receives focus on the same tick. Clicking the button again (icon now reads close) reverses everything. Mode toggle reflects/writes `FileTreeState.searchMode`.
    - Verify: manual — toggle search mode in dev host, verify focus + DOM swap + mode toggle state persists across panel close/reopen
  - **Plan**:
    1. Add `_searchBar: HTMLElement | null = null` field and `_isSearchActive: boolean` flag.
    2. Implement `toggleSearch()` that toggles between mounting `_searchBar` (and hiding `_rootRow`) vs the reverse.
    3. Build the search-bar DOM: input element with placeholder per spec, plus two button segments with click handlers writing `searchMode` to state.
    4. On enter: read `searchMode` from state, reflect on toggle UI. Compute placeholder from active scope (resolved per 4_4).
    5. On enter: call `input.focus()` synchronously in same tick.

- [x] 4_4 Wire active scope resolution
  - **Deps**: 4_3
  - **Refs**: specs/file-tree-search/spec.md#requirement-active-scope-folder-resolution; design.md D2
  - **Scope**: src/webview/fileTree/FileTreePanel.ts
  - **Acceptance**:
    - Outcome: When entering search, `panel.resolveSearchScope()` returns the selected folder's absolute path if the current Tree selection is a folder, else the workspace root. The placeholder text reflects the basename (or `Search files` for root). Once captured, scope does NOT change while typing.
    - Verify: manual — select a folder, click search, verify placeholder; deselect/select a file, verify falls back to workspace root
  - **Plan**:
    1. Add `resolveSearchScope(): string` reading `tree.getSelection()` and checking `kind === 'directory'`.
    2. Capture scope value into a local variable in `toggleSearch()` enter branch, pass to the controller.

- [x] 4_5 Connect controller to input + keyboard handling
  - **Deps**: 4_3, 4_4, 3_3
  - **Refs**: specs/file-tree-search/spec.md#requirement-keyboard-navigation-in-search-mode; specs/file-tree-search/spec.md#requirement-exit-restores-prior-tree-state; design.md D8
  - **Scope**: src/webview/fileTree/FileTreePanel.ts
  - **Acceptance**:
    - Outcome: Typing in the input drives the controller (`controller.setQuery(input.value)`). Pressing ArrowDown/Up moves Tree focus without moving caret. Enter opens the focused row (posts `OpenFile`). Escape exits search and restores prior tree state.
    - Verify: manual — full search round-trip in dev host: type, navigate with arrows, open with Enter, escape and verify selection restored
  - **Plan**:
    1. Construct `FileTreeSearchController` instance on panel init (or first search entry).
    2. On enter-search: call `controller.enter(scope)`. Bind `input.oninput → controller.setQuery(input.value)`.
    3. Bind `input.onkeydown` for ArrowDown/Up (preventDefault + `tree.focusNext/Previous`), Enter (preventDefault + read `tree.getFocused()` + post OpenFile), Escape (call `panel.exitSearch()`).
    4. Save prior tree selection + expansion before `controller.enter`; restore on `exitSearch()`.
    5. `exitSearch()`: call `controller.exit()`, remove search bar, re-show root row, restore selection/expansion.

- [x] 4_6 Renderer: highlight matched chars, render relativePath, overflow footer
  - **Deps**: 3_2, 2_3
  - **Refs**: specs/file-tree-search/spec.md#requirement-match-highlighting-in-result-rows; specs/file-tree-search/spec.md#requirement-enumeration-cap-and-overflow-indicator; specs/file-tree-search/spec.md#requirement-scope-relative-search-results; design.md D3; design.md D10
  - **Scope**: src/webview/fileTree/FileTreePanel.ts (renderer-related code, typically the row template)
  - **Acceptance**:
    - Outcome: When `Tree<FileNode>` is in flat-list mode, each row renders **exactly** the `relativePath` string (no basename/dirname split). If `matchData` is provided, matched chars wrap in `<span class="file-tree-search-match">`. The overflow footer renders with `--vscode-descriptionForeground` color, NOT clickable. In Highlight mode, non-matched rows (no matchData) render with `color: var(--vscode-disabledForeground)`.
    - Verify: manual — search "fp" in dev host, verify rows show relative paths with highlighted "F", "P", "T" in `src/webview/fileTree/FileTreePanel.ts`; toggle to Highlight mode and verify non-matches dimmed
  - **Plan**:
    1. Extend the existing row renderer to detect flat-list mode (e.g., via a flag set on the row template, or by checking that the rendered element's `kind === '__searchResult'`).
    2. In flat-list mode: read `relativePath` from the synthetic search-result element; call `renderHighlightedText(container, relativePath, matchData?.matches ?? [])`.
    3. Apply `--vscode-disabledForeground` to rows lacking matchData (Highlight mode non-matches).
    4. Synthesize `__overflowFooter` flat-list item with non-clickable styling and the spec footer text.

- [x] 4_7 Error path rendering
  - **Deps**: 3_3, 4_6
  - **Refs**: specs/file-tree-search/spec.md#requirement-error-path-for-search-rpc-failure
  - **Scope**: src/webview/fileTree/search/FileTreeSearchController.ts; src/webview/fileTree/FileTreePanel.ts
  - **Acceptance**:
    - Outcome: When the controller receives a response with `error`, it calls `tree.setFlatItems([errorMarkerItem])` rendering a single row with `--vscode-errorForeground` color text equal to `error.message`.
    - Verify: manual — temporarily force the extension handler to return an error and verify the row appears
  - **Plan**:
    1. Define an `ErrorMarker` synthetic flat-list item (e.g., a sentinel object).
    2. Controller produces it when response carries `error`.
    3. Renderer detects sentinel and renders error styling.

## 5. Validation pass

- [-] 5_1 End-to-end smoke in dev host _(manual — requires Extension Development Host launch, deferred to user)_
  - **Deps**: 4_5, 4_6, 4_7, 1_5
  - **Refs**: proposal.md (UI Impact & E2E section)
  - **Scope**: none — verification only
  - **Acceptance**:
    - Outcome: In the Extension Development Host: (a) click search icon → input appears, focused; (b) type "f" → debounce, results appear within ~250ms; (c) toggle Filter↔Highlight → list re-renders without RPC; (d) arrow keys navigate; (e) Enter opens; (f) Escape returns to prior tree with same selection + expansion; (g) overflow footer appears for queries with >500 results.
    - Verify: manual — execute the seven checks above
  - **Plan**:
    1. Run `pnpm run check-types`, `pnpm run lint`, `pnpm run test:unit`, `node esbuild.js --production`, and `node scripts/check-bundle-size.mjs`.
    2. Launch dev host (F5 in VS Code).
    3. Execute checks (a)-(g) on this repo as the test workspace.

- [x] 5_2 Bundle delta measurement
  - **Deps**: 5_1
  - **Refs**: specs/vscode-fuzzy-scorer-vendor/spec.md#requirement-bundle-delta-budget
  - **Scope**: none — measurement only
  - **Acceptance**:
    - Outcome: Difference between pre-change `media/webview.js` size and post-change size is documented in workflow.md Notes and is ≤ 50 KB.
    - Verify: manual — `git stash`, build, record size, unstash, build, record size, log delta
  - **Plan**:
    1. From the change branch HEAD: build prod and record size.
    2. Stash uncommitted changes, checkout previous main commit, build prod, record size.
    3. Compute delta, restore branch, record in workflow.md.
