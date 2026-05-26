# Discovery: restore-terminal-sessions

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Architecture Snapshot (AT) | Done | finder subagent |
| Internal Patterns (AT) | Done | finder subagent + direct read |
| External Research (VS Code core, xterm.js) | Done | direct read of local repos (`/Users/huybuidac/Projects/ai-oss/vscode`, `/Users/huybuidac/Projects/ai-oss/xterm.js`); librarian timed out and was bypassed |
| Memory Recall | Done | `bun run asm memory search` |
| Constraint Check (package.json, deps) | Done | direct read |

## Key Findings

### 1. AT's existing state (v0.12.2)

- **L1 sidebar/panel works**: `TerminalViewProvider.onReady` (`src/providers/TerminalViewProvider.ts:556-639`) detects `existingTabs.length > 0` and replays the `scrollbackCache` via `restore` messages without recreating PTYs. This is governed by the `view-lifecycle-resilience` spec.
- **L1 editor BROKEN**: `TerminalEditorProvider.onDidDispose` (`src/providers/TerminalEditorProvider.ts:248-257`) calls `destroyAllForView` immediately, killing the PTY on window reload (Cmd+R). Editor panel viewId is a fresh `editor-${randomUUID()}` (line 137) per construction, so even if the session survived, the new panel couldn't find it.
- **L2 missing**: no `WebviewPanelSerializer` registered (`extension.ts` has only `registerWebviewViewProvider` calls L54-72); `deactivate()` is empty (line ~526); only `tabCustomNames` is persisted to `workspaceState`; `WebviewStateStore.persist()` persists split layouts + active-pane only via `vscode.setState`, never the buffer (`src/webview/state/WebviewStateStore.ts:197-247`).
- **Scrollback cache today**: raw byte buffer `string[]`, 512KB FIFO eviction, in-memory only — survives webview reload but not extension-host restart (`SessionManager.ts`).
- **Live deps**: `@xterm/xterm@^6.0.0`, `@xterm/addon-fit@^0.11.0`, `@xterm/addon-web-links@^0.12.0`, `@xterm/addon-webgl@^0.19.0`. NOT installed: `@xterm/addon-serialize`, `@xterm/headless`.
- **Activation events today**: `onView:anywhereTerminal.sidebar`, `onView:anywhereTerminal.panel`, command activations only — no `onWebviewPanel:*`.
- **Editor viewType**: `anywhereTerminal.editor` (`TerminalEditorProvider.viewType`, registered via `vscode.window.createWebviewPanel` in `createPanel` factory, line 154-163).

### 2. VS Code core's terminal restore architecture (authoritative pattern)

Read in `/Users/huybuidac/Projects/ai-oss/vscode`:

- **Extension-host headless mirror**: `XtermSerializer` in `src/vs/platform/terminal/node/ptyService.ts:1032-1135` instantiates `new XtermTerminal({cols, rows, scrollback, allowProposedApi: true})` (from `@xterm/headless`). Every PTY output is mirrored via `_xterm.write(data)` (line ~823). On revive, the serialize addon is loaded dynamically (`(await import('@xterm/addon-serialize')).SerializeAddon`, line 1133) and `serialize({scrollback, excludeAltBuffer: true, excludeModes: true})` produces the replay string.
- **Why excludeAltBuffer/excludeModes**: when normal buffer is preferred over the live state (e.g. user was in vim) the headless terminal serializes just the normal buffer; the alt buffer (vim/htop UI) is dropped — matches VS Code issue #133516.
- **Raw "revive" buffer is a one-shot**: on session detach with no interaction, the headless mirror stores `_rawReviveBuffer` to round-trip the previous run's buffer through the new process. `freeRawReviveBuffer()` is called as soon as the user types, resizes, sets title/icon — once the session is "fresh," the live serialized buffer takes over.
- **Webview-side serialization is NOT what VS Code uses**: the only webview-side `SerializeAddon` consumer in VS Code is `terminalStickyScrollOverlay.ts` (sticky-scroll, not restore). For restore, the authoritative source is always the headless mirror in extension host.

### 3. `WebviewPanelSerializer` activation order

