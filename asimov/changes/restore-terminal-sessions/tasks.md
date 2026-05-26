<!-- Builder reads tasks.md NOT discovery.md — all discovery findings flow into Plan/Refs. -->

## 1. Dependencies and setting

- [x] 1_1 Add `@xterm/headless` and `@xterm/addon-serialize` to dependencies
  - **Deps**: none
  - **Refs**: design.md D1; discovery.md §5
  - **Scope**: `package.json`, `pnpm-lock.yaml`
  - **Acceptance**:
    - Outcome: `pnpm install` resolves to `@xterm/headless@^6.0.0` and `@xterm/addon-serialize@^0.13.0` (or current stable major matching `@xterm/xterm@^6.0.0`); both appear in `package.json#dependencies`.
    - Verify: manual `pnpm install && pnpm run check-types`
  - **Plan**:
    1. Run `pnpm add @xterm/headless @xterm/addon-serialize`. Verify the resolved versions are sibling-compatible with the existing `@xterm/xterm@^6.0.0` (consult `/Users/huybuidac/Projects/ai-oss/xterm.js/headless/package.json` which is `6.0.0`).

- [x] 1_2 Contribute the `anywhereTerminal.sessionRestore.enabled` setting and the new activation event
  - **Deps**: 1_1
  - **Refs**: specs/editor-tab-reload-resilience/spec.md (Activation event registered for serialized panel revival); specs/cross-restart-session-restore/spec.md (Setting `anywhereTerminal.sessionRestore.enabled`); design.md D11
  - **Scope**: `package.json`
  - **Acceptance**:
    - Outcome: `package.json#activationEvents` includes `"onWebviewPanel:anywhereTerminal.editor"`; `package.json#contributes.configuration` declares `anywhereTerminal.sessionRestore.enabled` (boolean, default `true`, description from D11).
    - Verify: manual `jq '.activationEvents, .contributes.configuration.properties["anywhereTerminal.sessionRestore.enabled"]' package.json` shows the additions.
  - **Plan**:
    1. Append `"onWebviewPanel:anywhereTerminal.editor"` to `activationEvents`.
    2. Add the boolean property under `contributes.configuration.properties`.

## 2. Persistence schema and storage

- [x] 2_1 Define snapshot + live-panels types
  - **Deps**: 1_2
  - **Refs**: design.md D4, D12, D13; specs/cross-restart-session-restore/spec.md (Two-tier persistence — index in workspaceState, buffers on disk; Split-pane snapshot fields; Exited shells restored read-only)
  - **Scope**: `src/session/SessionSnapshot.ts` (NEW)
  - **Acceptance**:
    - Outcome: exported `SessionSnapshotMetadata` (carrying `bufferFile`, `bufferBytes`, `isSplitPane`, `rootTabId`, `shellExited`, `exitCode`), `SessionSnapshotsIndex`, `LiveEditorPanelsRecord` matching D4 verbatim. No buffer string lives on the index type.
    - Verify: none — types-only file (no runtime behavior to verify).
  - **Plan**:
    1. Declare the three TS interfaces with the field set from D4. Export from the file root.

- [x] 2_2 Implement `SessionStorage` (two-tier persistence)
  - **Deps**: 2_1
  - **Refs**: design.md D4, D5, D6, D11; specs/cross-restart-session-restore/spec.md (Two-tier persistence; Snapshot persistence cadence; Eviction caps)
  - **Scope**: `src/session/SessionStorage.ts` (NEW)
  - **Acceptance**:
    - Outcome: class exposes `loadIndex()`, `loadLivePanels()`, `readBufferFile(sessionId)`, `writeBufferFileSync(sessionId, data)` (used in deactivate), `writeBufferFileAsync(sessionId, data)` (used in debounce), `unlinkBufferFile(sessionId)`, `listBufferFiles()`, `scheduleIndexWrite(index)` (debounced 1s), `writeIndexAwaited(index)` (used in deactivate), `writeLivePanelsAwaited(record)`, `purge()` (clears workspaceState keys + deletes `<storageUri>/snapshots/`). All file ops use `<context.storageUri>/snapshots/<sessionId>.snapshot.ans`.
    - Verify: unit `src/session/SessionStorage.test.ts` (round-trip with mocked workspaceState + fs, debounce coalesces 50 calls to 1 write, sync vs async write paths produce identical files, purge cleans both tiers).
  - **Plan**:
    1. Constructor: `(workspaceState: vscode.Memento, storageUri: vscode.Uri, fs: typeof import("node:fs"))` — inject `fs` for testability.
    2. Resolve buffer-file path via `path.join(storageUri.fsPath, "snapshots", \`${sessionId}.snapshot.ans\`)`. Ensure directory exists lazily.
    3. Debounce in `scheduleIndexWrite` with a single `setTimeout(1000)` — collapses many calls to one `workspaceState.update`.
    4. `writeBufferFileSync` uses `fs.writeFileSync` for deactivate path; async path uses `fs.promises.writeFile`.
    5. `purge()` removes both tiers idempotently.

