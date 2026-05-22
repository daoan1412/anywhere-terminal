## 1. Host-side data model + persistence

- [x] 1_1 Add `customName: string | null` field to `TerminalSession` and initialize on create
  - **Deps**: none
  - **Refs**: specs/session-manager-core/spec.md#Session-Data-Model; design.md D1
  - **Scope**:
    - `src/session/SessionManager.ts`
  - **Acceptance**:
    - Outcome: `TerminalSession` interface declares `customName: string | null`; every `createSession` initializes it (default `null` for new non-hydrated sessions); no existing call sites break.
    - Verify: unit src/session/SessionManager.test.ts
  - **Plan**:
    1. Add `customName: string | null` to the `TerminalSession` interface (`src/session/SessionManager.ts:19-54`).
    2. In `createSession()` (~line 163), initialize `customName: null` in the session literal.

- [x] 1_2 Inject workspaceState and add load/save helpers
  - **Deps**: 1_1
  - **Refs**: specs/tab-rename/spec.md#Workspace-Persistence; design.md D3; design.md D9
  - **Scope**:
    - `src/session/SessionManager.ts` (constructor + private helpers)
    - `src/extension.ts` (pass `context.workspaceState` into `SessionManager`)
  - **Acceptance**:
    - Outcome: `SessionManager` accepts a `Memento`-shaped dependency (just `get`/`update`); private `loadPersistedNames(): Record<string, string>` and `savePersistedNames(record): void` read/write the `anywhereTerminal.tabCustomNames` key. `savePersistedNames` calls `update` and attaches a `.catch(err => console.error)` — fire-and-forget per D9.
    - Verify: unit src/session/SessionManager.test.ts
  - **Plan**:
    1. Inject a `Memento`-shaped dep `{ get, update }` into the `SessionManager` constructor (interface declared inline or in a tiny new module).
    2. Add `private loadPersistedNames(): Record<string, string>` — return `(workspaceState.get(STORAGE_KEY) as Stored) ?? {}`; defensively handle non-object values.
    3. Add `private savePersistedNames(record: Record<string, string>): void` — fire-and-forget `workspaceState.update(STORAGE_KEY, record).then(undefined, err => console.error(...))`.
    4. Update `SessionManager` instantiation in `src/extension.ts` to pass `context.workspaceState`.

- [x] 1_3 Implement `renameSession(sessionId, input)` with normalization, broadcast, persist
  - **Deps**: 1_1, 1_2
  - **Refs**: specs/tab-rename/spec.md#Name-Validation; specs/session-manager-core/spec.md#Rename-Session-API; design.md D7; design.md D9
  - **Scope**:
    - `src/session/SessionManager.ts`
  - **Acceptance**:
    - Outcome: public `renameSession(sessionId, input: string | null): void` exists; applies trim → empty→null → truncate-to-80; no-op on unknown sessionId AND on `isSplitPane === true`; mutates `session.customName`; posts `{ type: "tabRenamed", tabId, customName }` to the session's webview; persists via `savePersistedNames` (upsert when non-null, delete entry when null) keyed by `String(session.number)`.
    - Verify: unit src/session/SessionManager.test.ts
  - **Plan**:
    1. Add the public method near `clearScrollback`.
    2. Implement `private normalizeCustomName(input: string | null): string | null` per spec (`null`/trim/empty→null/truncate-to-80).
    3. Look up session; no-op on miss or on `isSplitPane`.
    4. Assign `session.customName = normalized`; `safePostMessage(session.webview, { type: "tabRenamed", tabId: sessionId, customName: normalized })`.
    5. Load record, upsert/delete `record[String(session.number)]`, save (fire-and-forget).

- [x] 1_4 Hydrate `customName` from `workspaceState` on create (root tabs only)
  - **Deps**: 1_2, 1_3
  - **Refs**: specs/session-manager-core/spec.md#Persisted-Custom-Name-Hydration; specs/tab-rename/spec.md (Number-recycling scenario); design.md D3
  - **Scope**:
    - `src/session/SessionManager.ts`
  - **Acceptance**:
    - Outcome: when `createSession` allocates `number = N` AND `isSplitPane === false`, the new session's `customName` equals `loadPersistedNames()[String(N)] ?? null`. Split-pane creation skips the lookup entirely.
    - Verify: unit src/session/SessionManager.test.ts
  - **Plan**:
    1. After `const number = this.findAvailableNumber()`, branch on `isSplitPane`:
       - `isSplitPane === true` → `customName: null` in the session literal.
       - `isSplitPane === false` → read `loadPersistedNames()[String(number)] ?? null`.
    2. Use the result in the session literal: `customName: hydrated`.

