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

### Requirement: State persistence schema

The system SHALL persist the file tree's current `position: 'top' | 'bottom' | 'left' | 'right'`, its `expandedPaths: string[]`, AND its `searchMode: 'filter' | 'highlight'` (default `'filter'`) into `WebviewStateStore` under the existing `fileTree` key on the `WebviewState` interface. The schema SHALL remain additive. The `open: boolean` field SHALL no longer be part of the schema (older persisted values SHALL be ignored on read; the panel is always shown). The transient fields `searchActive` and `searchQuery` SHALL NOT be persisted.

### Requirement: Theme integration

The system SHALL bind all colors used in the file tree panel (background, foreground, hover, selection, focus border, indent guide) to VS Code CSS variables (`--vscode-list-*`, `--vscode-sideBar-*`, `--vscode-focusBorder`) so the panel automatically follows VS Code dark / light / high-contrast themes.

### Requirement: Click to open

The system SHALL open the clicked file in a VS Code editor tab when a user single-clicks a file row. The webview SHALL post an `OpenFile` message to the extension host carrying the absolute path AND the currently-active pane's `sessionId` (resolved via the existing `getActiveSessionId()` helper used by `DragDropHandler`) so the extension's existing `openFile` handler accepts it. Folder rows SHALL toggle expansion on click, NOT open.

### Requirement: Empty state

The system SHALL render an empty-state message in the panel when no workspace folder is open, instead of an empty tree.

### Requirement: Header search button

The system SHALL render an icon button inside `.file-tree-header__actions`, positioned as the FIRST child (before the open-folder button and the move button). The button SHALL toggle the panel between idle mode (default tree view) and search-active mode. When the panel is in search-active mode, the button's icon SHALL switch from `$(search)` to `$(close)` and its accessible label SHALL switch from `Search files` to `Close search`.

### Requirement: Header root row swapped for search input

The system SHALL hide `.file-tree-header__root` and render a `.file-tree-search-bar` sibling element in its place when the panel enters search-active mode. The search bar SHALL contain a `<input type="text">` element (the query input) followed by a mode-toggle button group displaying two segments labeled `Filter` and `Highlight`. On exit from search-active mode, `.file-tree-search-bar` SHALL be removed and `.file-tree-header__root` SHALL be re-shown.

### Requirement: Mode toggle persists per webview session

The system SHALL store the user's last-selected mode (`'filter' | 'highlight'`) under `FileTreeState.searchMode` in `WebviewStateStore`, defaulting to `'filter'`. When the user enters search-active mode, the previously stored mode SHALL be restored. Changing the mode while the input has text SHALL re-render the result list in the new mode WITHOUT re-issuing the RPC.

### Requirement: Header Open Folder button

The system SHALL render an Open Folder icon button inside `.file-tree-header__actions`, positioned between the search button (first) and the move button (last). The button SHALL use icon `$(folder-opened)` and accessible label `Open Folder`. Click SHALL post a `request-open-folder` message to the extension host. The button SHALL be present regardless of whether a workspace folder is currently open.

### Requirement: Open Folder message handler

The system SHALL register a handler in `FileTreeHost` for inbound message type `request-open-folder`. The handler SHALL invoke `vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false })` to let the user pick a folder. The handler SHALL NOT touch the VS Code workspace (no `vscode.openFolder`, no extension-host reload). On confirm, the handler SHALL post `reveal-in-file-tree` with the picked `fsPath` and `source: "openFolder"` on the host's stable attach channel (`attachPost`), reusing the existing in-webview `revealPath` → `setRoot` flow to re-root the file tree at the chosen path. The handler SHALL surface a warning toast (`showWarningMessage`) if the attach channel is unavailable when the dialog resolves, and an error toast (`showErrorMessage`) if `showOpenDialog` rejects. The handler SHALL NOT post any other reply for the cancel path.

### Requirement: Bottom-position visible divider

The system SHALL render a 1px `border-top` on the file tree panel when its position is `bottom`. The border colour SHALL resolve in order: `var(--vscode-widget-border)`, then `var(--vscode-panel-border)`, then a fixed fallback `rgba(128, 128, 128, 0.35)`. The border SHALL remain visible at all times — independent of the resize-sash hover state. Top, left, and right positions SHALL NOT receive this additional border (the existing sash divider is sufficient there).

### Requirement: In-panel position menu

The system SHALL open an in-webview dropdown menu when the user clicks the header "Move File Tree" button. The menu container SHALL carry `role="menu"`, be anchored to the button, and contain exactly four items labeled `Top`, `Bottom`, `Left`, `Right`. The menu SHALL NOT trigger a VS Code QuickPick modal. Each item SHALL carry `role="menuitemradio"` and `aria-checked="true"|"false"` reflecting the currently-active position (single-select group semantics; required so NVDA/JAWS/VO announce the active item). Selecting an item SHALL call `panel.setPosition(value)` directly (no extension-host roundtrip) and close the menu, restoring focus to the button. The menu SHALL close on Escape (restores focus), click-outside (no focus snatch), button re-click, or Tab (no focus snatch — focus advances naturally). Keyboard navigation SHALL follow the WAI-ARIA menubutton pattern: ArrowUp/ArrowDown move focus between items (with wraparound), Home/End jump to first/last, Enter activates the focused item (via native `<button>` activation), Escape closes. The button SHALL carry `aria-haspopup="menu"` and a dynamic `aria-expanded` attribute. The menu SHALL position itself below the button when there is room, and SHALL flip above the button when placement-below would overflow the viewport.

The command-palette flow (`anywhereTerminal.setFileTreePosition`) SHALL remain unchanged and SHALL continue to use `vscode.window.showQuickPick`.

