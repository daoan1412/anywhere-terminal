## MODIFIED Requirements

### Requirement: Tab-Bar-Rendering

The webview SHALL render a tab bar inside the `#tab-bar` element that displays all terminal tabs for the current view. Each tab element SHALL display the resolved tab label (`customName ?? name`) and a close button ("×"). Each tab element MUST carry the attribute `data-vscode-context='{"webviewSection":"terminalTab","tabId":"<id>"}'` so VS Code's native context menu can target tab-specific entries. The tab bar SHALL include a "+" button as the last element to create new tabs.

The `renderTabBar()` function SHALL be called after every tab mutation: `handleInit`, `tabCreated` (after `createTerminal` + `switchTab`), `tabRemoved` (after `removeTerminal`), `switchTab`, and `tabRenamed`.

### Requirement: Tab-Click-Handlers

The webview SHALL wire click handlers on tab elements to switch tabs, on close buttons to close tabs, on the "+" button to create new tabs, and on tab elements to enter inline-rename mode via `dblclick`.

#### Scenario: Double-click a tab enters inline edit (overlay)

- **Given** tabs "Terminal 1" (active) and "build" (inactive, custom name) exist
- **When** the user double-clicks the "build" tab element
- **Then** an absolutely-positioned overlay `<input>` (sibling of `#tab-bar`, NOT a child of the tab element) is shown over the "build" tab's `.tab-name` rectangle, focused and pre-filled with `"build"`
- **And** any subsequent `renderTabBar()` call leaves the overlay in place and only repositions it; the input retains focus, selection, and any in-progress IME composition

#### Scenario: Click tab to switch

- **Given** tabs "Terminal 1" (active) and "Terminal 2" (inactive) exist
- **When** the user clicks the "Terminal 2" tab element
- **Then** `switchTab("terminal-2-id")` is called
- **And** the tab bar re-renders with "Terminal 2" marked active

#### Scenario: Click close button

- **Given** tabs "Terminal 1" and "Terminal 2" exist
- **When** the user clicks the "×" button on "Terminal 1"
- **Then** `vscode.postMessage({ type: 'closeTab', tabId: 'terminal-1-id' })` is sent
- **And** the click event does NOT propagate to the tab element (no accidental switch)

#### Scenario: Click add button

- **Given** the tab bar is rendered
- **When** the user clicks the "+" button
- **Then** `vscode.postMessage({ type: 'createTab' })` is sent