- [x] 2_3 Pure eviction function + tests
  - **Deps**: 2_1
  - **Refs**: design.md D5; specs/cross-restart-session-restore/spec.md (Eviction caps applied on hydrate and on write)
  - **Scope**: `src/session/sessionSnapshotEviction.ts` (NEW), `src/session/sessionSnapshotEviction.test.ts` (NEW)
  - **Acceptance**:
    - Outcome: pure function `evictIndex(index, now): { kept: SessionSnapshotsIndex; dropped: string[] }` returns evicted sessionIds so callers can unlink corresponding files. Tests cover age cutoff (boundary at exactly 7 days, off-by-one safe), 1MB cap, 20-snapshot cap, combination of all three, and stable ordering on tie.
    - Verify: unit `src/session/sessionSnapshotEviction.test.ts`
  - **Plan**:
    1. Implement the pure function — no side effects.
    2. Add fixtures for snapshots at +/-7 days, varying buffer sizes, batch of 25 ordered by snapshotAt.
    3. Assert exact survivor set + dropped list per scenario.

## 3. Headless mirror in SessionManager

- [x] 3_1 Add headless mirror lifecycle to `SessionManager`
  - **Deps**: 1_1
  - **Refs**: design.md D1; specs/cross-restart-session-restore/spec.md (Per-session xterm-headless mirror in extension host, SerializeAddon options match VS Code core); `/Users/huybuidac/Projects/ai-oss/vscode/src/vs/platform/terminal/node/ptyService.ts:1032-1135`
  - **Scope**: `src/session/SessionManager.ts`
  - **Acceptance**:
    - Outcome: when `restoreEnabled === true`, every `TerminalSession` owns a `headless: Terminal` (lazy on first `pty.onData`); `headless.write(data)` is invoked on every byte, `headless.resize(cols, rows)` on every resize; `headless.dispose()` is called in `destroySession`.
    - Verify: unit `src/session/SessionManager.headlessMirror.test.ts` (mirror written, resize forwarded, dispose called).
  - **Plan**:
    1. Add `headless?: import("@xterm/headless").Terminal` to the `TerminalSession` shape.
    2. In the pty.onData handler (around current `appendToScrollback` call), if `restoreEnabled && !session.headless`, instantiate `new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })`. Then `headless.write(data)`.
    3. Mirror `resizeSession` to `headless.resize`.
    4. Add `headless.dispose()` to `destroySession`.

- [x] 3_2 Add the per-session SerializeAddon cache + snapshot generator
  - **Deps**: 3_1, 2_2
  - **Refs**: design.md D1, D6, D12, D13; specs/cross-restart-session-restore/spec.md (SerializeAddon options match VS Code core; Split-pane snapshot fields; Exited shells restored read-only); `/Users/huybuidac/Projects/ai-oss/vscode/src/vs/platform/terminal/node/ptyService.ts:1083-1099`
  - **Scope**: `src/session/SessionManager.ts`
  - **Acceptance**:
    - Outcome: `SessionManager.generateSnapshotMetadata(sessionId): { metadata: SessionSnapshotMetadata; buffer: string } | null`. The dynamic `import("@xterm/addon-serialize")` runs at most once per process (constructor cached); the SerializeAddon INSTANCE is constructed at most once per session and reused across snapshots (stored on the session as `_serializeAddon`); the addon is disposed in `destroySession`; the serialize call uses `{ scrollback: 1000, excludeAltBuffer: true, excludeModes: true }`; metadata includes `isSplitPane`, `rootTabId`, `shellExited`, `exitCode`, and (for editor sessions) `panelId`. Buffer is truncated to 1 MB on output before being returned.
    - Verify: unit `src/session/SessionManager.snapshot.test.ts` (assert: exact options object; addon instance is the same across 5 calls on the same session; addon instance is distinct between sessions; exited sessions stamp `shellExited: true` + `exitCode`).
  - **Plan**:
    1. Add private `_serializeCtor: typeof SerializeAddon | null` plus async loader (cached at manager level).
    2. Lazy-construct + cache `session._serializeAddon` once per session; call `headless.loadAddon(addon)` only on first construction.
    3. Implement `generateSnapshotMetadata` returning the metadata-plus-buffer pair; truncate buffer to 1 MB at nearest CR/LF boundary; return null when no headless mirror exists.

