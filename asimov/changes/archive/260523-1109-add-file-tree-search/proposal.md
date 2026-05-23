# Proposal: add-file-tree-search

## Why

The file tree panel currently has no way to find a file by name; users must manually expand folders or fall back to the `Terminal: Open File` flow. Adding an in-panel search — triggered from a header icon, scoped to the active folder, with VSCode-parity fuzzy ranking — closes the most painful UX gap remaining in the file tree and makes the panel useful in real workspaces with hundreds of files.

## Appetite

L (≤2w) — adds a new vendored VSCode subset (`fuzzyScore` + `HighlightedLabel`), a new Tree filter API, a new flat-list display mode, a new search UI surface (icon, input, two toggle modes), a new RPC, and new persistence keys.

## Scope

### In scope

- Search icon button in the file tree header (alongside existing move / close buttons).
- Click search icon → header's root row transforms into a search input; icon switches to a close-search affordance.
- Scope: the **active folder** in the tree (the currently focused or selected folder row), falling back to workspace root when nothing is focused.
- Backend search via `vscode.workspace.findFiles(new RelativePattern(activeFolder, …))`, with debounce, cancellation, and a `maxResults` cap.
- Fuzzy ranking using a vendored subset of VSCode's `vs/base/common/filters.ts` (`fuzzyScore`, `createMatches`, related helpers) — exact VSCode ranking behavior.
- Character-level match highlighting on matched names using a vendored minimal `HighlightedLabel`.
- Flat-list display during active search (relative paths from the active scope folder).
- Two-mode toggle: **Filter** (only matches shown) vs **Highlight** (all in-scope files shown, matches sorted to top with character highlights, capped at N=500 for perf).
- Keyboard navigation in search mode: `↑`/`↓` move between rows, `Enter` opens the focused row, `Escape` exits search.
- Exit search restores the previous tree view (same expansion + selection).

### Out of scope

- Workspace-wide search across multiple workspace folders (we scope to the first workspace folder only, matching existing tree behavior).
- Content search ("grep") — only file-name matching.
- "Contiguous match" toggle (only fuzzy mode in v1; defer the second axis).
- Search history / recent queries persistence.
- Replace / rename operations.
- Search across hidden / git-ignored files (we rely on `findFiles` defaults that respect `.gitignore` and `search.exclude`).
- Persisting the search query across panel close/reopen (search state is transient).

## Capabilities

1. **file-tree-search** — new capability: in-panel search UI + filter behavior + match navigation + Filter/Highlight modes.
2. **vscode-fuzzy-scorer-vendor** — new capability: vendor `fuzzyScore` and `HighlightedLabel` subsets from `microsoft/vscode` into `src/vendor/vscode/`, with manifest + license attribution.
3. **file-tree-widget** (modified) — `Tree<T>` gains `setFilter(predicate, matchData)` and an optional flat-list display mode.
4. **file-tree-panel** (modified) — header acquires a search icon + input mode + mode toggle UI; new search-active state in the panel.
5. **file-tree-rpc** (modified) — new `RequestFileTreeSearch` / `FileTreeSearchResponse` messages with relative-folder scope.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — new icon, new input mode, new flat-list rendering, new mode toggle.
- **E2E required?** NOT REQUIRED — `asimov/project.md` declares E2E as N/A; verification is unit + Vitest + manual smoke in dev host.
- **Justification**: The project has no E2E harness. The risky paths (fuzzy scorer correctness, debounce/cancellation, mode switching) are unit-testable with Vitest. UI behavior is verified manually in the Extension Development Host.

## Risk Level

MEDIUM — touches vendor boundary (more files imported from `microsoft/vscode`), adds a new RPC across the webview↔extension boundary, introduces a new display mode in an existing widget, and adds non-trivial keyboard handling. Bundle delta is bounded (~15-25 KB after tree-shake) and well within the 3.6 MB ceiling + 450 KB delta budget. No data migration. No security/privacy concerns.