## 2. IPC messages

- [x] 2_1 Define `RenameTabMessage` + `TabRenamedMessage`; route `renameTab` in providers
  - **Deps**: 1_3
  - **Refs**: specs/tab-rename/spec.md#Rename-IPC-Message; design.md Interfaces
  - **Scope**:
    - `src/types/messages.ts`
    - `src/providers/TerminalViewProvider.ts` (handleMessage switch ~line 275-349)
    - `src/providers/TerminalEditorProvider.ts` (handleMessage parallel)
    - `src/webview/messaging/MessageRouter.ts` (add `onTabRenamed` slot; no handler body yet)
  - **Acceptance**:
    - Outcome: types compile under `pnpm run check-types`; both providers handle `renameTab` by delegating to `sessionManager.renameSession(tabId, customName)` (raw input — host normalizes); webview `MessageRouter` exposes an `onTabRenamed` slot for later wiring.
    - Verify: unit src/providers/TerminalViewProvider.test.ts
  - **Plan**:
    1. Add the two interfaces to `src/types/messages.ts`; extend `WebViewToExtensionMessage` and `ExtensionToWebViewMessage` unions.
    2. Add `case "renameTab"` to both providers' `handleMessage` (mirror the existing `closeTab` / `switchTab` patterns).
    3. Add an `onTabRenamed` entry to the `MessageRouter` dispatch table (`src/webview/messaging/MessageRouter.ts:70-135`) — empty handler default; wired by 3_2.

- [x] 2_2 Include `customName` in `init` and `tabCreated` payloads
  - **Deps**: 1_4, 2_1
  - **Refs**: specs/tab-rename/spec.md#Rename-IPC-Message (init/tabCreated note); design.md "Restore flash" risk row
  - **Scope**:
    - `src/types/messages.ts` (per-tab info shape inside InitMessage / TabCreatedMessage)
    - `src/session/SessionManager.ts` (`getTabsForView` + the create-time `tabCreated` emission)
  - **Acceptance**:
    - Outcome: tab payloads carry `customName: string | null`; existing call sites pass a defined value (null when unset).
    - Verify: unit src/session/SessionManager.test.ts
  - **Plan**:
    1. Extend the per-tab type used by `init`/`tabCreated` (`{ id, name, isActive }`) to add `customName: string | null`.
    2. Update `getTabsForView` to populate `customName: session.customName`.
    3. Update create-time `tabCreated` emission to include the field.

## 3. Webview state + render priority

- [x] 3_1 Add `customName` to `TerminalInstance`; thread through tab-data builder
  - **Deps**: 2_2
  - **Refs**: specs/tab-bar-component/spec.md#Tab-Bar-Rendering; design.md D1
  - **Scope**:
    - `src/webview/state/WebviewStateStore.ts` (TerminalInstance interface)
    - `src/webview/TabBarUtils.ts` (TabInfo + buildTabBarData)
    - `src/webview/main.ts` (instance creation sites — wherever an init/tabCreated payload becomes a TerminalInstance)
  - **Acceptance**:
    - Outcome: `TerminalInstance` declares `customName: string | null`; `TabInfo` declares `customName`; instance-creation sites copy it from the incoming payload (default null).
    - Verify: unit src/webview/TabBar.test.ts
  - **Plan**:
    1. Add field to `TerminalInstance` (`src/webview/state/WebviewStateStore.ts:16-23`).
    2. Add field to `TabInfo` (`src/webview/TabBarUtils.ts:28-49`).
    3. Find instance-creation sites (`grep "terminals.set("` or similar in `src/webview/main.ts` / `TerminalFactory.ts`) and propagate `customName` from payload.