- [x] 3_3 Record shell-exit metadata
  - **Deps**: 3_1
  - **Refs**: design.md D13; specs/cross-restart-session-restore/spec.md (Exited shells restored read-only)
  - **Scope**: `src/session/SessionManager.ts`, `src/pty/PtySession.ts`
  - **Acceptance**:
    - Outcome: when a PTY exits, the session records `shellExited: true` and `exitCode: number | null` on the session; further data writes do NOT update the headless mirror (frozen); the next debounced snapshot persists the exit fields.
    - Verify: unit `src/session/SessionManager.exit.test.ts`
  - **Plan**:
    1. Add `shellExited`, `exitCode` to the session shape (`SessionManager.ts:41-82`).
    2. In the exit handler, set both fields and guard `handleHeadlessData` against further writes.
    3. Schedule an immediate persist (bypass debounce) on exit so the exit state isn't lost if the user closes the window seconds later.

- [x] 3_4 Wire debounced persist on pty.onData + meta changes
  - **Deps**: 3_2, 3_3, 2_2
  - **Refs**: design.md D6; specs/cross-restart-session-restore/spec.md (Snapshot persistence cadence — debounced + two-step sync flush on deactivate)
  - **Scope**: `src/session/SessionManager.ts`
  - **Acceptance**:
    - Outcome: every `pty.onData`, `setCustomName`, `setCurrentCwd`, and session-create-finished hook calls `_schedulePersist()`; the timer flushes ALL pending sessions in one pass — async `writeBufferFileAsync` for each session's buffer, then `scheduleIndexWrite` for the index. Hot-loop tests collapse 50 data events into 1 file write per session and 1 index write total.
    - Verify: unit `src/session/SessionManager.persist.test.ts` (50 data events → 1 write per session; meta change schedules; setting kill-switch suppresses all)
  - **Plan**:
    1. Add `_persistTimer?: NodeJS.Timeout`, `_pendingSessions: Set<string>`.
    2. On each trigger source, add sessionId to `_pendingSessions` and call `_schedulePersist()`.
    3. The debounced callback iterates pending sessions, calls `generateSnapshotMetadata`, writes each buffer async, builds the index, calls `scheduleIndexWrite`.
    4. `_schedulePersist` is a no-op when `restoreEnabled === false`.

- [x] 3_5 Two-step sync flush + idempotent dispose
  - **Deps**: 3_4, 2_2
  - **Refs**: design.md D6; specs/cross-restart-session-restore/spec.md (Snapshot persistence cadence — debounced + two-step sync flush on deactivate)
  - **Scope**: `src/session/SessionManager.ts`
  - **Acceptance**:
    - Outcome: `flushSnapshotsSync()` synchronously writes every active session's buffer file via `fs.writeFileSync`. `flushIndexAwaited()` writes the index + live-panels records via `await workspaceState.update(...)`. `dispose()` is idempotent (`_disposed` guard); it does NOT call flush — callers in `extension.deactivate` orchestrate the flush separately.
    - Verify: unit `src/session/SessionManager.deactivate.test.ts`
  - **Plan**:
    1. Add `flushSnapshotsSync` + `flushIndexAwaited` methods.
    2. Set a `_disposed = false` flag; `dispose()` early-returns if already disposed; the flushes early-return if disposed.
    3. Removed: any prior implicit-flush-in-dispose logic.