- `mainThreadWebviewPanels.ts:128`: on a serialized panel becoming visible, VS Code calls `extensionService.activateByEvent('onWebviewPanel:<viewType>')` BEFORE invoking `$deserializeWebviewPanel`.
- `extHostWebviewPanels.ts:291-311`: `$deserializeWebviewPanel` creates the webview, then calls `serializer.deserializeWebviewPanel(panel, state)` with the previously-saved state (whatever the webview wrote via `vscode.setState`).
- The official sample (`extensions/markdown-language-features/src/preview/previewManager.ts`) registers via `vscode.window.registerWebviewPanelSerializer(viewType, this)` with `"onWebviewPanel:markdown.preview"` in `package.json` activationEvents.
- **Implication for AT**: as long as we declare `onWebviewPanel:anywhereTerminal.editor` activation event, our `activate()` (which constructs SessionManager + registers the serializer) runs before any `deserializeWebviewPanel` is invoked. No race.

### 4. xterm SerializeAddon API surface (verified from `/Users/huybuidac/Projects/ai-oss/xterm.js/addons/addon-serialize/typings/addon-serialize.d.ts`)

```ts
serialize(options?: {
  range?: { start: IMarker | number; end: IMarker | number };
  scrollback?: number;       // rows from bottom; ignored when range given
  excludeModes?: boolean;    // skip mode state
  excludeAltBuffer?: boolean; // skip alt buffer
}): string;
```

Restore guidance from `addons/addon-serialize/README.md`: *"It's recommended that you write the serialized data into a terminal of the same size in which it originated from and then resize it after if needed."* — must resize the new xterm to the snapshot's `cols × rows` BEFORE `write`.

### 5. `@xterm/headless` is a sibling package (`/Users/huybuidac/Projects/ai-oss/xterm.js/headless/package.json`, v6.0.0). Already used by VS Code core for shell-integration + command-detection capabilities. Same major version as `@xterm/xterm@^6.0.0` already in AT.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Editor panel survives Cmd+R | ❌ destroy-on-dispose kills PTY | grace period + `WebviewPanelSerializer` | Phase A |
| Stable panel identity across reload | ❌ random UUID per construction | persist `panelId` via `webview.setState`; serializer revives with same `panelId` | Phase A |
| Live editor panels list | ❌ only `tabCustomNames` persisted | `workspaceState["anywhereTerminal.editorPanels.live"]` | Phase A |
| Authoritative buffer mirror in ext-host | ❌ raw bytes only, in-memory | `@xterm/headless` mirror per session, fed PTY data | Phase B |
| `SerializeAddon` for snapshot | ❌ not installed | add dep, dynamic import on serialize | Phase B |
| Cross-restart persistence | ❌ no disk write of buffer | `workspaceState["anywhereTerminal.sessionSnapshots"]` + debounced flush + sync flush in `deactivate` | Phase B |
| Activate-time hydrate | ❌ no rehydrate path | `SessionManager.hydrateFromSnapshots` consumed by view/editor providers when no live session exists | Phase B |
| `onWebviewPanel` activation event | ❌ missing | add to `activationEvents` | Phase A |
| `deactivate()` flush hook | ❌ empty body | flush pending snapshot writes synchronously | Phase B |
| Alt-buffer correctness (vim) | ❌ raw-byte replay redraws vim UI | `excludeAltBuffer: true, excludeModes: true` on serialize | Phase B (free via mirror) |
| Eviction (size/age/count) | ❌ none persisted | 7-day age cutoff + 20-snapshot cap + 1MB per snapshot | Phase B |
| Tmux opt-in (true process revive) | ❌ none | OUT OF SCOPE for this change — defer to a separate change |

## Options

### Option A — Webview-driven serialization (PLAN.md's "simpler" path)

Load `SerializeAddon` in the webview alongside the existing xterm; periodically (and on `beforeunload`) `serialize()` and `postMessage` the result to the extension host.

**Trade-off**: simpler dep tree (no `@xterm/headless`). But the snapshot only captures what the webview rendered. AT defers webview rendering for inactive tabs/panels — a sidebar terminal that never became visible has no snapshot. VS Code's own implementation does NOT use this pattern for restore.

### Option B — Extension-host headless mirror (Recommended — matches VS Code core)