- [x] 3_2 Render `customName ?? name`; wire `tabRenamed` to update + re-render
  - **Deps**: 3_1, 2_1
  - **Refs**: specs/tab-bar-component/spec.md#Tab-Bar-Rendering; specs/process-title-tracking/spec.md#OSC-Title-Change-Handling; design.md D1
  - **Scope**:
    - `src/webview/TabBarUtils.ts` (`renderTabBar` — change line 84 `instance.name` → `instance.customName ?? instance.name`)
    - `src/webview/main.ts` (or wherever `MessageRouter.onTabRenamed` is registered)
  - **Acceptance**:
    - Outcome: rendered `.tab-name` text is `customName ?? name`; receiving a `tabRenamed` message updates `TerminalInstance.customName` and triggers `renderTabBar()`. The existing OSC `onTitleChange` listener (`TerminalFactory.ts:357-363`) is unchanged — it keeps writing to `instance.name` per D1.
    - Verify: unit src/webview/TabBar.test.ts
  - **Plan**:
    1. In `renderTabBar()` (`src/webview/TabBarUtils.ts:84`) change `instance.exited ? \`${instance.name} (exited)\` : instance.name` → `${instance.customName ?? instance.name}${instance.exited ? ' (exited)' : ''}`.
    2. Register an `onTabRenamed(tabId, customName)` handler that updates `store.terminals.get(tabId).customName` and calls `renderTabBar()`.

## 4. UX triggers

- [x] 4_1 Stamp `data-vscode-context` on tab DOM; register command + context menu in package.json
  - **Deps**: 2_1
  - **Refs**: specs/tab-bar-component/spec.md#Tab-Bar-Rendering; specs/terminal-context-menu/spec.md#Context-Menu-Contribution-Points; design.md D8
  - **Scope**:
    - `src/webview/TabBarUtils.ts` (renderTabBar — add `dataset.vscodeContext` per tab)
    - `package.json` (`contributes.commands` + `contributes.menus."webview/context"`)
  - **Acceptance**:
    - Outcome: each tab `<div>` carries `data-vscode-context='{"webviewSection":"terminalTab","tabId":"<id>"}'`; `package.json` declares the command with `title: "Rename Tab…"`, `category: "Anywhere Terminal"`; `webview/context` adds the `tab@1` entry gated on `webviewSection == 'terminalTab'`.
    - Verify: manual right-click a tab shows Rename Tab; right-click inside a pane does not
  - **Plan**:
    1. In `renderTabBar()` (`src/webview/TabBarUtils.ts:78-85`), set `tab.dataset.vscodeContext = JSON.stringify({ webviewSection: "terminalTab", tabId: id })`.
    2. In `package.json` `contributes.commands`, add `{ command: "anywhereTerminal.renameTab", title: "Rename Tab…", category: "Anywhere Terminal" }`.
    3. In `contributes.menus."webview/context"`, add the `tab@1` entry per spec table. No `commandPalette` override needed (D8).

- [x] 4_2a Build inline-edit overlay module
  - **Deps**: 3_2
  - **Refs**: specs/tab-rename/spec.md#Inline-Edit-Affordance; design.md D4
  - **Scope**:
    - `src/webview/tabRenameOverlay.ts` (new)
    - `src/webview/main.ts` (mount overlay container in DOM)
    - `media/main.css` (or equivalent — overlay styling matching tab font/size)
  - **Acceptance**:
    - Outcome: a new module exports `showRenameOverlay({tabBarEl, targetTabEl, initialValue, onCommit, onCancel})`, `hideRenameOverlay()`, `repositionRenameOverlay()`. The overlay is an absolutely-positioned `<input>` mounted as a child of the webview root, positioned via `getBoundingClientRect` of `targetTabEl.querySelector('.tab-name')`. Keyboard: Enter→onCommit + hide + stopPropagation; Escape→onCancel + hide + stopPropagation; blur→onCommit (idempotency-guarded); IME compositionstart/end suppresses commits. ResizeObserver on `tabBarEl` + `window.resize` listener call `repositionRenameOverlay()`.
    - Verify: unit src/webview/tabRenameOverlay.test.ts
  - **Plan**:
    1. New file `src/webview/tabRenameOverlay.ts`. Module-level `let state: { input: HTMLInputElement; targetTab: HTMLElement; committed: boolean; composing: boolean; resizeObs: ResizeObserver; onWindowResize: () => void; cleanup: () => void } | null = null`.
    2. `showRenameOverlay`: dismount any prior overlay, create `<input>` with class `tab-rename-overlay`, append to `document.body` (or a designated overlay root), set value + focus + selection, position via `targetTab.querySelector('.tab-name').getBoundingClientRect()`.
    3. Wire `keydown` (Enter/Escape, both `stopPropagation`), `blur` (idempotency-guarded commit), `compositionstart`/`compositionend` to flip `composing`. Both Enter and blur call a single `commit()` that early-returns when `state.committed`.
    4. `ResizeObserver` on `tabBarEl` + `window.addEventListener('resize', onWindowResize)` call `repositionRenameOverlay()`. Also: if `targetTab` is no longer in the DOM (`!document.contains(state.targetTab)`), call `hideRenameOverlay()` and `onCancel()` silently.
    5. `hideRenameOverlay`: disconnect observer, remove window listener, remove input from DOM, set `state = null`.