- [x] 3_6 Handle mid-session setting toggle
  - **Deps**: 3_4
  - **Refs**: design.md D11; specs/cross-restart-session-restore/spec.md (Setting toggled from true to false mid-session)
  - **Scope**: `src/session/SessionManager.ts`, `src/extension.ts`
  - **Acceptance**:
    - Outcome: extension subscribes to `vscode.workspace.onDidChangeConfiguration` for `anywhereTerminal.sessionRestore.enabled`; on flip to `false`, `SessionManager` disposes all headless mirrors + cached SerializeAddons, cancels pending debounce, calls `storage.purge()`; on flip to `true`, the next PTY output for each session lazily constructs a fresh mirror.
    - Verify: unit `src/session/SessionManager.settingToggle.test.ts`
  - **Plan**:
    1. Add `setRestoreEnabled(enabled: boolean)` on SessionManager that handles teardown + purge.
    2. Wire `onDidChangeConfiguration` in `extension.ts` to call it.

## 4. Schedule-destroy primitive and editor lifecycle

- [x] 4_1 Add scheduleDestroy + cancel + sync-flush in SessionManager
  - **Deps**: none
  - **Refs**: design.md D3; specs/editor-tab-reload-resilience/spec.md (Grace-period destroy on editor panel dispose, Synchronous cleanup of pending destroys on extension deactivate)
  - **Scope**: `src/session/SessionManager.ts`
  - **Acceptance**:
    - Outcome: `scheduleDestroyForView(viewId, delayMs?)`, `cancelScheduledDestroy(viewId)`, and `pendingDestroys: Map<string, NodeJS.Timeout>` exist; dispose synchronously fires each callback and clears the map.
    - Verify: unit `src/session/SessionManager.scheduleDestroy.test.ts` (fires after delay, cancel prevents fire, dispose forces immediate fire).
  - **Plan**:
    1. Add the field and two methods near `destroyAllForView`.
    2. In `dispose()`, iterate `pendingDestroys`, clear each timer, then call `destroyAllForView(viewId)` synchronously for each.

- [x] 4_2 Switch `TerminalEditorProvider.onDidDispose` to schedule
  - **Deps**: 4_1
  - **Refs**: design.md D3; specs/editor-tab-reload-resilience/spec.md (Grace-period destroy on editor panel dispose)
  - **Scope**: `src/providers/TerminalEditorProvider.ts`
  - **Acceptance**:
    - Outcome: `onDidDispose` calls `sessionManager.scheduleDestroyForView(this._viewId, 5000)` instead of `destroyAllForView`; the rest of the cleanup (`_activePanels.delete`, `_instances.delete`, `cancelAllPreviewTokens`, disposable disposal) still runs immediately.
    - Verify: integration `src/providers/TerminalEditorProvider.scheduledDestroy.test.ts` (mock session manager records call ordering).
  - **Plan**:
    1. Replace the single `destroyAllForView` line at L256 with the schedule call.
    2. Leave the surrounding cleanup untouched.

## 5. Panel identity persistence

- [x] 5_1 Add `panelId` constructor param and webview write-through
  - **Deps**: 4_2
  - **Refs**: design.md D2; specs/editor-tab-reload-resilience/spec.md (Stable panel identity persisted via webview state)
  - **Scope**: `src/providers/TerminalEditorProvider.ts`, `src/types/messages.ts`, `src/webview/state/WebviewStateStore.ts`, `src/webview/state/WebviewState.ts`
  - **Acceptance**:
    - Outcome: constructor signature gains `panelId: string = crypto.randomUUID()` and `restoreSnapshots: SessionSnapshot[] = []`; `_viewId = `editor-${panelId}` `; after `onReady`, the provider posts `{ type: "setPanelId", panelId }` to the webview; the webview persists `{ panelId }` into `vscode.setState`; `createPanel` factory passes a fresh UUID; `WebviewState` type includes optional `panelId: string`.
    - Verify: unit `src/providers/TerminalEditorProvider.panelId.test.ts` (round-trip: panelId persisted, viewId derived).
  - **Plan**:
    1. Add `panelId` + `restoreSnapshots` to the private constructor.
    2. Update `createPanel` to pass `crypto.randomUUID()` and `[]`.
    3. Add `SetPanelIdMessage` / `PersistPanelIdMessage` IPC types to `src/types/messages.ts`.
    4. Wire webview-side handler in the message router to call `webviewStateStore.updateState({ panelId })`.
    5. Add `panelId?: string` to `WebviewState` shape.

