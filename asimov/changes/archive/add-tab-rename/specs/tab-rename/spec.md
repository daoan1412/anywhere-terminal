## ADDED Requirements

### Requirement: Custom Name Field

Every terminal tab session SHALL carry an optional `customName: string | null` field, in addition to its existing `name` field. When `customName` is non-null, the tab label displayed in the tab bar SHALL be `customName` verbatim, regardless of OSC title events, active split pane, or any other auto-derived label source. When `customName` is null, the displayed label SHALL fall back to existing auto-rename behavior.

### Requirement: Rename Command and Entry Points

The extension SHALL register a command `anywhereTerminal.renameTab` that opens a rename UX on the currently focused **root tab** (never a split-pane session). The command SHALL be invokable from:
- The command palette (label: `Anywhere Terminal: Rename Tab…` — derived from the command's `title` + `category` per design.md D8).
- A right-click context menu entry `Rename Tab…` on tab DOM elements (`webviewSection == 'terminalTab'`, group `tab@1`).
- A double-click on any tab element in the tab bar.

No default keybinding ships with the extension — users may bind one manually via VS Code's Keyboard Shortcuts UI (search `anywhereTerminal.renameTab`). The previously-considered `F2` default binding was dropped because xterm.js's input handling required a custom passthrough that didn't reliably work across all webview hosts (sidebar/panel/editor); leaving the binding to the user avoids the brittle interaction.

All three entry points SHALL converge on the same final mutation: `SessionManager.renameSession(tabId, input)` after target-tab resolution. The webview-inline (dblclick) path reaches this via the `renameTab` IPC message; the two host-side triggers (context menu, command palette) invoke `SessionManager.renameSession` directly from the command handler — no IPC round-trip required since the host already holds the target tabId.

If no target tab can be resolved (e.g. command palette invoked while no Anywhere Terminal webview is focused), the command SHALL silently no-op — no input box, no error.

### Requirement: Rename IPC Message

The shared message type module SHALL define a `RenameTabMessage`:

```
{ type: "renameTab"; tabId: string; customName: string | null }
```

This message type SHALL be added to the `WebViewToExtensionMessage` union. Both `TerminalViewProvider.handleMessage` and `TerminalEditorProvider.handleMessage` MUST handle it by delegating to `SessionManager.renameSession(tabId, customName)`. Unknown `tabId` MUST be silently ignored (same convention as other tab-keyed messages).

The `init` and `tabCreated` messages (Ext→WV) SHALL carry a `customName: string | null` field per tab so the webview restores the custom label without a separate round-trip.

### Requirement: Name Validation

`SessionManager.renameSession(sessionId, input)` SHALL apply the following normalization in order:
1. If `input` is `null`, set `customName = null` (reset to auto-name).
2. Trim leading/trailing whitespace.
3. If the trimmed string is empty, set `customName = null` (reset).
4. If the trimmed string is longer than **80 characters**, silently truncate to the first 80 characters.
5. Otherwise, set `customName` to the trimmed (possibly truncated) string.

After mutation, the host MUST broadcast the new `customName` to the owning webview (so the OSC-handler-driven render stays in sync) and write the change to `workspaceState` per the persistence requirement below.

### Requirement: Workspace Persistence

Custom names SHALL persist to `ExtensionContext.workspaceState` under the storage key `anywhereTerminal.tabCustomNames`. The stored value SHALL be a JSON-serializable record keyed by terminal **number** (not session UUID):

```
Record<string, string>   // e.g. { "1": "build", "3": "ssh prod" }
```

**Scope:** persistence reads (hydration on create) and writes (on rename) SHALL apply **only to sessions with `isSplitPane === false`**. Split-pane sessions MUST be excluded from both hydration and persisted writes — they consume numbers but are not tab identities. `SessionManager.renameSession` SHALL silently no-op when invoked on a split-pane session.

When `SessionManager.createSession` allocates a number for a new non-split-pane session, it SHALL look up that number in the persisted record and hydrate `customName` if a value exists. When `renameSession` is called on a root-tab session, it SHALL upsert the entry (or delete it when `customName` becomes null) and write the record back.

Closing a session MUST NOT delete its persisted custom-name entry — recycling the number reclaims the name on the next session. Entries are deleted only by an explicit reset (empty input).

#### Scenario: Number recycling re-applies a prior custom name

- **Given** `Terminal 2` was renamed to `"deploy"` and then closed in this workspace
- **When** a new session is created and `findAvailableNumber()` returns `2`
- **Then** the new session's `customName` SHALL be `"deploy"` immediately on creation
- **And** the tab bar SHALL display `"deploy"` from the first render

#### Scenario: Reset clears persistence

- **Given** a tab has `customName = "build"` persisted
- **When** the user submits an empty rename (after trim)
- **Then** the entry for that terminal number SHALL be deleted from `workspaceState`
- **And** the tab SHALL revert to displaying the live auto-name on the next render

### Requirement: Inline Edit Affordance

The webview SHALL implement inline rename UX via an absolutely-positioned overlay `<input>` element (NOT an input inside the tab DOM — `renderTabBar` clears `#tab-bar` via `innerHTML = ""`, which would destroy any tab-internal input). The overlay SHALL live as a child of the webview root (sibling of `#tab-bar`) and be positioned via `getBoundingClientRect` of the target tab's `.tab-name` element. On `dblclick` of a tab element, the overlay SHALL be shown over the target tab, focused, and pre-filled with the current displayed label.

The overlay MUST reposition when (a) the tab bar re-renders, (b) the window resizes, and (c) the tab bar dimensions change (e.g. sidebar drag). If the target tab is removed from the DOM while editing, rename SHALL be cancelled silently.

Keyboard and focus handling MUST be:
- **Enter** → commit: send `renameTab` with the (raw, pre-normalization) input value, hide overlay, `stopPropagation()` on the event.
- **Escape** → cancel: discard the input value, hide overlay, do NOT send any message, `stopPropagation()`.
- **Blur** → commit (same as Enter), with idempotency guard so an Enter immediately followed by blur does not commit twice.
- During an active **IME composition** (between `compositionstart` and `compositionend`), all commit triggers MUST be suppressed; only the first commit trigger AFTER `compositionend` takes effect.

Only one rename SHALL be active at a time. Starting a new dblclick while a rename overlay is open MUST commit the current one first (or cancel — implementation choice, but consistent within the webview).

#### Scenario: Escape cancels without IPC

- **Given** a tab is in inline-edit mode with input value `"foo"` (originally `"Terminal 1"`)
- **When** the user presses Escape
- **Then** no `renameTab` message is sent
- **And** the tab label visually restores to `"Terminal 1"`

#### Scenario: Empty input on Enter resets the tab

- **Given** a tab with `customName = "build"` is in inline-edit mode and the user clears the input
- **When** the user presses Enter
- **Then** a `renameTab` message with `customName: null` (or `""`, equivalently normalized) is sent
- **And** after the host round-trip, the tab displays the live auto-name (`name` field)

### Requirement: Render Priority Across Splits

When a tab has split panes and `customName` is non-null, the tab label SHALL display `customName` even when the active pane changes. The active pane's process name SHALL NOT be shown in the tab label until `customName` is cleared. This rule overrides the existing `split-focus-management` "Tab Bar Reflects Active Pane" requirement for the tab-label dimension only — active-pane state continues to drive everything else (focus, input routing, etc.).
