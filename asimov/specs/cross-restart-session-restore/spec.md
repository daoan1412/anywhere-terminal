# cross-restart-session-restore Specification
## Requirements

### Requirement: Per-session xterm-headless mirror in extension host

For every active terminal session, when `sessionRestore.enabled === true`, `SessionManager` SHALL maintain an `@xterm/headless` `Terminal` instance constructed with `{ cols, rows, scrollback: 1000, allowProposedApi: true }`. Every byte received from `pty.onData` MUST be written to the headless terminal via `headless.write(data)` AFTER the existing webview-forward call. PTY resizes MUST be mirrored via `headless.resize(cols, rows)` in the same handler.

The mirror SHALL be disposed when the session is destroyed (real destroy, not scheduled).

### Requirement: SerializeAddon options match VS Code core

When generating a snapshot, the code SHALL dynamically `import('@xterm/addon-serialize')`, load `SerializeAddon` into the headless terminal, and call `serialize({ scrollback: 1000, excludeAltBuffer: true, excludeModes: true })`. The exact option values SHALL NOT differ from these defaults except via the user-facing settings introduced in this change.

### Requirement: Two-tier persistence — index in workspaceState, buffers on disk

The extension SHALL persist a metadata index under the workspaceState key `anywhereTerminal.sessionSnapshots.index` (shape `SessionSnapshotsIndex` per design.md D4) and SHALL persist each serialized buffer as a separate file under `<context.storageUri>/snapshots/<sessionId>.snapshot.ans`. Every index entry SHALL include `sessionId`, `viewLocation`, `terminalNumber`, `customName`, `shell`, `shellArgs`, `cwd`, `currentCwd`, `cols`, `rows`, `bufferFile`, `bufferBytes`, `isSplitPane`, `rootTabId`, `snapshotAt`, `shellExited`, `exitCode`, and (for editor sessions) `panelId`.

Reads SHALL be tolerant of unknown extra fields. Reads MUST validate `version === 1`; any other value SHALL be treated as missing data (record discarded, no error thrown). Missing or unreadable buffer files SHALL cause the matching index entry to be dropped silently.

#### Scenario: Index lost but buffer files survive

- **WHEN** the extension host is killed between the buffer-write step and the index-write step of `deactivate`
- **THEN** on next activate, `hydrateFromSnapshots` SHALL scan `<storageUri>/snapshots/` and reconstruct a minimal index from the surviving files using sensible defaults (`viewLocation` from live-panels record when available, else `"sidebar"`; `customName` null; `currentCwd` null; `shellExited` false; `isSplitPane` false; `rootTabId` equal to `sessionId`).

### Requirement: Snapshot persistence cadence — debounced + two-step sync flush on deactivate

`SessionManager` SHALL coalesce snapshot writes via a single 1000 ms debounce. Hot loops of `pty.onData` events MUST result in at most one buffer-file write per session per debounce window.

`extension.deactivate()` MUST perform the following in order:

1. Call `sessionManager.flushSnapshotsSync()` — synchronously writes every active session's serialized buffer to its file under `<storageUri>/snapshots/` using `fs.writeFileSync`.
2. Call `await context.workspaceState.update(SESSION_SNAPSHOTS_INDEX_KEY, index)` and `await context.workspaceState.update(LIVE_EDITOR_PANELS_KEY, livePanels)` — the index and live-panels records are persisted via VS Code's async memento API.
3. Call `sessionManager.dispose()` — idempotent; tears down PTYs after persistence is best-effort durable.

`SessionManager` SHALL NOT be added to `context.subscriptions`; disposal is owned explicitly by `deactivate()` to control ordering.

No periodic timer SHALL be added; on-data + on-deactivate triggers are sufficient.

### Requirement: Eviction caps applied on hydrate and on write

`SessionManager.hydrateFromSnapshots` and the write path SHALL enforce these caps in this order:

1. Drop entries with `snapshotAt < now - 7 days`.
2. Drop entries with `bufferBytes > 1_048_576` bytes.
3. Keep only the 20 most recent (by `snapshotAt`); evict the rest.
4. On hydrate only: delete any `<storageUri>/snapshots/*.snapshot.ans` file not referenced by a surviving index entry (orphan cleanup).

Eviction during write MUST execute BEFORE the `workspaceState.update` call AND before the buffer-file write. Dropped entries' buffer files MUST be unlinked from disk in the same flush.

### Requirement: Activate-time hydrate

`extension.activate` SHALL read both `anywhereTerminal.sessionSnapshots.index` and `anywhereTerminal.editorPanels.live` from `context.workspaceState` and pass them to `sessionManager.hydrateFromSnapshots(...)` and `sessionManager.hydrateLivePanels(...)` BEFORE registering any view provider or the panel serializer. `hydrateFromSnapshots` MUST read each `bufferFile` from `<context.storageUri>/snapshots/` and load it into the per-session pending-restore record; missing/unreadable files SHALL cause the matching index entry to be dropped.

When `sessionRestore.enabled === false`, both methods MUST clear any persisted records (workspaceState keys overwritten with `version: 1` empty records, and the `<storageUri>/snapshots/` directory contents deleted) so toggling the setting off purges all disk state.