- [x] 5_2 Track live editor panels in workspaceState
  - **Deps**: 5_1, 2_2
  - **Refs**: design.md D10; specs/editor-tab-reload-resilience/spec.md (Editor panels tracked in workspaceState)
  - **Scope**: `src/session/SessionManager.ts`, `src/providers/TerminalEditorProvider.ts`
  - **Acceptance**:
    - Outcome: `SessionManager.registerEditorPanel(panelId)`, `attachSessionToPanel(panelId, sessionId)`, `unregisterEditorPanel(panelId)` exist; `createPanel` calls `registerEditorPanel`; each `createSession` in an editor view location calls `attachSessionToPanel`; the actual destroy (after grace) calls `unregisterEditorPanel`; the panel list is persisted under `anywhereTerminal.editorPanels.live` via `SessionStorage.scheduleIndexWrite` (piggybacks on the same debounce).
    - Verify: unit `src/session/SessionManager.editorPanels.test.ts`
  - **Plan**:
    1. Add the three methods + a `_livePanels: Map<string, LiveEditorPanelEntry>` in `SessionManager`.
    2. Persist via `SessionStorage` on each mutation; reuse the existing debounce timer.

## 6. WebviewPanelSerializer

- [x] 6_1 Implement `TerminalPanelSerializer`
  - **Deps**: 4_2, 5_1
  - **Refs**: design.md D2, D3, D7; specs/editor-tab-reload-resilience/spec.md (WebviewPanelSerializer for editor terminals); `/Users/huybuidac/Projects/ai-oss/vscode/extensions/markdown-language-features/src/preview/previewManager.ts` (reference impl)
  - **Scope**: `src/providers/TerminalPanelSerializer.ts` (NEW)
  - **Acceptance**:
    - Outcome: class implements `vscode.WebviewPanelSerializer<{ panelId?: string }>`; `deserializeWebviewPanel(panel, state)` resolves `panelId`, calls `cancelScheduledDestroy("editor-${panelId}")`, consumes snapshots for the panel, then instantiates `TerminalEditorProvider` with the resolved `panelId` and consumed snapshots.
    - Verify: integration `src/providers/TerminalPanelSerializer.test.ts` (revive sequence: cancel → consume → construct).
  - **Plan**:
    1. Match the constructor signature shown in `design.md` Interfaces.
    2. Implement `deserializeWebviewPanel` in 15-30 lines mirroring the markdown serializer pattern.

- [x] 6_2 Register the serializer in `extension.activate`
  - **Deps**: 6_1
  - **Refs**: specs/editor-tab-reload-resilience/spec.md (WebviewPanelSerializer for editor terminals)
  - **Scope**: `src/extension.ts`
  - **Acceptance**:
    - Outcome: `vscode.window.registerWebviewPanelSerializer(TerminalEditorProvider.viewType, new TerminalPanelSerializer(...))` is pushed into `context.subscriptions` during `activate`, AFTER `SessionManager` is constructed and AFTER `hydrateFromSnapshots`/`hydrateLivePanels` complete (so consumed snapshots are populated).
    - Verify: integration `src/extension.activate.test.ts` (assert registration order).
  - **Plan**:
    1. Add the registration immediately after the existing view-provider registrations.

## 7. Activate-time hydrate + sidebar/panel/editor restore

- [x] 7_1 Add hydrate methods to SessionManager
  - **Deps**: 2_2, 3_4, 5_2
  - **Refs**: design.md D7; specs/cross-restart-session-restore/spec.md (Activate-time hydrate, Sidebar/panel hydrate path, Exited shells restored read-only, Index lost but buffer files survive scenario)
  - **Scope**: `src/session/SessionManager.ts`
  - **Acceptance**:
    - Outcome: `hydrateFromSnapshots(index)` populates `_pendingSnapshots: Map<sessionId, { metadata; buffer }>` (after applying eviction, reading buffer files from disk, dropping entries with missing/unreadable buffer files); `hydrateLivePanels(record)` populates `_livePanels`; orphan buffer files (in dir but not referenced) are unlinked; if the index is missing/empty but buffer files exist, reconstruct minimal entries; `hasSnapshotsForLocation(loc)`, `consumeSnapshotsForLocation(loc)`, `consumeSnapshotsForPanel(panelId)` operate on the pending map and remove entries on consume; exited entries are INCLUDED in returned arrays (not dropped).
    - Verify: unit `src/session/SessionManager.hydrate.test.ts` (round-trip happy path; missing buffer file drops entry; orphan cleanup; index-lost reconstruction; exited entry included)
  - **Plan**:
    1. Add the methods with the exact behavior from D7.
    2. Use `SessionStorage.listBufferFiles` + `readBufferFile` for the reconstruction fallback.

