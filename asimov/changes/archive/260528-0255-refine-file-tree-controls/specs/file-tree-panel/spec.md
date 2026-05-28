## ADDED Requirements

### Requirement: Header Open Folder button

The system SHALL render an Open Folder icon button inside `.file-tree-header__actions`, positioned between the search button (first) and the move button (last). The button SHALL use icon `$(folder-opened)` and accessible label `Open Folder`. Click SHALL post a `request-open-folder` message to the extension host. The button SHALL be present regardless of whether a workspace folder is currently open.

### Requirement: Open Folder message handler

The system SHALL register a handler in `FileTreeHost` for inbound message type `request-open-folder`. The handler SHALL invoke `vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false })` to let the user pick a folder. The handler SHALL NOT touch the VS Code workspace (no `vscode.openFolder`, no extension-host reload). On confirm, the handler SHALL post `reveal-in-file-tree` with the picked `fsPath` and `source: "openFolder"` on the host's stable attach channel (`attachPost`), reusing the existing in-webview `revealPath` → `setRoot` flow to re-root the file tree at the chosen path. The handler SHALL surface a warning toast (`showWarningMessage`) if the attach channel is unavailable when the dialog resolves, and an error toast (`showErrorMessage`) if `showOpenDialog` rejects. The handler SHALL NOT post any other reply for the cancel path.

### Requirement: Bottom-position visible divider

The system SHALL render a 1px `border-top` on the file tree panel when its position is `bottom`. The border colour SHALL resolve in order: `var(--vscode-widget-border)`, then `var(--vscode-panel-border)`, then a fixed fallback `rgba(128, 128, 128, 0.35)`. The border SHALL remain visible at all times — independent of the resize-sash hover state. Top, left, and right positions SHALL NOT receive this additional border (the existing sash divider is sufficient there).

### Requirement: In-panel position menu

The system SHALL open an in-webview dropdown menu when the user clicks the header "Move File Tree" button. The menu container SHALL carry `role="menu"`, be anchored to the button, and contain exactly four items labeled `Top`, `Bottom`, `Left`, `Right`. The menu SHALL NOT trigger a VS Code QuickPick modal. Each item SHALL carry `role="menuitemradio"` and `aria-checked="true"|"false"` reflecting the currently-active position (single-select group semantics; required so NVDA/JAWS/VO announce the active item). Selecting an item SHALL call `panel.setPosition(value)` directly (no extension-host roundtrip) and close the menu, restoring focus to the button. The menu SHALL close on Escape (restores focus), click-outside (no focus snatch), button re-click, or Tab (no focus snatch — focus advances naturally). Keyboard navigation SHALL follow the WAI-ARIA menubutton pattern: ArrowUp/ArrowDown move focus between items (with wraparound), Home/End jump to first/last, Enter activates the focused item (via native `<button>` activation), Escape closes. The button SHALL carry `aria-haspopup="menu"` and a dynamic `aria-expanded` attribute. The menu SHALL position itself below the button when there is room, and SHALL flip above the button when placement-below would overflow the viewport.

The command-palette flow (`anywhereTerminal.setFileTreePosition`) SHALL remain unchanged and SHALL continue to use `vscode.window.showQuickPick`.

## MODIFIED Requirements

### Requirement: State persistence schema

The system SHALL persist the file tree's current `position: 'top' | 'bottom' | 'left' | 'right'`, its `expandedPaths: string[]`, AND its `searchMode: 'filter' | 'highlight'` (default `'filter'`) into `WebviewStateStore` under the existing `fileTree` key on the `WebviewState` interface. The schema SHALL remain additive. The `open: boolean` field SHALL no longer be part of the schema (older persisted values SHALL be ignored on read; the panel is always shown). The transient fields `searchActive` and `searchQuery` SHALL NOT be persisted.

### Requirement: Header search button

The system SHALL render an icon button inside `.file-tree-header__actions`, positioned as the FIRST child (before the open-folder button and the move button). The button SHALL toggle the panel between idle mode (default tree view) and search-active mode. When the panel is in search-active mode, the button's icon SHALL switch from `$(search)` to `$(close)` and its accessible label SHALL switch from `Search files` to `Close search`.

## REMOVED Requirements

### Requirement: Toggle command

**Reason**: The file tree panel is now always shown. Users minimize the panel by collapsing the root row (click the chevron), which uses the existing `.file-tree--root-collapsed` state. There is no remaining show/hide operation for the command to bind to.

**Migration**: Remove the `anywhereTerminal.toggleFileTree` command declaration and its handler. Per-view variants `anywhereTerminal.toggleFileTree.sidebar` and `anywhereTerminal.toggleFileTree.panel` SHALL also be removed. Users who bound a keybinding to these commands will see the binding become inert (no error, no effect) on the next extension load.

### Requirement: Title-bar buttons

**Reason**: With Toggle removed, no AnyWhere Terminal view/title menu entry remains for the file tree. The move action stays reachable via the existing header move button and via the command palette (`anywhereTerminal.setFileTreePosition`).

**Migration**: Remove the `view/title` menu entries for `anywhereTerminal.toggleFileTree.sidebar` and `anywhereTerminal.toggleFileTree.panel` from `package.json`. The `setFileTreePosition` command stays in the command palette but does NOT need to be moved into the title bar.
