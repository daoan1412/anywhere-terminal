# Discovery: add-tab-rename

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Memory Recall | Done | `asm memory search` (tab rename / tab title / session label) |
| Existing Specs | Done | Direct read (`tab-bar-component`, `process-title-tracking`, `session-manager-core`, `session-manager-numbering`, `terminal-context-menu`, `tab-keyboard-shortcuts`) |
| Architecture Snapshot | Done | finder subagent (7-section map) |
| Protocol Docs | Done | Direct read (`docs/design/message-protocol.md` §11) |
| External Research | Skipped | No novel lib/API; pattern is well-established (matches VS Code's built-in terminal "Rename Terminal" command) |
| Constraint Check | Done | Reviewed `package.json` contributions referenced in `terminal-context-menu` spec |

## Key Findings

### 1. Tab title is a single `name` field, owned in two places

- **Webview** (`WebviewStateStore.TerminalInstance.name`) drives the rendered tab label via `TabBarUtils.buildTabBarData()` → `renderTabBar()`.
- **Host** (`SessionManager.TerminalSession.name`) is set once at session creation as `"Terminal N"` (where N is gap-filled from `usedNumbers`) and sent to the webview via the `init`/`tabCreated` messages.
- After init, the host `name` is not authoritative — the webview's `name` is what users see, and it gets mutated locally by the OSC title listener.

### 2. **Auto-rename already exists and will fight any custom rename**

- `TerminalFactory.ts:357-363` wires `terminal.onTitleChange` (from xterm.js) directly to `instance.name = newTitle`, then re-renders the tab bar.
- `zsh` (and many shells) emit OSC title sequences on **every prompt**, so a custom name written to `instance.name` will be overwritten within a second.
- The `process-title-tracking` spec codifies this behavior — its "Tab Bar Process Name Display" requirement assumes `name` IS the live process name.
- **Implication:** a "custom name" must be a separate field that takes priority over `name`, with the OSC listener skipping the write when a custom name is set.

### 3. IPC: well-defined slot for a new message type, already noted in protocol docs

- `docs/design/message-protocol.md` §11.1 explicitly lists `rename` (WV→Ext) as a planned future message type.
- Slot to add the type: `src/types/messages.ts` `WebViewToExtensionMessage` union.
- Dispatch slot: `TerminalViewProvider.handleMessage()` switch (`src/providers/TerminalViewProvider.ts:275-349`) — also `TerminalEditorProvider` (parallel handler).
- For the inverse direction (host pushing a rename back to webview — e.g. after restore), add to `ExtensionToWebViewMessage` and `MessageRouter` dispatch table.

### 4. Persistence: layout state is persisted, session names are not

- `WebviewStateStore.persist()` saves `tabLayouts` + `tabActivePaneIds` to `vscode.setState()` — survives webview reload (e.g. hiding/showing the view), but NOT VS Code restart, and NOT cross-workspace.
- No session name is persisted anywhere today. After extension reload, `SessionManager` rebuilds with fresh `"Terminal N"` defaults.
- For custom names to survive restart, they must be written to `ExtensionContext.workspaceState` (workspace-scoped) or `globalState` (global). Workspace scope is the conventional choice — matches VS Code's built-in behavior.
- Session IDs are UUIDs regenerated on each spawn — they cannot be the persistence key. The natural key is **terminal number** (1, 2, …) which is gap-filled and stable within a workspace.

### 5. Tab context menu does not exist yet

- The existing `terminal-context-menu` spec is keyed off `webviewSection == 'splitPane'` (right-click inside a terminal pane).
- There is no `webviewSection` set on tab elements — adding one (e.g. `terminalTab`) and corresponding `contributes.menus.webview/context` entries is required if we want a right-click "Rename" affordance on tabs.
- Alternative path with zero new contributions: a command + keyboard binding (`Anywhere Terminal: Rename Tab…`) acting on the active tab.

### 6. The renamed change was always anticipated

- Archived change `260306-1542-add-multi-tab-ui/proposal.md` explicitly cut "Tab renaming" as out-of-scope: *"FR future — `rename` message type noted in protocol doc §11"*.
- Confirms this is a planned follow-up, not a re-architecture.

### 7. Split-pane interaction (no change needed, but must be respected)

- `split-focus-management` spec: when a tab has split panes, the tab label shows the **active pane's** session name.
- A "tab" identity (the thing the user sees in the tab bar) is the *root tab session*. Splits add child sessions inside that tab, and the visible label tracks the active child.
- For rename: simplest model is "custom name lives on the root tab session" — when the user renames "the tab", we rename the root. Active-pane process-name display only applies when no custom name is set.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| `TerminalSession` (host) | `name: string` (set once, never mutated post-create) | `customName?: string` field separate from auto-name; persisted | New field + persistence layer |
| `TerminalInstance` (webview) | `name: string` (mutated by OSC) | `customName?: string` + OSC guard | New field + conditional in `onTitleChange` |
| IPC | No `rename` message type | `renameTab` (WV→Ext) and `tabRenamed` (Ext→WV, for restore broadcast) | Define + wire both |
| UX trigger | Ctrl+Tab cycling, click/dblclick on tab does nothing tab-specific, context menu only on pane | A way to invoke rename | UX decision (see Options) |
| Persistence | Layout in webview state only; nothing for names | Custom names survive VS Code restart, per-workspace | Add `workspaceState` storage keyed by terminal number |
| Reset path | n/a | Empty input clears custom name → tab reverts to auto/default | New behavior |

## Options

The change is straightforward in mechanism but has three orthogonal UX decisions. Each option below is one of those decisions — they compose. The recommendation block at the bottom names a default combination.

### D1. Custom-name priority vs auto-rename

- **D1.A — Sticky custom (Recommended).** When a custom name is set, OSC title events are ignored for that tab; the custom name is shown verbatim. Matches VS Code's built-in terminal behavior. Most predictable for users.
- **D1.B — Decorated custom.** Show `<custom> — <auto>` (e.g. `build — npm run dev`). Preserves visibility into running process but makes labels long, fights the compact 28-35px tab height, and is harder to truncate.
- **D1.C — Volatile custom.** Custom name displayed until next OSC event overwrites it. Effectively useless on `zsh`.

### D2. UX trigger to initiate rename

- **D2.A — Command + keyboard binding only (smallest surface).** Register `anywhereTerminal.renameTab` command (and bind in command palette + an optional default keybinding); command opens `vscode.window.showInputBox` and renames the active tab.
- **D2.B — Tab right-click context menu + command (Recommended).** Adds a new `webviewSection == 'terminalTab'` to tab elements, registers `Rename Tab…` in `contributes.menus.webview/context`, and also wires the command palette entry from D2.A. Discoverable + keyboard-accessible.
- **D2.C — Double-click inline edit + everything in B.** Most discoverable but requires building an inline edit affordance in the webview (input field, blur/Enter/Escape handling, click-outside dismiss). Adds non-trivial webview UI code for a small UX win over B.

### D3. Persistence scope

- **D3.A — In-session only.** Custom names die on VS Code restart. Cheapest, but feels broken — users will rename then lose it.
- **D3.B — Workspace-scoped via `workspaceState`, keyed by terminal number (Recommended).** Survives restart; per-workspace (a `Terminal 1` in project A doesn't reuse the name from project B). Matches the gap-filling number model — if `Terminal 2` is destroyed and later recreated in the same workspace, it reclaims its old custom name. (This is consistent with how `usedNumbers` already recycles slots.)
- **D3.C — Global via `globalState`.** Cross-workspace persistence. Wrong default — a "deploys" custom name from project A would bleed into project B's `Terminal 1`.

### Recommended combination

D1.A + D2.B + D3.B. Custom name is sticky, triggered via tab right-click menu + command palette, persisted to `workspaceState` keyed by terminal number. Estimated appetite: **M (≤3 days)**.

## Risks

1. **OSC title race during a rename round-trip.** User renames → message in flight to host → meanwhile shell emits OSC title → webview overwrites before the custom name applies. *Mitigation:* set the custom-name flag in the webview optimistically (in the same handler that sends the IPC), so the OSC guard kicks in immediately; host treats the IPC as authoritative for persistence only.
2. **Persistence key drift.** Terminal numbers recycle. If we persist `{ number → customName }` and later spawn `Terminal 2` in a workspace where the user previously renamed `Terminal 2`, the rename reappears. Likely desired (matches `usedNumbers` recycling), but worth calling out — could surprise users who don't expect "reused" custom names. *Mitigation:* document in design.md; offer easy "clear name" path (empty input).
3. **Tab-context-menu webviewSection collision.** Adding `terminalTab` section near the existing `splitPane` section in the same webview must not let `Rename Tab…` appear in pane-right-click menus, nor let pane commands leak into tab menus. *Mitigation:* explicit `when` clauses on every menu entry; verify via manual smoke test.
4. **Split pane semantics for "active pane name".** When a tab is split and the active pane changes, the displayed label currently switches to that pane's process name. With a custom name set on the (root) tab, do splits override the custom name? *Mitigation (recommended):* no — the custom name belongs to the tab and always wins over per-pane process names. Specify explicitly in `process-title-tracking` and `split-focus-management` delta specs.
5. **Restore ordering on `webview becoming visible`.** When the webview is reattached and `SessionManager` re-sends `init`, the custom name must come down with each tab — otherwise users see auto-names flash before the custom name lands. *Mitigation:* include `customName` in the `init` / `tabCreated` payload from the host (which knows the persisted value).

## Open Questions for Gate 1

1. Confirm D1/D2/D3 selection (recommendation is A/B/B).
2. Keyboard binding: add a default keybinding (e.g. `F2` when focus is in the webview / on the tab bar), or leave as command-only and let users self-bind?
3. Max length for a custom name (recommend 80 chars, trimmed)?
