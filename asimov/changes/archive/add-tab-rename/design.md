# Design: add-tab-rename

> **Revision note:** This design was revised after oracle review (REVISE) + research into VS Code's built-in terminal rename (persisted at `docs/research/20260522-vscode-terminal-rename.md`). Patterns mirror VS Code's where applicable.

## Decisions

### D1: Two fields, render-priority — not OSC short-circuit

`TerminalSession` and `TerminalInstance` carry both `name` (auto, mutated by OSC) and `customName` (user, set via rename API). The OSC `onTitleChange` handler keeps writing to `name` unconditionally; the tab renderer uses `customName ?? name`.

**Rejected alternative:** guard the OSC handler so it only writes when `customName` is null. Cheaper at first glance, but clearing a custom name then shows the *stale* auto-name from before the rename until the next prompt cycle. Always-write means clearing customName instantly reveals the live process name.

**Validated against VS Code:** VS Code's `_setTitle` treats `title` as a single live field but applies title-source priority; our two-field equivalent is the same idea in different shape. Same render outcome.

### D2: Host owns `customName`; webview mirrors

`SessionManager.renameSession()` is the only mutation entry point. Flow on user rename (any trigger):

1. Trigger → resolve target root tab id (see D5).
2. Webview path (dblclick): sends `renameTab` IPC with the raw input value.
   Host paths (right-click / command palette / F2): host invokes `SessionManager.renameSession(tabId, input)` directly, no IPC round-trip from webview needed for the *invocation* (the host already has the tabId).
3. Host normalizes (trim → empty→null → truncate-80) → writes `TerminalSession.customName` → writes `workspaceState` (fire-and-forget per D9) → broadcasts `tabRenamed` to the owning webview.
4. Webview applies `tabRenamed` to `TerminalInstance.customName` → re-renders tab bar.

The webview's pre-IPC optimistic update is **for inline-edit dismissal only** (closing the input to whatever the user typed); the canonical `customName` value comes from the host echo, which may rewrite for whitespace trim / truncation.

### D3: Persistence — workspace-scoped, keyed by terminal number, root-tab sessions only

**Storage key:** `anywhereTerminal.tabCustomNames` in `ExtensionContext.workspaceState`. Shape: `Record<string, string>` (number → custom name).

**Critical scope:** persistence reads and writes apply **only to sessions with `isSplitPane === false`**. Split panes are excluded because:
- Split panes consume `usedNumbers` (per `SessionManager.createSession`) but are hidden from the tab list. Persisting custom names for them would let a recycled number resurrect a custom name on what becomes a root tab.
- Users see and rename root tabs only — the custom name is a tab-level concept, not a pane-level concept (see D5 for the rename target rule).

Implementation: `loadPersistedNames()` is consulted in `createSession` only when `!isSplitPane`. `savePersistedNames()` is called from `renameSession` only when the target session has `!isSplitPane`. `renameSession` MUST silently no-op on split-pane sessions (treat as invalid target — the dispatch in providers always resolves to root tab id, so this is defensive).