- [x] 4_2b Wire dblclick on tab elements to overlay; track rename state
  - **Deps**: 4_2a
  - **Refs**: specs/tab-rename/spec.md#Inline-Edit-Affordance; specs/tab-bar-component/spec.md#Tab-Click-Handlers; design.md D4
  - **Scope**:
    - `src/webview/TabBarUtils.ts` (add `dblclick` listener per tab; call repositionRenameOverlay at tail when active)
    - `src/webview/state/WebviewStateStore.ts` (add `renameSession: { tabId; originalDisplayedValue } | null` + `beginRename` / `endRename` methods)
  - **Acceptance**:
    - Outcome: dblclick on a tab calls `beginRename(tabId, displayedLabel)` + `showRenameOverlay(...)` with onCommit posting `{ type: "renameTab", tabId, customName: inputValue }` and `endRename()`, and onCancel just `endRename()`. While `renameSession` is non-null, every `renderTabBar()` call ends with `repositionRenameOverlay()` so the overlay stays anchored. Removing the editing tab triggers the overlay's own DOM-presence check → silent cancel.
    - Verify: unit src/webview/TabBar.test.ts
  - **Plan**:
    1. Add `renameSession: { tabId: string; originalDisplayedValue: string } | null = null` + `beginRename` / `endRename` to `WebviewStateStore`.
    2. In `renderTabBar()`, add `tab.addEventListener("dblclick", (e) => { e.stopPropagation(); /* lookup tab, displayed label, beginRename + showRenameOverlay */ })`.
    3. At tail of `renderTabBar()`, if `store.renameSession`, call `repositionRenameOverlay()`.
    4. `onCommit(value)` → `vscode.postMessage({ type: "renameTab", tabId, customName: value })`; `endRename()`. `onCancel()` → `endRename()`.

- [x] 4_3a Add `getActiveTabId()` to TerminalViewProvider
  - **Deps**: 2_2
  - **Refs**: design.md D5
  - **Scope**:
    - `src/providers/TerminalViewProvider.ts`
  - **Acceptance**:
    - Outcome: new public method returns the active *root tab* id for this view: `this.sessionManager.getTabsForView(this.getViewId()).find(t => t.isActive)?.id`. Distinct from the existing `getActiveSessionId()` (which returns the active pane id, line 628).
    - Verify: unit src/providers/TerminalViewProvider.test.ts
  - **Plan**:
    1. Add `getActiveTabId(): string | undefined` next to `getActiveSessionId()` (~line 628).
    2. Implement as `getTabsForView(this.getViewId()).find(t => t.isActive)?.id`.

- [x] 4_3b Add instance registry + active-provider tracking to TerminalEditorProvider
  - **Deps**: 2_2
  - **Refs**: design.md D5; "Editor provider has no focus tracking" risk row
  - **Scope**:
    - `src/providers/TerminalEditorProvider.ts`
  - **Acceptance**:
    - Outcome: a static `Map<vscode.WebviewPanel, TerminalEditorProvider>` tracks instances; `createPanel` registers and removes on `panel.onDidDispose`; new static `getActiveProvider(): TerminalEditorProvider | undefined` returns the provider whose panel has `panel.active === true`; new instance method `getActiveTabId(): string | undefined` uses `sessionManager.getTabsForView(this._viewId)`.
    - Verify: unit src/providers/TerminalEditorProvider.test.ts
  - **Plan**:
    1. Replace the discarded `const _provider = new ...` at line 74 with `const provider = new ...; TerminalEditorProvider._instances.set(panel, provider);`.
    2. Add a static field `private static readonly _instances = new Map<vscode.WebviewPanel, TerminalEditorProvider>();`.
    3. In `setupPanel()` (already registers `onDidDispose`), add `TerminalEditorProvider._instances.delete(this._panel)` to the dispose handler.
    4. Add static `getActiveProvider(): TerminalEditorProvider | undefined` — iterate `_instances`, return the one where `panel.active === true`.
    5. Add instance method `getActiveTabId(): string | undefined` mirroring 4_3a's implementation.