- [x] 7_2 Call hydrate from `extension.activate`; rewrite `deactivate` with two-step flush
  - **Deps**: 7_1, 6_2, 3_5
  - **Refs**: design.md D6, D7; specs/cross-restart-session-restore/spec.md (Activate-time hydrate; Snapshot persistence cadence — debounced + two-step sync flush on deactivate)
  - **Scope**: `src/extension.ts`
  - **Acceptance**:
    - Outcome: hydrate runs BEFORE any provider registration; `restoreEnabled === false` purges persistence first; `deactivate()` executes in order: (1) `sessionManager.flushSnapshotsSync()` synchronously; (2) `await sessionManager.flushIndexAwaited()` for both index and live-panels records; (3) `sessionManager.dispose()`. `SessionManager` is NOT added to `context.subscriptions`.
    - Verify: integration `src/extension.activate.test.ts`
  - **Plan**:
    1. Read setting via existing settings reader.
    2. Construct `SessionStorage(context.workspaceState, context.storageUri, fs)`.
    3. Read both workspaceState keys → pass into hydrate methods.
    4. Remove `SessionManager` from `context.subscriptions.push(...)` so disposal stays explicit.
    5. Rewrite the empty `deactivate()` body with the three-step flush in order.

- [x] 7_3 Hydrate path in `TerminalViewProvider.onReady`
  - **Deps**: 7_1
  - **Refs**: design.md D7; specs/cross-restart-session-restore/spec.md (Sidebar/panel hydrate path; Exited shells restored read-only)
  - **Scope**: `src/providers/TerminalViewProvider.ts`
  - **Acceptance**:
    - Outcome: when `existingTabs.length === 0 && sessionManager.hasSnapshotsForLocation(viewLocation)`, the provider consumes the snapshots, creates sessions via `createSession(viewId, webview, { ..., restoreFrom: snap })` (for `shellExited === true` snapshots no PTY is spawned), sends a single `init` with the restored tab list, then sends one `restoreFromSnapshot` per snapshot. The existing `existingTabs.length > 0` branch is preserved verbatim and runs first.
    - Verify: integration `src/providers/TerminalViewProvider.restore.test.ts`
  - **Plan**:
    1. Add the new else-if branch after the existing one inside `onReady` (around current L582-L608).
    2. Confirm the order: cancel-not-applicable here (no scheduled destroys for sidebar/panel); restore sessions through the existing factory.

- [x] 7_4 Editor `onReady` — three-case branching (existing | restore | cold)
  - **Deps**: 5_1, 7_1, 4_2
  - **Refs**: design.md D3, D7; specs/editor-tab-reload-resilience/spec.md (Editor `onReady` distinguishes existing-sessions, restore-from-snapshot, and cold-open); specs/cross-restart-session-restore/spec.md (Editor restore via panel serializer)
  - **Scope**: `src/providers/TerminalEditorProvider.ts`
  - **Acceptance**:
    - Outcome: `onReady` (currently L532-549) branches in this order:
      1. `getTabsForView(viewId).length > 0` → `sessionManager.updateWebviewForView(viewId, panel.webview)`, send `init` + `restore` per existing tab (replaying scrollback cache). DO NOT call `createSession`.
      2. `restoreSnapshots.length > 0` → create sessions with `restoreFrom: snap` (skipping PTY for exited), send `init` + `restoreFromSnapshot` per snapshot. `updateWebviewForView` is implicit in `createSession` for fresh sessions.
      3. Cold open — existing behavior unchanged.
    - Verify: integration `src/providers/TerminalEditorProvider.onReady.test.ts` (covers all three cases)
  - **Plan**:
    1. Replace the current single-branch `createSession` block at L532-549 with the three-branch structure.
    2. Reuse the existing tab/factory wiring; only the branching is new.

