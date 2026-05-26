# editor-tab-reload-resilience Specification
## Requirements

### Requirement: Editor terminal survives window reload

When the user reloads the VS Code window (`workbench.action.reloadWindow`, Cmd+R) while an `anywhereTerminal.editor` webview panel is open, the underlying PTY SHALL remain alive and its scrollback SHALL be visually restored in the revived panel.

#### Scenario: Reload while a long-running process is in progress

- **WHEN** the user runs a long-running command (e.g. `npm run dev`) in an editor terminal and triggers window reload
- **THEN** within 5 seconds of reload, the same panel re-appears, the PTY is still attached (`hasChildProcesses === true`), no new shell prompt is printed, and the existing scrollback is visible in the new xterm instance.

### Requirement: Stable panel identity persisted via webview state

`TerminalEditorProvider` SHALL accept an optional `panelId: string` in its constructor and derive `_viewId = "editor-${panelId}"` from it. The first time a new panel is constructed, the provider SHALL post a `setPanelId` message to the webview after `ready`; the webview SHALL persist `{ panelId }` via `vscode.setState(...)` so that VS Code includes it in the `WebviewPanelSerializer.deserializeWebviewPanel(panel, state)` payload.

### Requirement: WebviewPanelSerializer for editor terminals

The extension SHALL register `TerminalPanelSerializer` (implementing `vscode.WebviewPanelSerializer<{ panelId?: string }>`) for view type `anywhereTerminal.editor` during `activate`. The class SHALL live in `src/providers/TerminalPanelSerializer.ts`. Its `deserializeWebviewPanel(panel, state)` method MUST:

1. Resolve `panelId` from `state?.panelId`, fall back to `crypto.randomUUID()` when missing.
2. Call `sessionManager.cancelScheduledDestroy("editor-${panelId}")` BEFORE creating any new provider instance.
3. Consume persisted snapshots for the panel via `sessionManager.consumeSnapshotsForPanel(panelId)`.
4. Construct a new `TerminalEditorProvider` with the same `panelId` and the consumed snapshots.

### Requirement: Editor `onReady` distinguishes existing-sessions, restore-from-snapshot, and cold-open

`TerminalEditorProvider.setupPanel`'s `onReady` flow SHALL branch on three cases in this order:

1. **Existing sessions present** (`sessionManager.getAllSessionsForView(this._viewId).length > 0`): the provider MUST call `sessionManager.updateWebviewForView(this._viewId, this._panel.webview)` to rebind the surviving sessions to the new webview, then send `init` with ALL surviving sessions (root tabs and split-pane children) and a `restore` message (with cached scrollback) per session. MUST NOT call `createSession`.
2. **Restore snapshots provided** (`restoreSnapshots.length > 0` from constructor): the provider MUST create sessions via `createSession(viewId, webview, { restoreFrom: snap })` for each snapshot (root tab AND split panes — see "Split-pane survival in init message" below), then send `init` followed by one `restoreFromSnapshot` message per snapshot.
3. **Cold open**: existing behavior — create a single new session and send `init`.

The same `updateWebviewForView` rebind requirement applies whether the editor revives via the Phase A grace path (case 1) or the Phase B cross-restart path (case 2): the new panel's webview reference MUST replace the disposed one before any message is posted.

### Requirement: Split-pane survival in init message

Every `init.tabs[i]` SHALL carry `isSplitPane: boolean`. The provider's `init` SHALL include every session belonging to the view — root tabs AND split-pane children — so the webview can recreate every xterm instance referenced by the persisted `tabLayouts` (per `WebviewStateStore.persist`). Without this, `WebviewStateStore.restore()` prunes layouts whose tabIds are not in `validTabIds`, causing split-pane children to be silently dropped on reload (Phase A) and on cross-restart (Phase B).

#### Scenario: Horizontal split tab survives window reload

- **WHEN** the user opens an editor terminal tab, splits it horizontally (yielding root pane R + child pane C, both bound to the same `editor-${panelId}` view), and triggers window reload (`Cmd+R`)
- **THEN** within 5 seconds of reload the panel re-appears; the `init` message MUST include both R and C with `isSplitPane: false` for R and `isSplitPane: true` for C; the webview MUST recreate xterm instances for both; the persisted split layout MUST be re-rendered with both panes visible; existing scrollback for both panes MUST be visually restored.

### Requirement: Activation event registered for serialized panel revival

`package.json` `activationEvents` SHALL include `"onWebviewPanel:anywhereTerminal.editor"` so that VS Code activates the extension before invoking `deserializeWebviewPanel`.

### Requirement: Grace-period destroy on editor panel dispose

`TerminalEditorProvider.onDidDispose` SHALL NOT call `sessionManager.destroyAllForView` directly. Instead, it SHALL call `sessionManager.scheduleDestroyForView(viewId, gracePeriodMs)` where `gracePeriodMs` defaults to `5000`. The schedule MUST be cancellable via `sessionManager.cancelScheduledDestroy(viewId)`. If the schedule fires without being cancelled, it MUST execute `destroyAllForView(viewId)` exactly as the prior implementation did.

#### Scenario: Tab closed by user (no revival)

- **WHEN** the user closes an editor terminal tab via the `×` button and no `deserializeWebviewPanel` follows within 5 seconds
- **THEN** the PTY is destroyed exactly as before and `_activePanels`/`_instances` no longer contain the panel reference.

### Requirement: Synchronous cleanup of pending destroys on extension deactivate

`SessionManager.dispose()` SHALL synchronously iterate `pendingDestroys`, clear each timer, and invoke `destroyAllForView(viewId)` for every queued view ID before resolving. No PTY MAY survive past `deactivate` even when a grace timer is still scheduled.

### Requirement: Editor panels tracked in workspaceState

The extension SHALL persist active editor panels under the workspaceState key `anywhereTerminal.editorPanels.live` using the schema in `design.md D4`. Entries SHALL be added in `TerminalEditorProvider.createPanel`, updated when sessions are attached/detached, and removed when the grace-period destroy actually fires (not when scheduled).