### Requirement: Sidebar/panel hydrate path

`TerminalViewProvider.onReady` SHALL, when `existingTabs.length === 0`, additionally check `sessionManager.hasSnapshotsForLocation(viewLocation)`. If true, it MUST:

1. Call `sessionManager.consumeSnapshotsForLocation(viewLocation)`.
2. For each snapshot, call `sessionManager.createSession(viewId, webview, { shell, shellArgs, cwd, restoreFrom: snapshot })`.
3. Send a single `init` message listing all restored tabs (preserving `terminalNumber` and `customName`).
4. For each restored session, send a `restoreFromSnapshot` message containing the serialized buffer.

The existing `existingTabs.length > 0` reload branch MUST remain unchanged and MUST take precedence over the new restore branch.

### Requirement: Editor restore via panel serializer

`TerminalPanelSerializer.deserializeWebviewPanel` SHALL pass the consumed snapshot array to `TerminalEditorProvider` as the `restoreSnapshots` constructor argument. The provider SHALL, after `setupPanel` runs, replay the snapshots via the same `restoreFromSnapshot` message used by the sidebar/panel path.

### Requirement: `restoreFromSnapshot` IPC message

The extension→webview message bus SHALL accept a `restoreFromSnapshot` message with shape:

```ts
{ type: "restoreFromSnapshot"; tabId: string; serializedBuffer: string; cols: number; rows: number; snapshotAt: number }
```

The webview SHALL process this message by, in order: resize the xterm to `cols × rows`, write `serializedBuffer`, write the restore divider, complete DOM attach, then begin PTY forwarding.

### Requirement: Restore divider exact text

After writing the serialized buffer the webview SHALL write the divider:

```
\x1b[0m\r\n\x1b[2m─── restored — last update at HH:MM ───\x1b[0m\r\n
```

`HH:MM` SHALL be the local-time formatting of `snapshotAt` using 24-hour clock with zero-padded hours and minutes. The leading `\x1b[0m` SGR Reset is REQUIRED to prevent residual styling from the serialized buffer (e.g. an active bold/colored prompt) bleeding into the divider line.

When the restored session has `shellExited === true`, the divider SHALL include the exit indicator:

```
\x1b[0m\r\n\x1b[2m─── restored — last update at HH:MM (shell exited, code: N) ───\x1b[0m\r\n
```

`N` SHALL be the numeric `exitCode` from the index, or the literal `?` when `exitCode` is null.

### Requirement: Setting `anywhereTerminal.sessionRestore.enabled`

`package.json` SHALL contribute a boolean setting `anywhereTerminal.sessionRestore.enabled` with `default: true` and description "Restore terminal scrollback and metadata across VS Code restarts. Disable to opt out of all persistence." When read as `false`, the extension MUST NOT construct headless mirrors, MUST NOT write snapshots, and MUST clear any persisted records (workspaceState index + `<storageUri>/snapshots/` directory contents) on next activate.

#### Scenario: Setting toggled from true to false mid-session

- **WHEN** the user changes `anywhereTerminal.sessionRestore.enabled` from `true` to `false` while terminals are running
- **THEN** `SessionManager` SHALL dispose every active headless mirror + its cached SerializeAddon, cancel any pending debounced persist, and purge persisted records (workspaceState index emptied, `<storageUri>/snapshots/` cleaned) within one `onDidChangeConfiguration` callback. Subsequent PTY output SHALL NOT mirror.

### Requirement: Exited shells restored read-only

If a snapshot has `shellExited === true`, `consumeSnapshotsForLocation` and `consumeSnapshotsForPanel` SHALL include it in the returned array. `createSession({ restoreFrom: snap })` MUST honor `restoreFrom.shellExited === true` by:

1. NOT spawning a fresh PTY.
2. Constructing a `TerminalSession` from persisted metadata with `isActive: false`.
3. Registering the session so it appears in the tab strip.
4. Sending `restoreFromSnapshot` to the webview as usual.
5. Marking the webview-side `TerminalInstance.exited = true` (existing field at `src/webview/state/WebviewStateStore.ts:30-32`) so input is suppressed and the existing exited-terminal styling applies.

The webview SHALL render the exited-variant divider (preceding requirement).

### Requirement: Split-pane snapshot fields

Every snapshot index entry SHALL carry `isSplitPane: boolean` and `rootTabId: string | null`. `rootTabId` SHALL equal `sessionId` for non-split sessions and the root of any split tree; it SHALL identify the owning tab's root session for any child pane.

#### Scenario: Tab with two split panes restored

- **WHEN** a tab contains two split panes (root session A + child session B with `rootTabId === A`) and a full restart occurs
- **THEN** both index entries SHALL survive eviction together (or together get dropped — they share the 20-snapshot budget but are NOT independently capped); after hydrate the webview's existing `WebviewStateStore.restore()` SHALL reconstruct the split layout from `vscode.setState` and find both sessions present in the `init` message. Orphan layout leaves (whose session is missing) SHALL be pruned by the existing `WebviewStateStore.ts:225-238` validation.