- [x] 7_5 Split-pane survival across reload + cross-restart
  - **Deps**: 7_3, 7_4, 8_1
  - **Refs**: design.md D12 (updated — init plumbing for splits); specs/editor-tab-reload-resilience/spec.md (Split-pane survival in init message); specs/cross-restart-session-restore/spec.md (Split-pane snapshot fields, "Tab with two split panes restored" scenario)
  - **Scope**: `src/session/SessionManager.ts`, `src/types/messages.ts`, `src/providers/TerminalEditorProvider.ts`, `src/providers/TerminalViewProvider.ts`, `src/webview/terminal/TerminalFactory.ts`, `src/webview/main.ts`
  - **Acceptance**:
    - Outcome: `SessionManager.getAllSessionsForView(viewId): Array<{id, name, customName, isActive, isSplitPane}>` returns root tabs AND split-pane children for the view. `InitMessage.tabs[i]` adds optional `isSplitPane?: boolean`. Editor `onReady` (Phase A + Phase B) and sidebar/panel `onReady` (Phase B restore branch) emit init with all sessions including splits. `TerminalFactory.createTerminal` accepts `options.isSplitPane?: boolean`; when true it does NOT initialize a `tabLayouts` leaf for the pane id and does NOT set `activeTabId`. `handleInit` iterates restored layouts after creating terminals: for each layout where `layout.type === "branch"`, it calls `splitRenderer.renderTabSplitTree(tabId)`, then `showTabContainer(activeRootTabId)` if the active tab's layout is a branch.
    - Verify: unit `src/session/SessionManager.getAllSessionsForView.test.ts` (roots + splits returned; empty view; only-roots view); integration `src/providers/TerminalEditorProvider.onReady.test.ts` extended with a split-pane scenario (Phase A existing-sessions branch sends init.tabs with isSplitPane and restore-per-pane).
  - **Plan**:
    1. Add `getAllSessionsForView` to `SessionManager`; keep `getTabsForView` unchanged (still root-only — used by tab strip and rename).
    2. Extend `InitMessage.tabs[i]` with `isSplitPane?: boolean`.
    3. In editor + sidebar/panel providers: use `getAllSessionsForView` when constructing `init.tabs`. Phase A scrollback `restore` loop iterates ALL sessions (including splits). Phase B restore-from-snapshot loop already creates split sessions via `createSession({restoreFrom: snap})`.
    4. Add `isSplitPane?: boolean` to `TerminalFactory.createTerminal` options; gate the `tabLayouts.set(id, createLeaf(id))` + `activeTabId = id` blocks on `!options?.isSplitPane`.
    5. In webview `handleInit`: pass `{isSplitPane: tab.isSplitPane}` to `factory.createTerminal`. After the create loop, iterate `store.tabLayouts.entries()` and call `splitRenderer.renderTabSplitTree(tabId)` for each branch layout; then `splitRenderer.showTabContainer(activeRootTabId)` when the active tab's layout is a branch.

## 8. Webview-side restore handler

- [x] 8_1 Add `restoreFromSnapshot` IPC message type
  - **Deps**: 5_1
  - **Refs**: design.md D8; specs/cross-restart-session-restore/spec.md (`restoreFromSnapshot` IPC message)
  - **Scope**: `src/types/messages.ts`
  - **Acceptance**:
    - Outcome: exported `RestoreFromSnapshotMessage` type and the new union variant in `ExtensionToWebViewMessage`. Includes `exitCode: number | null` for the exited-divider variant.
    - Verify: none — types-only file.
  - **Plan**:
    1. Add the new interface and union variant.

- [x] 8_2 Add divider formatter + tests
  - **Deps**: none
  - **Refs**: design.md D9; specs/cross-restart-session-restore/spec.md (Restore divider exact text)
  - **Scope**: `src/webview/terminal/restoreDivider.ts` (NEW), `src/webview/terminal/restoreDivider.test.ts` (NEW)
  - **Acceptance**:
    - Outcome: `formatRestoreDivider({snapshotAt, shellExited, exitCode}): string` returns exactly the strings in spec/D9; tests assert byte-for-byte equality including the leading `\x1b[0m` reset.
    - Verify: unit `src/webview/terminal/restoreDivider.test.ts`
  - **Plan**:
    1. Pure formatter with 24-hour zero-padded `HH:MM` from a Date built off `snapshotAt`.
    2. Branch on `shellExited` to append the exit indicator with `exitCode ?? "?"`.

