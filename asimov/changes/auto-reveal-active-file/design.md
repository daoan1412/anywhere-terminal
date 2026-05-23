# Design: auto-reveal-active-file

## Decisions

### D1: Extend `RevealInFileTreeMessage` additively with `absPath` + `focusNoScroll` + `source`; keep `sessionId/cwd` for the existing OSC 7 path

The webview already has a fully working `RevealInFileTreeMessage` → `MessageRouter.onRevealInFileTree` → `FileTreeController.handleReveal` → `FileTreePanel.revealPath` pipeline. Today the payload is `{ type, sessionId, cwd }` — the controller resolves a directory path from `sessionId` (querying `getInstanceCwd`) and falls back to the last known workspace root. Auto-reveal does NOT have a `sessionId` (it's keyed off an editor tab, not a terminal pane).

Choice: extend additively, do NOT introduce a parallel message type.

```typescript
interface RevealInFileTreeMessage {
  type: 'reveal-in-file-tree';
  sessionId?: string;            // OSC 7 path only (was required)
  cwd?: string | null;           // OSC 7 path only (was required)
  absPath?: string;              // NEW — auto-reveal path (explicit, skips cwd resolution)
  focusNoScroll?: boolean;       // NEW — when true, skip Tree<T>.revealElement
  source?: 'osc7' | 'autoReveal';// NEW — discriminator for panel-hidden gating
}
```

`FileTreeController.handleReveal` branches:

```typescript
if (msg.absPath) {
  return this.panel.revealPath(msg.absPath, {
    focusNoScroll: msg.focusNoScroll,
    source: msg.source,
  });
}
// existing OSC 7 cwd-resolution path unchanged
```

This keeps the existing OSC 7 callers working without edits (no caller currently sets `absPath`), and gives auto-reveal a clean explicit-path entry that bypasses the cwd-resolution logic it doesn't need.

**Rejected**: a new `AutoRevealFileMessage` type. Would force the webview to maintain two near-identical handlers that diverge over time.

### D2: Trigger on `window.tabGroups.onDidChangeTabs` + `onDidChangeTabGroups`, not `onDidChangeActiveTextEditor`

`onDidChangeActiveTextEditor` fires only for text editors and silently misses custom editors (image previews, markdown previews, etc.). The tab-groups API gives broader coverage via `tab.input` (which carries a usable URI for `TabInputText`, `TabInputCustom`, `TabInputNotebook`). Other tab-input shapes (`TabInputTextDiff`, `TabInputNotebookDiff`, `TabInputTerminal`, `TabInputWebview`) are intentionally treated as "no file to reveal" — diffs are review surface, not "I'm editing this file."

**Implementation note**: VS Code 1.105 does NOT expose a dedicated `onDidChangeActiveTab` event. The available signals are `onDidChangeTabs` (fires on opened/closed/changed including isActive flips) and `onDidChangeTabGroups`. We subscribe to BOTH and, in the debounced handler, read `vscode.window.tabGroups.activeTabGroup.activeTab` — that is the canonical "what's active right now" accessor.

### D3: 100 ms debounce on the host, no debouncing inside the webview

VSCode itself does not debounce, but the AnyWhere webview costs more (postMessage + IPC) than VSCode's in-process tree update. 100 ms is short enough to feel instant on a single tab switch yet long enough to absorb tab-cycling (`Cmd+Opt+Left/Right` chains) and quick-open preview spam. Picked to land in the lower half of the 75-500 ms range commonly used elsewhere.

The debounce uses a single rolling `setTimeout` per `ActiveFileRevealer` instance; latest tab wins; settings are re-read inside the timer callback so a toggle during the debounce window takes effect.

**Rejected**: 0 ms (matches VSCode but creates IPC bursts); 500 ms (perceptible lag on a real navigation).

### D4: Use `minimatch` as a direct npm dependency for the exclude glob

`minimatch` is already in the transitive dependency tree, so promoting it to a direct dependency adds zero install-size overhead. It implements the exact glob semantics VSCode uses (`**`, `?`, `[...]`, brace expansion, `dot: true`). A hand-rolled matcher would either be limited (only `**/<name>` patterns) or duplicate work for marginal gain.

Modern `minimatch` (v9+) ships its own types; do NOT install `@types/minimatch` (oracle finding 7).

Cache: one `Minimatch` instance per pattern, rebuilt on `onDidChangeConfiguration` for `autoRevealExclude`. Invalid patterns wrapped in try/catch and logged once.

**Rejected**: hand-rolled matcher. Brittle and surprising once users add custom patterns.

### D5: Webview-side gating for panel-hidden; host carries no panel-open state

The panel-open state is owned by the webview (`FileTreePanel.open`). The host does NOT track it today (verified: `FileTreeHost` exposes only `workspaceRoot` + rootGeneration). Adding a webview→host sync message just for this gate would be unnecessary state with no other consumer.

Decision: the host always posts auto-reveal messages when other gates pass; the webview's `FileTreePanel.revealPath` short-circuits when `options.source === 'autoReveal' && !this.open`. The existing OSC 7 call site (no `source`) preserves today's "open the panel and reveal" behavior because it doesn't trip the auto-reveal branch.

This is cheap (one `postMessage` per coalesced editor change, only when the user is changing tabs) and removes the need for a new state contract.

**Rejected**: webview→host panel-open sync message. New state with one consumer is overkill.

### D6: One `ActiveFileRevealer` instance per `FileTreeHost`

`FileTreeHost` already exists per-webview-provider. The natural place to scope an editor-listener that needs to post to THIS webview is the same `attach()` lifecycle that already wires the workspace-folder bridge. Singleton-at-extension-level would re-introduce the lookup problem on every event.

The class shape:

```typescript
class ActiveFileRevealer implements vscode.Disposable {
  constructor(
    private readonly workspaceRoot: () => string | null, // delegated to host
    private readonly settings: () => FileTreeAutoRevealConfig,
    private readonly post: (msg: RevealInFileTreeMessage) => void,
  );
  dispose(): void;
}
```

The host's existing `safePostMessage` shim is the `post` callback — that shim already gates on `_ready`, so an unready webview's reveals are dropped without extra logic.

### D7: Settings live in a new `FileTreeSettingsReader`, not the existing `readTerminalSettings()`

`readTerminalSettings()` returns a `TerminalConfig` used in terminal `init` messages and explicitly enumerated in the `extension-settings` spec. File-tree settings have different consumers (host-only) and a different reload model (re-read on every change vs. send `configUpdate`). Splitting keeps each reader's responsibilities clean.

```typescript
type AutoRevealMode = 'reveal' | 'none' | 'focusNoScroll';

interface FileTreeAutoRevealConfig {
  mode: AutoRevealMode;
  excludePatterns: ReadonlyArray<string>;
}

function readFileTreeSettings(): FileTreeAutoRevealConfig;
```

`mode` is normalized at the boundary so downstream code never sees raw `true`/`false`/`"true"`/`"focusNoScroll"`.

### D8: Path normalization for the exclude matcher

The matcher input is the workspace-relative path. Two normalization rules apply:

- **Separators**: convert Windows `\` to `/` before matching, since `minimatch` patterns use `/`.
- **Case**: case-insensitive matching on `win32` and `darwin` (default-case-insensitive file systems), case-sensitive on Linux.

Computed via:

```typescript
const rel = path.relative(workspaceRoot, absPath);
if (rel.startsWith('..') || path.isAbsolute(rel)) return false; // outside root
const normalized = rel.split(path.sep).join('/');
```

Ancestor list for "an ancestor segment matches" semantics:

```typescript
const parts = normalized.split('/');
const candidates: string[] = [];
for (let i = 1; i <= parts.length; i++) {
  candidates.push(parts.slice(0, i).join('/'));
}
// e.g. ['node_modules', 'node_modules/foo', 'node_modules/foo/bar.ts']
```

Match if ANY candidate matches ANY pattern.

## Architecture

```
┌─────────────────── Extension Host ──────────────────┐         ┌──────────────────── Webview ─────────────────┐
│                                                      │         │                                              │
│  window.tabGroups.onDidChangeActiveTab               │         │  MessageRouter.onRevealInFileTree            │
│              │                                       │         │              │                               │
│              ▼ (debounce 100ms)                      │         │              ▼                               │
│  ActiveFileRevealer.flush(latestTab)                 │         │  FileTreeController.handleReveal(msg)        │
│              │                                       │         │              │ branch on msg.absPath         │
│              ▼                                       │         │              ▼                               │
│  • re-read settings (race-safe)                      │         │  panel.revealPath(absPath, { focusNoScroll, │
│  • extract file: URI from supported TabInput shapes  │         │                              source })       │
│  • inside first workspace folder?                    │         │              │                               │
│  • ancestor-aware exclude glob match?                │         │              ▼                               │
│  • mode !== 'none'?                                  │         │  • if source==='autoReveal' && !open:        │
│              │ all yes                               │         │      return  (panel-hidden gate, D5)         │
│              ▼                                       │postMsg  │  • Tree<T>: expand ancestors                 │
│  RevealInFileTreeMessage {                ─────────────────────►• Tree<T>: setSelection + domFocus            │
│     absPath, focusNoScroll?, source       │         │         │  • if !focusNoScroll: Tree<T>.revealElement  │
│  }                                        │         │         │                                              │
│  (no sessionId / no cwd — auto-reveal     │         │         │                                              │
│   contract is mutually exclusive with     │         │         │                                              │
│   the existing OSC 7 contract)            │         │         │                                              │
└──────────────────────────────────────────────────────┘         └──────────────────────────────────────────────┘
```

## Interfaces

### `RevealInFileTreeMessage` (modified — additive, both callers valid)

```typescript
interface RevealInFileTreeMessage {
  type: 'reveal-in-file-tree';
  sessionId?: string;             // OSC 7 path only
  cwd?: string | null;            // OSC 7 path only
  absPath?: string;               // NEW — auto-reveal explicit path
  focusNoScroll?: boolean;        // NEW
  source?: 'osc7' | 'autoReveal'; // NEW
}
```

### `FileTreePanel.revealPath` (modified signature)

```typescript
revealPath(
  absPath: string,
  opts?: { focusNoScroll?: boolean; source?: 'osc7' | 'autoReveal' },
): Promise<void>;
```

Default args ⇒ existing OSC 7 callers unchanged.

### `FileTreeSettingsReader`

```typescript
type AutoRevealMode = 'reveal' | 'none' | 'focusNoScroll';
interface FileTreeAutoRevealConfig {
  mode: AutoRevealMode;
  excludePatterns: ReadonlyArray<string>;
}
function readFileTreeSettings(): FileTreeAutoRevealConfig;
```

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| `RevealInFileTreeMessage` contract widening | Existing OSC 7 callers that destructure `{sessionId, cwd}` break if those become required-undefined | Both fields become OPTIONAL (`sessionId?`, `cwd?`); OSC 7 caller still sets them, controller branches on `msg.absPath` first — OSC 7 path is unreached and unchanged |
| Path normalization on Windows | Backslash paths fail `minimatch` `/`-based patterns; case-sensitive match misses common Windows usage | D8 specifies separator + case rules; unit test covers Windows-shape inputs via parameterized cases |
| Multi-root workspace user expectation | User has a second workspace folder; auto-reveal silently does nothing for files there | Explicit V1 scope rule in spec (first folder only); spec leaves the door open for multi-root in a later change |
| `ActiveFileRevealer` event handler | High-frequency tab events on large workspaces flood IPC | 100 ms debounce (D3); resolver re-reads `mode` and early-returns before string work when `mode === 'none'` |
| Exclude matcher with malformed user pattern | One bad pattern breaks all reveals | Wrap each `minimatch` construction in try/catch; log invalid patterns once; drop them from the active set; reveal still works for the rest |
| `tab.input` shape evolution in future VS Code | New TabInput subclass appears; auto-reveal might want to support it | Resolver `instanceof` checks the three known shapes; unknown types fall through to silent skip — matches D2 rule |
| Webview not ready when message posted | Lost reveal during webview startup | Host's existing `safePostMessage` shim gates on `_ready` flag; revealer uses it directly (no new gate) |
| Panel-closed bookkeeping | Stale `panel.open` snapshot causing wrong gate decision | Gate moved INTO webview (D5); reads `this.open` at call time — always fresh, no caching |
| `minimatch` as new direct dep | Adds explicit dependency to `dependencies` | Already transitively present in lockfile; promotion adds zero install cost; no `@types/minimatch` needed (modern minimatch ships own types) |
| `focusNoScroll` regression on OSC 7 path | New optional arg changes existing behavior | Default `undefined` ⇒ `!opts?.focusNoScroll` evaluates `true` ⇒ calls `revealElement` (scroll) ⇒ identical to today |
| Settings change race during reveal | Setting toggled to `false` mid-debounce; message still fires | Resolver re-reads `settings.mode` AFTER the debounce, immediately before posting; single source of truth |
| Diff tab inputs intentionally ignored | User has a diff open; expects auto-reveal of one side | Documented decision (D2 + spec); follow-up enhancement if requested |