**No GC on close.** Closing a tab MUST NOT delete the persisted entry. Recycling a number reclaims the name (spec'd as a scenario). The only deletion path is an explicit reset (empty input → `customName = null` → delete entry).

**Rejected alternatives:**
- Persistence applied to all sessions (including splits): split-pane number collisions corrupt the root-tab name space. Concrete failure: a user has a single split tab where pane B got number 2; user renames pane B; pane B closes; user opens a new root tab — gets number 2 with the pane B name. Surprise.
- GC on close: defeats the "recycling reclaims the name" semantic, which is the whole point of number-keyed storage.

### D4: Inline edit uses an absolutely-positioned overlay `<input>`

`renderTabBar()` clears `#tab-bar` via `innerHTML = ""` (`TabBarUtils.ts:74`). Any plan that puts the inline `<input>` *inside* a tab element will lose focus and selection on every tab-bar refresh (OSC title update, tab create/close, split focus change). The fix is to keep the input **outside** the tab bar's destructive render path.

**Approach:** a single, lazily-mounted `<input class="tab-rename-overlay">` lives as a child of the webview root (or as a sibling of `#tab-bar`), positioned absolutely with `getBoundingClientRect` from the target tab's `.tab-name` element. On dismount (commit/cancel), the overlay is hidden and the underlying tab span (now showing the post-commit label) is revealed.

The overlay must reposition when:
- The tab bar re-renders (subscribe via a `MutationObserver` on `#tab-bar`, or, simpler, call `repositionOverlay()` at the tail of `renderTabBar()` when overlay is active).
- The window resizes (`window.addEventListener('resize', ...)`).
- The tab being edited is removed or its containing tab bar disappears → commit (or cancel — see below) and dispose.

Editing state lives in `WebviewStateStore.renameSession: { tabId, originalDisplayedValue } | null` (or `null` when no rename is active). One rename at a time — starting a new dblclick while editing commits the prior one first.

**Keyboard / focus contract:**
- `Enter` → commit (send `renameTab`, hide overlay). Event MUST `stopPropagation()` so xterm and global handlers don't receive the keypress.
- `Escape` → cancel (hide overlay, no IPC). Event MUST `stopPropagation()`.
- `blur` → commit (same as Enter), UNLESS commit-already-fired-this-tick (idempotency guard).
- During an IME composition (between `compositionstart` and `compositionend`), suppress all commit triggers — only the post-composition blur commits.
- Tab removal while editing → cancel silently (no IPC, dispose overlay).

**Rejected alternative:** refactor `renderTabBar()` to a node-stable DOM reconciler (like VS Code's `WorkbenchList`). Cleaner long-term, but much bigger scope — touches every render call site and changes how tabs are appended. Overlay is contained inside a new module and leaves `renderTabBar()` unchanged. Note for future: if other features need stable rows (drag-to-reorder, animations), reconciler becomes the right call.

**VS Code parallel:** VS Code keeps edit state in `ITerminalEditingService` (external to row model) and uses `WorkbenchList` for row identity. Our state-external approach matches VS Code; our DOM strategy (overlay vs reconciler) is a deliberate scope choice.

### D5: Focused-tab resolution — explicit `getActiveTabId()` plus editor provider registry

The rename target is always a **root tab session**, never a split pane. Each trigger needs to resolve a root tab id:

| Trigger | Source of tabId |
|---|---|
| Dblclick on tab (webview) | The clicked tab element's `data-tab-id` (always a root tab id — tab bar only renders root tabs per existing `getTabsForView`). |
| Right-click → `Rename Tab…` | The command receives the menu context as its argument: `{ webviewSection: "terminalTab", tabId }`. Direct read. |
| Command palette | Host resolves: focused Anywhere Terminal provider → `getActiveTabId()`. No-op if no provider has focus. |
| F2 keybinding | Same as command palette (same command). |

Two host-side gaps must be filled (the oracle's critical findings):

1. **`TerminalViewProvider.getActiveTabId()` (new)** — returns the *root tab id* for the currently active tab in this view. NOT the active pane id (`getActiveSessionId` at `TerminalViewProvider.ts:628` returns the pane). The mapping from pane → root tab id requires consulting the webview's split layout, but a simpler model is available: the view's session manager already tracks `isActive` on root tab sessions in `viewSessions` — so `getActiveTabId()` is `sessionManager.getTabsForView(this.getViewId()).find(t => t.isActive)?.id`. (`getTabsForView` filters out split panes per `SessionManager.ts:282-289`.)

2. **`TerminalEditorProvider` instance registry (new)** — `TerminalEditorProvider.createPanel` currently constructs a provider and **discards the reference** (`TerminalEditorProvider.ts:74`: `const _provider = new ...`). The static `_activePanels` only tracks `WebviewPanel` objects, not provider instances. To support host-side rename for editor terminals:
   - Replace the local `_provider` capture with a static `Map<WebviewPanel, TerminalEditorProvider>` (or keyed by `panel.viewType + ID`).
   - Add `TerminalEditorProvider.getActivePanel(): WebviewPanel | undefined` that returns the panel where `webviewPanel.active === true` (VS Code maintains `active`/`visible` on each panel).
   - Add `getActiveTabId()` on the provider instance — same shape as the view provider's method, using `sessionManager.getTabsForView(this._viewId)`.

The rename command's resolution order:

```ts
function resolveRenameTarget(arg?: { tabId?: string }): { providerKind: ..., tabId: string } | null {
  // 1. Context menu payload
  if (arg?.tabId) return ...;
  // 2. Focused view provider (sidebar/panel/secondary)
  for (const p of focusedTerminalViewProviders()) {
    const tid = p.getActiveTabId();
    if (tid) return { providerKind: "view", ..., tabId: tid };
  }
  // 3. Active editor panel provider
  const editor = TerminalEditorProvider.getActiveProvider();
  if (editor) {
    const tid = editor.getActiveTabId();
    if (tid) return { providerKind: "editor", ..., tabId: tid };
  }
  // 4. Nothing — silent no-op (do NOT showInputBox if no target).
  return null;
}
```

"Focused view provider" reuses the existing per-provider focus-tracking machinery hinted at by `_lastActivePaneSessionId` — providers know whether their webview holds focus. If multiple providers report focused (shouldn't happen with VS Code's single-focus invariant, but be defensive), pick the most recently focused one.

**VS Code parallel:** VS Code uses `_hostActiveTerminals` Map keyed by terminal host (panel vs editor), checking `hasFocus` per active terminal, with fallback to `_activeInstance`. Our two-tier (view providers + editor provider) is the same shape.

### D6: No default keybinding ships

Originally planned an `F2` default keybinding scoped to AT webviews. Dropped during build because xterm.js's `attachCustomKeyEventHandler` processes unmodified function keys (sends `\x1bOQ` to PTY + calls `preventDefault()`), eating F2 before VS Code's keybinding layer can match it. A passthrough branch (`if (event.key === "F2") return false`) in `InputHandler.ts` made it work in some cases but not reliably across all webview hosts.

**Decision:** ship without a default keybinding. The command `anywhereTerminal.renameTab` is fully registered; users who want a keybinding can add one via VS Code's Keyboard Shortcuts UI (search for the command id). This avoids:
- Reserving F2 (a common shell key in some configurations)
- Conflicting with xterm's escape-sequence handling
- Maintaining a brittle passthrough special-case in the keystroke pipeline

**Rejected alternative:** ship the F2 binding + xterm passthrough anyway. The user can already trigger rename via right-click + command palette + dblclick (three discoverable surfaces). A fourth keyboard shortcut is convenience, not core UX, and the maintenance cost of the xterm passthrough is not worth that convenience.

### D7: Validation defaults (trim, empty→null, max 80 chars)

- **Trim:** leading/trailing whitespace stripped. Internal whitespace preserved.
- **Empty after trim → null:** "reset" gesture. Applies to **all triggers** — inline-edit Enter, `showInputBox` Enter with empty, etc. This is a deliberate divergence from VS Code, which only treats empty as reset in the inline-edit path; `showInputBox`/quick-pick with empty does nothing. We unify the rule for predictability — one normalization function in one place.
- **Max 80 chars:** silently truncated at the host. 80 chars chosen for the 28-35px-tall tab area; longer is visually pointless.

No `validateInput` on `showInputBox` — host normalization is authoritative. Showing live validation hints isn't worth the noise.

### D8: Command label — single command, palette uses category prefix

Single command id: `anywhereTerminal.renameTab`. Manifest entry (mirrors VS Code's pattern: `title` + `category` auto-prefixes the palette label):

```json
{
  "command": "anywhereTerminal.renameTab",
  "title": "Rename Tab…",
  "category": "Anywhere Terminal"
}
```

Command palette will show `Anywhere Terminal: Rename Tab…`. Context menu entry overrides the visible label per VS Code menu mechanics:

```json
{
  "command": "anywhereTerminal.renameTab",
  "when": "webviewSection == 'terminalTab'",
  "group": "tab@1"
  // menu UI shows the command's `title` ("Rename Tab…"), not the category prefix
}
```

**Rejected alternative:** two command IDs (one for palette, one for context-menu). VS Code intentionally collapses to one — the category prefix is exactly the menu-label-divergence mechanism.

### D9: `Memento.update` is async — fire-and-forget with error log

`vscode.Memento.update(key, value): Promise<void>`. Treating `renameSession` as `Promise<void>` would force every call site (provider message handlers, command callbacks) to either await or `.then` — invasive for a UX-light operation.

Decision: `renameSession(sessionId, input): void` is synchronous in return; the internal `savePersistedNames()` call is fire-and-forget with a `.catch(err => log)`. Failure modes are bounded: workspaceState writes essentially never fail outside disk-full / read-only-fs scenarios, and a write loss only means the custom name is in-memory-only for that session. Worth accepting for the API simplicity.

In-memory `customName` is set BEFORE the persist call returns — so the IPC echo to the webview is not contingent on persistence.

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| OSC handler ↔ render | Race on rename round-trip — shell emits OSC title between user commit and host echo. | D1 render-priority is naturally race-safe: once webview sets optimistic `customName` (or host echo lands), the `customName ?? name` expression ignores OSC writes to `name`. No mutex. |
| Persistence number recycling | Recycled `Terminal 2` resurfaces the prior `"deploy"` name. | Documented spec scenario; reset path is empty-Enter. Matches existing `usedNumbers` recycling — no new mental model. |
| Split-pane number hijack of persistence | Split pane consuming number `N` would leak its custom name onto a future root tab with number `N`. | D3: persistence reads + writes gated on `!isSplitPane`. Defensive no-op in `renameSession` for split-pane targets. |
| Inline-edit input destroyed by re-render | `renderTabBar` clears `innerHTML`; inputs inside tabs lose focus on every OSC update. | D4: overlay input outside `#tab-bar`, repositioned by ResizeObserver + render-tail hook. Survives all `renderTabBar` calls. |
| Webview section collision | `Rename Tab…` leaks to pane right-click or pane commands leak to tab right-click. | Strict `when: webviewSection == 'terminalTab'` on the new entry; existing entries gated to `splitPane`. Two scenarios in `terminal-context-menu` delta verify both directions. |
| F2 shadows editor rename symbol | If `when` is too broad, F2 in a text editor triggers our command. | D6: `when` clause is restricted to specific `focusedView`/`activeWebviewPanelId` values that exclude text editors. Plus D5's resolution returns `null` (no input box) when target can't be resolved — defense in depth. |
| Editor provider has no focus tracking | F2/command palette can't resolve "active editor terminal tab" since `TerminalEditorProvider` instances are discarded. | D5: add static provider-instance registry (`Map<WebviewPanel, TerminalEditorProvider>`), plus `getActiveTabId()` + `getActiveProvider()` static helpers. Task 4_3a covers this explicitly. |
| Restore flash | When webview reattaches, tabs render with auto-name `"Terminal N"` for one frame before `customName` arrives. | Include `customName` in `init` and `tabCreated` payloads. Renderer always uses `customName ?? name`. First render shows correct label. |
| Memento.update failure | Persist call rejects (disk full / read-only). User loses persistence for that rename. | D9: in-memory state already updated; persistence failure is logged but does not affect the current session. Acceptable degradation. |
| Multiple editor webview panels | Multiple `anywhereTerminal.editor` panels can coexist; each holds its own session manager view. | Provider-instance registry keyed by `WebviewPanel` (D5) handles this naturally — each panel has its own provider with its own `getActiveTabId()`. |
| Overlay positioning drift | Browser zoom, font change, sidebar drag — overlay desynchronizes from tab. | D4: ResizeObserver on `#tab-bar` + window `resize`; `repositionOverlay()` called at the tail of every `renderTabBar()`. On any failure to find target tab in DOM → cancel rename silently. |

## Interfaces

### `SessionManager` additions

```ts
class SessionManager {
  constructor(workspaceState: { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> });

  renameSession(sessionId: string, input: string | null): void;  // sync; persist is fire-and-forget per D9
}

interface TerminalSession {
  customName: string | null;
}
```

### IPC additions (`src/types/messages.ts`)

```ts
// WebView → Extension (inline-edit dblclick path only)
export interface RenameTabMessage {
  type: "renameTab";
  tabId: string;
  customName: string | null;
}

// Extension → WebView (host pushes normalized value after any rename, regardless of trigger)
export interface TabRenamedMessage {
  type: "tabRenamed";
  tabId: string;
  customName: string | null;
}

// init / tabCreated payloads gain (per tab):
//   customName: string | null
```

### Provider additions

```ts
class TerminalViewProvider {
  getActiveTabId(): string | undefined;  // root tab id (NOT pane id like getActiveSessionId)
}

class TerminalEditorProvider {
  static _instances: Map<vscode.WebviewPanel, TerminalEditorProvider>;
  static getActiveProvider(): TerminalEditorProvider | undefined;  // walks active panels
  getActiveTabId(): string | undefined;
}
```

### Storage shape (`workspaceState`)

```ts
const STORAGE_KEY = "anywhereTerminal.tabCustomNames";
type Stored = Record<string, string>;  // String(number) → custom name
```

### Webview state additions

```ts
interface TerminalInstance {
  customName: string | null;
}

class WebviewStateStore {
  renameSession: { tabId: string; originalDisplayedValue: string } | null;  // current inline-edit, if any
  beginRename(tabId: string, originalDisplayedValue: string): void;
  endRename(): void;
}
```

### Inline-edit overlay module

```ts
// src/webview/tabRenameOverlay.ts (new)
export function showRenameOverlay(opts: {
  tabBarEl: HTMLElement;
  targetTabEl: HTMLElement;
  initialValue: string;
  onCommit: (value: string) => void;  // value is raw input; host normalizes
  onCancel: () => void;
}): void;
export function hideRenameOverlay(): void;
export function repositionRenameOverlay(): void;  // called from renderTabBar tail when overlay is active
```