- [x] 8_3 Refactor `TerminalFactory.createTerminal` to support write-before-open
  - **Deps**: 8_1
  - **Refs**: design.md D8; `/Users/huybuidac/Projects/ai-oss/anywhere-terminal/src/webview/terminal/TerminalFactory.ts:328-329` (currently `open()` is called inside the factory); `/Users/huybuidac/Projects/ai-oss/xterm.js/addons/addon-serialize/README.md` (write-before-open guidance)
  - **Scope**: `src/webview/terminal/TerminalFactory.ts`
  - **Acceptance**:
    - Outcome: `createTerminal` accepts a new option `{ deferOpen?: boolean }`. When `true`, the factory returns the `TerminalInstance` WITHOUT calling `terminal.open(container)` — the caller invokes `factory.attachDeferredTerminal(instance)` later. Default (false) preserves current behavior; existing call sites pass nothing → no change.
    - Verify: none — pure code-path guard with no logic; exercised end-to-end via the router integration in 8_4. A dedicated unit test would have to mock the entire xterm Terminal API surface for marginal value.
  - **Plan**:
    1. Add optional `deferOpen` to the create options.
    2. Guard the `terminal.open(container)` call (currently L328-329) on `!deferOpen`.
    3. Add helper `terminal.openLater(container)` is unnecessary — caller can call `instance.terminal.open(container)` directly.

- [x] 8_4 Wire `restoreFromSnapshot` in webview main router
  - **Deps**: 8_1, 8_2, 8_3
  - **Refs**: design.md D8; specs/cross-restart-session-restore/spec.md (`restoreFromSnapshot` IPC message, Restore divider exact text); specs/cross-restart-session-restore/spec.md (Exited shells restored read-only)
  - **Scope**: `src/webview/main.ts`
  - **Acceptance**:
    - Outcome: router case `restoreFromSnapshot` resolves the matching `TerminalInstance` (creating one via `createTerminal({ ..., deferOpen: true })` when absent), in this order: (1) `terminal.resize(cols, rows)`, (2) `terminal.write(serializedBuffer)`, (3) `terminal.write(formatRestoreDivider(...))`, (4) `terminal.open(container)`, (5) `fit()`, (6) attach PTY-data forwarding. For exited sessions, `instance.exited = true` is set after step 3 so input is suppressed.
    - Verify: integration `src/webview/main.restore.test.ts` (asserts write order; asserts `exited = true` propagation for exited variant)
  - **Plan**:
    1. Add the case in the existing router switch.
    2. Resolve TerminalInstance via `webviewStateStore.terminals.get(tabId)` first; fall through to factory when missing.
    3. Follow the exact step order above so the divider lands between buffer and live PTY output.

## 9. Documentation + manual matrix

- [x] 9_1 Document persistence story in README
  - **Deps**: 8_1
  - **Refs**: docs/external-research/PLAN-session-restore.md §8 (UX copy); design.md D9
  - **Scope**: `README.md`
  - **Acceptance**:
    - Outcome: README has a "Session restore" subsection covering window reload behavior, full restart behavior, the setting kill-switch, and an explicit note that running processes do NOT survive full restart (process revive is out of scope until the future tmux opt-in).
    - Verify: manual `git diff README.md` for the new section.
  - **Plan**:
    1. Reuse the framing in `docs/external-research/PLAN-session-restore.md §8` for honest copy.

- [x] 9_2 Manual restart matrix _(deferred — to be executed by the user after build sign-off; recorded in the workflow Revision Log on completion)_
  - **Deps**: 8_1
  - **Refs**: docs/external-research/PLAN-session-restore.md §3.5, §4.9
  - **Scope**: none (manual verification only)
  - **Acceptance**:
    - Outcome: manual smoke covering each row passes:
      1. Sidebar terminal with custom name + scrollback → Cmd+R → restored.
      2. Sidebar terminal with custom name + scrollback → full restart → restored, divider visible, new PTY spawned.
      3. Panel terminal → Cmd+R → restored.
      4. Panel terminal → full restart → restored.
      5. Editor terminal running `npm run dev` → Cmd+R → still running, no divider.
      6. Editor terminal → close tab → after 5 s, PTY destroyed (verify via Activity Monitor or `pgrep`).
      7. Editor terminal → full restart → restored with divider; new PTY spawned.
      8. Editor terminal with `vim` open → full restart → vim NOT redrawn; normal-buffer content restored.
      9. Toggle `anywhereTerminal.sessionRestore.enabled` off → restart → terminals come up empty; toggling back on does NOT recover prior snapshots (purged).
      10. 21st snapshot creation → oldest dropped (verify via `Developer: Inspect Webview Storage` or memento dump command).
    - Verify: manual matrix above
  - **Plan**:
    1. Execute each row, record observed behavior in the change's Revision Log.
