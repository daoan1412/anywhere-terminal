## ADDED Requirements

### Requirement: Search icon in file tree header

The system SHALL render a search icon button in the file tree panel header inside the `.file-tree-header__actions` cluster, positioned BEFORE the existing move and close buttons. The icon SHALL use the `$(search)` codicon-equivalent SVG sprite and SHALL have an accessible label `Search files`.

### Requirement: Click to enter search mode

The system SHALL switch the panel into search-active mode when the user clicks the search icon. In search-active mode, the root row of the header (chevron + workspace name) SHALL be replaced by a single-line text input element. The input SHALL receive focus on the same tick as the click handler.

### Requirement: Search input visual styling

The system SHALL style the search input using VSCode theme variables: `--vscode-input-background`, `--vscode-input-foreground`, `--vscode-input-border`, and `--vscode-focusBorder` (for the focus ring). The input SHALL have placeholder text `Search in <folder-name>` where `<folder-name>` is the basename of the active scope folder, or `Search files` when the scope is the workspace root.

### Requirement: Active scope folder resolution

The system SHALL resolve the search scope as follows: if a folder row in the tree is the current `Tree<T>` selection AND it is a folder (not a file), the scope SHALL be that folder; otherwise the scope SHALL be the workspace root. The resolved scope SHALL be captured at the moment the user enters search mode and SHALL NOT change while the user is typing.

#### Scenario: User selects a folder then clicks search

- **WHEN** the user has clicked the folder `src/webview/fileTree` to select it, then clicks the search icon
- **THEN** the placeholder reads `Search in fileTree` and the search scope is the absolute path of `src/webview/fileTree`

#### Scenario: No folder selected

- **WHEN** the user clicks the search icon while a file row (not a folder) is selected, or while nothing is selected
- **THEN** the search scope is the workspace root and the placeholder reads `Search files`

### Requirement: Scope-relative search results

The system SHALL render search results as a flat list, replacing the tree view inside the panel content area. Each row SHALL display **exactly** the `relativePath` field of `FileTreeSearchResult` — the file path relative to the active scope folder using forward-slash separators. The original tree state SHALL be preserved internally so it can be restored on exit.

### Requirement: Enumerate once, re-score per keystroke

The system SHALL fire exactly ONE `RequestFileTreeSearch` enumeration per (scopePath, rootGeneration) tuple while in search-active mode, debounced 200 ms after entry OR after the first keystroke (whichever comes first). Subsequent keystrokes SHALL re-score the cached enumeration client-side WITHOUT firing additional RPCs. The cache SHALL be invalidated when `WorkspaceRootChanged` is received, when the user exits and re-enters search with a different scope, OR when 60 seconds elapse since the enumeration completed.

### Requirement: Enumeration cap and overflow indicator

The system SHALL request at most 2000 results per enumeration. When the response reports `truncated: true`, the list SHALL display a single footer row reading `Showing first 2000 files in scope — narrow your scope to see more`, styled with `--vscode-descriptionForeground`.

### Requirement: Fuzzy ranking using vendored fuzzyScore against relativePath

The system SHALL score each candidate path against the query using the vendored `fuzzyScore` function with `target = result.relativePath`. The system SHALL NOT score against the basename separately; word-start weighting in `fuzzyScore` already preserves basename-priority ranking. Results SHALL be sorted by score descending, with ties broken by shorter `relativePath` length first, then alphabetic order.

### Requirement: Match highlighting in result rows

The system SHALL wrap each matched character substring in `<span class="file-tree-search-match">`, using `createMatches(fuzzyScoreResult)` to derive the ranges. The CSS class SHALL set background color to `--vscode-list-filterMatchBackground` and border to `1px solid --vscode-list-filterMatchBorder`.

### Requirement: Filter mode is the default

The system SHALL enter search-active mode in **Filter** mode by default. In Filter mode the rendered list SHALL contain ONLY rows whose `fuzzyScore` returned a non-null score against `relativePath`.

### Requirement: Highlight mode toggle

The system SHALL render a mode toggle control inside the search bar with two values, `Filter` and `Highlight`, persisted in `WebviewStateStore` under `FileTreeState.searchMode`. In **Highlight** mode the rendered list SHALL contain ALL files in the cached enumeration (up to 2000). Matched rows SHALL be sorted to the top in fuzzy-score order; non-matched rows SHALL be sorted alphabetically below them and SHALL render with `color: var(--vscode-disabledForeground)`. Matched-character highlighting SHALL apply only to matched rows.

#### Scenario: Empty query in Highlight mode

- **WHEN** Highlight mode is active AND the search input is empty
- **THEN** all enumerated files SHALL render in alphabetic order with NO highlighting; the dim color SHALL NOT be applied (no rows are "non-matched" when no query exists)

### Requirement: Search input edge cases

The system SHALL handle the following input edge cases without error:
- **Empty query in Filter mode**: render empty list (no rows, no error message).
- **Whitespace-only query**: treated as empty query.
- **Wildcard characters in query (`*`, `?`, `[`, `]`, `{`, `}`)**: treated as literal characters by `fuzzyScore`; NO glob behavior.
- **Multi-byte / unicode / emoji in file names**: scored using UTF-16 code units; highlighting wraps surrogate pairs together (no broken surrogates in `<span>` boundaries).
- **Query matching a folder name only**: `fuzzyScore` runs against `relativePath`; folder names appear in the path so matches WILL surface descendant files. No standalone folder rows are rendered in v1.
- **Backslash in query (Windows paths)**: treated as literal character; no path normalization applied to the query.

### Requirement: Keyboard navigation in search mode

The system SHALL handle keyboard input on the search input element as follows:
- `ArrowDown` / `ArrowUp` SHALL move the focused row in the result list down / up, scrolling into view as needed, WITHOUT moving the text caret in the input.
- `Enter` SHALL open the focused row in the same flow as a single click on a tree file row (posts `OpenFile` with the active session id).
- `Escape` SHALL exit search-active mode.

### Requirement: Exit restores prior tree state

The system SHALL exit search-active mode when the user clicks the search icon a second time (now in a "close search" affordance), presses `Escape`, OR clicks anywhere outside the panel header AND the input is empty. On exit, the tree SHALL be restored with the SAME selection and SAME expansion set it had before entering search-active mode.

### Requirement: Search state is transient

The system SHALL NOT persist the search query, the current result list, or `searchActive` state to `WebviewStateStore`. Closing and reopening the panel, OR switching between webview locations (sidebar ↔ panel), SHALL exit search-active mode. The mode toggle (`Filter`/`Highlight`) is the ONLY search-related field that SHALL be persisted.

### Requirement: Error path for search RPC failure

The system SHALL display a single error row reading the human-readable `error.message` field (styled with `--vscode-errorForeground`) when `FileTreeSearchResponse` carries an `error` payload instead of `entries`. The search input SHALL remain interactive.