- [x] 4_3c Register `anywhereTerminal.renameTab` command handler
  - **Deps**: 4_3a, 4_3b, 1_3
  - **Refs**: specs/tab-rename/spec.md#Rename-Command-and-Entry-Points; design.md D5; design.md D6; design.md D7
  - **Scope**:
    - `src/extension.ts` (command registration near other `anywhereTerminal.ctx.*` registrations, ~line 183-200)
  - **Acceptance**:
    - Outcome: command resolves the target tab via D5's chain: (1) context-menu arg `{ tabId }` if present, else (2) first focused `TerminalViewProvider` with `getActiveTabId()` truthy, else (3) `TerminalEditorProvider.getActiveProvider()?.getActiveTabId()`, else (4) silent no-op. With a resolved `tabId`: read the current displayed value (`session.customName ?? session.name`), call `vscode.window.showInputBox({ prompt: "Rename Tab", value: currentDisplayed })`. On `result !== undefined`, call `sessionManager.renameSession(tabId, result)`. On `result === undefined` (dismissal), no-op.
    - Verify: unit src/extension.test.ts
  - **Plan**:
    1. Register command in `src/extension.ts` near other `anywhereTerminal.ctx.*` (`extension.ts:183-200`).
    2. Implement a `resolveRenameTarget(arg, viewProviders, editorProvider)` helper per D5 ordering.
    3. Branch on null → silent return. Otherwise look up `session = sessionManager.getSession(tabId)`, seed `currentDisplayed = session.customName ?? session.name`.
    4. `await vscode.window.showInputBox(...)`; on truthy/empty (not undefined) → `sessionManager.renameSession(tabId, result)`.

- [x] 4_3d Add F2 keybinding contribution in package.json
  - **Deps**: 4_3c
  - **Refs**: design.md D6
  - **Scope**:
    - `package.json` (`contributes.keybindings`)
  - **Acceptance**:
    - Outcome: keybinding entry `{ command: "anywhereTerminal.renameTab", key: "F2", when: "focusedView == anywhereTerminal.sidebar || focusedView == anywhereTerminal.panel || focusedView == anywhereTerminal.secondary || activeWebviewPanelId == anywhereTerminal.editor" }` is present. F2 in a text editor still triggers `editor.action.rename`, not ours.
    - Verify: manual F2 in webview opens rename; F2 in editor renames symbol as before
  - **Plan**:
    1. Add the entry under `contributes.keybindings` in `package.json` (existing entries at lines 408-415 show the convention).
    2. Verify `anywhereTerminal.secondary` is a real view id by greping `package.json` — if not, drop that clause.

## 5. Documentation

- [x] 5_1 Update protocol docs to graduate `rename` from "future" to "current"
  - **Deps**: 2_1
  - **Refs**: design.md D2; specs/tab-rename/spec.md#Rename-IPC-Message
  - **Scope**:
    - `docs/design/message-protocol.md` (§3 add `renameTab` + `tabRenamed`; §11.1 remove `rename` from "future" list)
  - **Acceptance**:
    - Outcome: §3 documents both new message types with shapes matching `src/types/messages.ts`; §11.1 no longer lists `rename` as future (or notes it landed in `add-tab-rename`).
    - Verify: none — docs only
  - **Plan**:
    1. In `docs/design/message-protocol.md` §3, add subsections for `renameTab` (WV→Ext) and `tabRenamed` (Ext→WV), with the type shapes and a short paragraph each.
    2. In §11.1, strike the `rename` row (or add a "(landed in add-tab-rename)" note).

## 6. Tests + manual smoke

