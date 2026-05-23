# file-tree-panel Specification
## Requirements

### Requirement: File tree panel component

The system SHALL provide a `FileTreePanel` component in webview code that composes the `Tree<FileNode>` widget, an instance of `IFileSystemProvider`, and a read-only row renderer (file/folder icon + name). The panel SHALL be a single self-contained DOM subtree appended into the webview body when toggled on.

### Requirement: User-configurable position (4 sides)

The system SHALL support placing the file tree panel at exactly one of four positions relative to the terminal area: `top`, `bottom`, `left`, or `right`. The panel SHALL occupy the full extent of that side (full width for top/bottom; full height for left/right) and SHALL NOT change the terminal split tree's internal layout logic — terminals only see a smaller rectangular bounding box.

#### Scenario: Terminal split tree preserves its own layout

- **WHEN** the file tree panel is shown OR moved between positions
- **THEN** the split tree's branch ratios, active pane, tab selection, and pane focus SHALL remain unchanged; only the available pixel rectangle changes

### Requirement: Default position by webview shape

The system SHALL choose an initial position the first time the panel is enabled in a workspace: `right` when `ResizeCoordinator` reports shape `panel` (width > height × 1.2), otherwise `bottom`. This default SHALL be persisted immediately as if the user had explicitly chosen it.

### Requirement: Position is persisted and shape-stable

The system SHALL persist the chosen position in `WebviewStateStore` and SHALL NOT change it automatically when the webview shape changes (e.g. dragged from sidebar to bottom panel). Only an explicit user action (the move command) SHALL change the position.

### Requirement: Move command via QuickPick

The system SHALL register a command `anywhereTerminal.setFileTreePosition` that opens a `vscode.window.showQuickPick` with exactly the items `Top`, `Bottom`, `Left`, `Right`. Selecting an item SHALL post a `SetFileTreePosition` message to the webview with the chosen value, the webview SHALL re-render the panel at the new side, and the new value SHALL be persisted.

#### Scenario: User cancels the QuickPick

- **WHEN** the user dismisses the QuickPick without selecting
- **THEN** the position SHALL NOT change and no message SHALL be posted

### Requirement: Title-bar buttons

The system SHALL contribute two title-bar buttons on the AnyWhere Terminal view: one bound to `anywhereTerminal.toggleFileTree` (icon `$(files)`), and one bound to `anywhereTerminal.setFileTreePosition` (icon `$(layout)`). Both SHALL be available via the command palette under titles `AnyWhere Terminal: Toggle File Tree` and `AnyWhere Terminal: Move File Tree…`.

### Requirement: Toggle command

The system SHALL register a command `anywhereTerminal.toggleFileTree` that shows or hides the file tree panel. The command SHALL post a `ToggleFileTree` message to the webview, which flips its `open` state and persists the result.

### Requirement: State persistence schema

The system SHALL persist the file tree's `open: boolean`, its current `position: 'top' | 'bottom' | 'left' | 'right'`, its `expandedPaths: string[]`, AND its `searchMode: 'filter' | 'highlight'` (default `'filter'`) into `WebviewStateStore` under the existing `fileTree` key on the `WebviewState` interface. The schema SHALL remain additive. The transient fields `searchActive` and `searchQuery` SHALL NOT be persisted.

### Requirement: Theme integration

The system SHALL bind all colors used in the file tree panel (background, foreground, hover, selection, focus border, indent guide) to VS Code CSS variables (`--vscode-list-*`, `--vscode-sideBar-*`, `--vscode-focusBorder`) so the panel automatically follows VS Code dark / light / high-contrast themes.

### Requirement: Click to open

The system SHALL open the clicked file in a VS Code editor tab when a user single-clicks a file row. The webview SHALL post an `OpenFile` message to the extension host carrying the absolute path AND the currently-active pane's `sessionId` (resolved via the existing `getActiveSessionId()` helper used by `DragDropHandler`) so the extension's existing `openFile` handler accepts it. Folder rows SHALL toggle expansion on click, NOT open.

### Requirement: Empty state

The system SHALL render an empty-state message in the panel when no workspace folder is open, instead of an empty tree.

### Requirement: Header search button

The system SHALL render a third icon button inside `.file-tree-header__actions`, positioned as the FIRST child (before the existing move button and close button). The button SHALL toggle the panel between idle mode (default tree view) and search-active mode. When the panel is in search-active mode, the button's icon SHALL switch from `$(search)` to `$(close)` and its accessible label SHALL switch from `Search files` to `Close search`.

### Requirement: Header root row swapped for search input

The system SHALL hide `.file-tree-header__root` and render a `.file-tree-search-bar` sibling element in its place when the panel enters search-active mode. The search bar SHALL contain a `<input type="text">` element (the query input) followed by a mode-toggle button group displaying two segments labeled `Filter` and `Highlight`. On exit from search-active mode, `.file-tree-search-bar` SHALL be removed and `.file-tree-header__root` SHALL be re-shown.

### Requirement: Mode toggle persists per webview session

The system SHALL store the user's last-selected mode (`'filter' | 'highlight'`) under `FileTreeState.searchMode` in `WebviewStateStore`, defaulting to `'filter'`. When the user enters search-active mode, the previously stored mode SHALL be restored. Changing the mode while the input has text SHALL re-render the result list in the new mode WITHOUT re-issuing the RPC.

