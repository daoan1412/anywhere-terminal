## ADDED Requirements

### Requirement: Header search button

The system SHALL render a third icon button inside `.file-tree-header__actions`, positioned as the FIRST child (before the existing move button and close button). The button SHALL toggle the panel between idle mode (default tree view) and search-active mode. When the panel is in search-active mode, the button's icon SHALL switch from `$(search)` to `$(close)` and its accessible label SHALL switch from `Search files` to `Close search`.

### Requirement: Header root row swapped for search input

The system SHALL hide `.file-tree-header__root` and render a `.file-tree-search-bar` sibling element in its place when the panel enters search-active mode. The search bar SHALL contain a `<input type="text">` element (the query input) followed by a mode-toggle button group displaying two segments labeled `Filter` and `Highlight`. On exit from search-active mode, `.file-tree-search-bar` SHALL be removed and `.file-tree-header__root` SHALL be re-shown.

### Requirement: Mode toggle persists per webview session

The system SHALL store the user's last-selected mode (`'filter' | 'highlight'`) under `FileTreeState.searchMode` in `WebviewStateStore`, defaulting to `'filter'`. When the user enters search-active mode, the previously stored mode SHALL be restored. Changing the mode while the input has text SHALL re-render the result list in the new mode WITHOUT re-issuing the RPC.

## MODIFIED Requirements

### Requirement: State persistence schema

The system SHALL persist the file tree's `open: boolean`, its current `position: 'top' | 'bottom' | 'left' | 'right'`, its `expandedPaths: string[]`, AND its `searchMode: 'filter' | 'highlight'` (default `'filter'`) into `WebviewStateStore` under the existing `fileTree` key on the `WebviewState` interface. The schema SHALL remain additive. The transient fields `searchActive` and `searchQuery` SHALL NOT be persisted.