- [x] 6_1 Unit tests: SessionManager rename + persistence + hydration + split-pane exclusion
  - **Deps**: 1_3, 1_4
  - **Refs**: specs/tab-rename/spec.md#Name-Validation; specs/tab-rename/spec.md#Workspace-Persistence; specs/session-manager-core/spec.md#Rename-Session-API
  - **Scope**:
    - `src/session/SessionManager.test.ts` (extend; or split off `SessionManager.rename.test.ts` if file is too large)
  - **Acceptance**:
    - Outcome: cases — normalization (null, whitespace-only, 81-char truncate, valid passthrough), persistence (upsert + delete on null), hydration of root tab from prepopulated record, split-pane create skips hydration, renameSession on split-pane is silent no-op, renameSession on unknown id is silent no-op, broadcast `tabRenamed` payload shape, persist call is fire-and-forget (error in mock `update` does not throw from `renameSession`).
    - Verify: unit src/session/SessionManager.test.ts
  - **Plan**:
    1. Use existing fake `MessageSender` pattern.
    2. Tiny in-memory `Memento` mock (`get`/`update` over a Map; second `update` can be configured to throw to assert fire-and-forget).
    3. One test per spec scenario.

- [x] 6_2 Unit tests: TabBar render priority + inline-edit overlay lifecycle
  - **Deps**: 3_2, 4_2a, 4_2b
  - **Refs**: specs/tab-bar-component/spec.md; specs/tab-rename/spec.md#Inline-Edit-Affordance; design.md D4
  - **Scope**:
    - `src/webview/TabBar.test.ts` (extend)
    - `src/webview/tabRenameOverlay.test.ts` (new)
  - **Acceptance**:
    - Outcome: render shows `customName` when set / `name` when null; OSC update (set `name`) does not change displayed label while `customName` is set. Overlay tests: dblclick → overlay mounted at correct position; Enter → onCommit called with input value + overlay hidden + event.stopPropagation; Escape → onCancel + no onCommit; blur → onCommit (idempotency: Enter+blur fires once); compositionstart suppresses commits until compositionend; tab removal → onCancel silently.
    - Verify: unit src/webview/tabRenameOverlay.test.ts
  - **Plan**:
    1. Reuse jsdom TabBar test scaffold (`src/webview/TabBar.test.ts:97-107`).
    2. For IME: dispatch `new CompositionEvent("compositionstart")` then `blur` → assert no onCommit; then `compositionend` + `blur` → assert one onCommit.
    3. For idempotency: trigger Enter → assert onCommit; trigger blur → assert no second onCommit.

- [x] 6_3 Unit tests: command handler resolution chain
  - **Deps**: 4_3c
  - **Refs**: design.md D5
  - **Scope**:
    - `src/extension.test.ts` (or wherever extension command registration is tested)
  - **Acceptance**:
    - Outcome: cases — (a) command invoked with `{tabId: "abc"}` arg → calls `renameSession("abc", ...)`; (b) no arg, focused view provider returns "tab-1" → uses "tab-1"; (c) no arg, no view focused, editor provider active with tab "ed-1" → uses "ed-1"; (d) no arg, nothing focused → silent no-op, no `showInputBox` called; (e) showInputBox returns `undefined` → no `renameSession` call.
    - Verify: unit src/extension.test.ts
  - **Plan**:
    1. Mock `vscode.window.showInputBox`, mock providers to control `getActiveTabId()` and focused state.
    2. One test per branch.

- [ ] 6_4 Manual smoke
  - **Deps**: 4_2b, 4_3c, 4_3d, 5_1
  - **Refs**: specs/tab-rename/spec.md (all)
  - **Scope**: (manual)
  - **Acceptance**:
    - Outcome: in a freshly built extension dev host, exercise all four triggers (dblclick, right-click menu, command palette, F2 in sidebar + F2 in editor area), reset path (empty input), restart-survival (rename → reload window → name persists), split-pane scenario (custom name wins over active-pane process name), and the cross-shadow check (F2 in a Markdown file still triggers rename symbol).
    - Verify: manual exercise all triggers across views; verify reset, reload persistence, split override, and editor F2 isolation
  - **Plan**:
    1. `pnpm run watch` then F5 to launch Extension Development Host.
    2. Walk the matrix above; record any deviations as follow-up tasks.