Add `@xterm/headless` + `@xterm/addon-serialize` to extension-host deps. Per session, instantiate a headless `Terminal`, pipe `pty.onData → mirror.write(data)` (and resize forwarded), and on snapshot run `serializeAddon.serialize({scrollback, excludeAltBuffer: true, excludeModes: true})`. Persist the resulting string to `workspaceState`.

**Why recommended**: this is exactly what VS Code's `XtermSerializer` does (`ptyService.ts:1032-1135`). Single source of truth regardless of webview visibility, correct alt-buffer handling for free, dynamic import keeps cold-start cost low. Replaces today's `scrollbackCache: string[]` so we don't double-buffer.

### Option C — Tmux opt-in (Phase C from source plan)

True process revive via tmux/screen wrapping.

**Trade-off**: requires shell rewriting, breaks on Windows, conflicts with users' existing tmux configs, and per the source plan needs heavy honest framing. The source plan itself recommends shipping A+B first and treating C as a separate v0.15+ change. Defer.

**Decision (fastlane)**: Option B for capability `cross-restart-session-restore`. Bundle with Phase A (capability `editor-tab-reload-resilience`) in one change. Option C deferred to a future change.

## Risks

1. **Headless terminal CPU on every PTY write** — VS Code uses this pattern at scale; `_xterm.write(data)` is the same call already done in the webview. Per-byte cost is bounded by xterm's internal parser. Mitigation: only construct the headless mirror for sessions whose `viewLocation` supports restore (all three locations today); skip when `sessionRestore.enabled = false`.

2. **`workspaceState` bloat** — uncapped snapshots could exceed VS Code's practical comfort zone (~20MB per workspace). Mitigation: hard caps per snapshot (1MB serialized buffer, scrollback 1000 lines), per-workspace cap (20 snapshots, oldest evicted), age cutoff (7 days).

3. **Race: extension-host shutdown vs in-flight snapshot debounce** — a 1s debounce window can lose the latest data on a hard exit. Mitigation: synchronous `flushSnapshotsToStorage()` from `deactivate()`; debounce is purely for hot-loop coalescing, not for durability.

4. **Editor panel `onDidDispose` ambiguity** — VS Code does not distinguish "user closed tab" from "window reload" in the dispose callback. Mitigation: schedule destroy with a grace period (5s default); cancel the schedule when `WebviewPanelSerializer.deserializeWebviewPanel` revives with the same `panelId`. After reload the serializer fires within ~1s typically.

5. **Restore writes mid-shell-startup** — new PTY immediately produces a prompt that visually collides with the replayed buffer. Mitigation: write the serialized buffer FIRST (per xterm docs: "before `Terminal.open` is called"), resize to snapshot dimensions, then attach to the DOM and start forwarding PTY output. The PTY's own prompt then appears on a fresh line after the divider.

6. **Sidebar/panel "restore" path collision** — the existing `view-lifecycle-resilience` flow replays scrollback for live sessions. The new cross-restart path is for sessions that DON'T exist yet (post-restart). Mitigation: guard the new restore branch on `existingTabs.length === 0 && hasPersistedSnapshots(viewLocation)`; the existing branch takes precedence whenever live sessions are present.

7. **`@xterm/headless` is experimental** per its README. Mitigation: VS Code's production use of this package since 2021 demonstrates it's stable enough; dynamic import for `addon-serialize` keeps it isolated; if a defect surfaces we can fall back to the existing raw-byte scrollback path.

## Auto-decisions (fastlane)

- Adopted Option B (extension-host headless mirror) — matches VS Code core, no user prompt.
- Capability split: `editor-tab-reload-resilience` (Phase A) + `cross-restart-session-restore` (Phase B). One change, two specs.
- Tmux opt-in (Phase C) deferred to a future change.
- Scrollback default: 1000 lines per session (matches VS Code's `terminal.integrated.persistentSessionScrollback` default).
- Grace period default: 5000 ms (matches PLAN.md §3.6 recommendation).
- Snapshot cadence: debounced 1s on data + sync flush on `deactivate`. Periodic timer NOT used — coalesced debouncing already covers the loss window and avoids needless wake-ups.
