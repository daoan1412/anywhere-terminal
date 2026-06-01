# Design: preview-subagent-popup

## Decisions

### D1: A second, separate link provider — `SubagentLinkProvider`
Register a new `ILinkProvider` alongside `FilePathLinkProvider` in `TerminalFactory.createTerminal` (xterm allows multiple providers; the call site is `TerminalFactory.ts:343-351`, auto‑applied to splits via `SplitTreeRenderer`). It reuses `FilePathLinkProvider`'s logical‑line back‑walk + per‑row range emission pattern (`FilePathLinkProvider.ts:197-216, 336-399`).
**Rejected:** folding subagent matching into `FilePathLinkProvider` — different match grammar and click action; mixing risks regressing file‑path links.

### D2: Match the header line directly (built‑in‑tool exclusion), NOT the trailer
**(Revised per oracle finding #1 — blocker.)** The `Done (… tool uses …)` / `In progress…` trailers render as **separate, non‑contiguous lines** (child `⎿` lines intervene between header and trailer), and the reused `FilePathLinkProvider` back‑walk only joins wrap/continuation rows and breaks on any other line (`FilePathLinkProvider.ts` `if (!isXtermWrap && heuristicKind === "none") break;`). Moreover `ILink.range` is single‑row (`xterm.d.ts` `IBufferRange.start/end.y`), so a link emitted on the trailer row cannot decorate the header row. ⇒ **trailer‑anchored matching is infeasible.**
Parser flow (header‑only, no cross‑line join): match a single line `^[⏺●]?\s*([A-Za-z][\w-]*)\((.+)\)\s*$`; **reject** when the name is a built‑in tool display name (`Read|Bash|Edit|MultiEdit|Update|Create|Write|Grep|Glob|NotebookEdit|Search|Task`) or an `mcp__…` name; any other name is an agent type → capture `<desc>`. The glyph `⏺`/`●` blinks (`constants/figures.ts:4`) so it is optional (`[⏺●]?`). Both running and finished subagents are clickable from the moment their header renders (only the brief `Initializing…` pre‑header window is not). Discriminator is a heuristic, so a non‑agent header that slips through resolves to a harmless `notFound` host‑side (D5) — no popup error noise. `<description>` is verbatim from `input.description` (= on‑disk `meta.json.description`); narrow‑terminal right‑edge clipping → resolution uses **prefix match** (D5), not equality.

### D3: Click → IPC → host resolve → popup (data flow)
```
SubagentLinkProvider link.activate(event)        // ILink.activate(event, text) — coords from event.clientX/Y; description from closure
  └─ postMessage requestSubagentPreview { terminalId, requestId, description, x: event.clientX, y: event.clientY }
       └─ host: resolveClaudeSession(terminalId)  [D4]  → { sessionId, cwd }
              └─ resolveSubagentDetail(sessionId, description)  [D5] → VaultSessionDetail   // cwd NOT needed here
                   └─ postMessage subagentPreviewResponse { requestId, detail | error }
                        └─ webview: SubagentPreviewPopup.setContent(detail|error)  [D6]
```
`ILink.activate` signature is `(event: MouseEvent, text: string)` (`xterm.d.ts`) — there is no coords arg; read `event.clientX/clientY`, and the `description` is closure‑captured from `provideLinks` (as `FilePathLinkProvider` does). Host handler lives where `requestVaultSessionDetail` is handled (`TerminalViewProvider.ts:422-445, 647-655`; `vaultService` is already available there; mirror in `TerminalEditorProvider.ts`). The webview opens the popup in a loading state immediately on click and fills it when the response with the matching `requestId` arrives.

### D4: Terminal→session resolution (process‑tree + cwd/mtime fallback)
The pty's direct child is the shell; `claude` (node) is a descendant whose pid is what the registry records. Resolver order = spec "Map a terminal to its Claude session". Reuse `session.pty.pid` (`PtySession.ts:71-73`) and the OS‑query precedent of `queryProcessCwd` (`pty/processCwd.ts:46-66`). Split the process‑tree into a **pure table parser** (`parseProcessTable(text)` + BFS) unit‑tested independently of the live `ps`/`/proc` call. **(oracle #4)** When the subtree intersects >1 running registry pid (two `claude` procs), tie‑break by `<sessionId>.jsonl` mtime, never throw. An unreadable subtree (EPERM/sandbox) is treated as empty → cwd fallbacks. The cwd fallback uses `getLiveCwd` (the **shell** cwd), which can diverge from the registry launch cwd if the shell `cd`'d after launch (during an active foreground `claude` the shell is blocked, so they usually agree); a miss degrades to "newest session under cwd", not an error.
**Rejected:** matching the pty pid directly to the registry (wrong — registry pid is a descendant); env/argv sniffing (no `CLAUDE_SESSION_ID`, interactive sessions pass no `--session-id`).

### D5: Subagent lookup by description prefix — reuse `listClaudeSubagentStubs`, no cwd
**(Revised per oracle finding #3.)** There is **no `encodeProjectDir`** (only lossy `decodeProjectDir`, `claudePaths.ts:29`), and the existing readers locate the parent by **`sessionId`** by scanning project dirs — so `cwd` is NOT an input to this step. `resolveSubagentDetail(sessionId, description)`: call the existing `listClaudeSubagentStubs(sessionId)` to enumerate `{ entryId, description }` stubs, recover each `stem` from `entryId` (split on `SUBAGENT_MARKER` `":subagent:"`, `claudePaths.ts:14`), **prefix‑match** the clicked `description` (tie‑break newest mtime), then `readClaudeSubagentDetail(parentId=sessionId, stem, …)` (`claudeChildren.ts:32-49`) — already containment‑checked via `resolveClaudeSubagentPath`. Returns the same bounded `VaultSessionDetail` the vault preview uses; renderer unchanged. Do NOT write a new scan or derive an encoded path.

### D6: Popup = new `SubagentPreviewPopup`, not an overload of `HoverPreviewPopup`

> **Final decision (2026-06-01, user "Reuse full shell" → de-dup extraction):** the popup reuses the SAME chrome AND the SAME header builder as the vault session preview, via a shared `FloatingPreviewShell` — not by duplicating the shell inline. The first "reuse" pass reused the leaf components (`FloatingWindow`, `PreviewScrollNav`, `renderNestedInto`) but **duplicated** the card-assembly, close-listeners, and the header (a hand-rolled `buildHeader`). The user flagged "two UIs for one problem"; the fix extracts:
> - **`FloatingPreviewShell`** (`webview/vault/FloatingPreviewShell.ts`) — the card `.vault-preview` `<aside>` + `FloatingWindow` (resize/move/maximize/geometry) + `PreviewScrollNav` (FABs) + document close-listeners + tooltip disposers + the `render`/`show`/`hide`/`dispose` lifecycle. Generic, zero vault knowledge. **Both** `PreviewController` and `SubagentPreviewPopup` compose it.
> - a genericized **`buildPreviewHeader(model, cb)`** (`webview/vault/previewHeader.ts`) — one builder for both; the vault-only actions (`onPrevUser`/`onNextUser`/`onResume`) render only when their callback is supplied, so the two headers cannot drift.
>
> `SubagentPreviewPopup` therefore holds a `FloatingPreviewShell` (claude accent), builds its header through `buildPreviewHeader` (badge + `@<agentType>` chip + description title + maximize/close + Activity meta), and renders the `renderNestedInto` body. It is anchored at the CLICK (`getAnchorRow → null`, first-open positioned via reused `computePosition`), carries NO Resume / prev-next-user actions (a subagent is not independently launchable), and remembers geometry IN-MEMORY on the factory singleton (no disk persistence). `agentType` is threaded webview-side (parser → `SubagentLinkProvider.onActivate` → `handleSubagentClick` → `open`) for the badge; the host message is unchanged (resolves by description). _(Supersedes both the interim "lightweight popup" note AND the first "duplicate the shell inline" build.)_ The flat stub bag (below) still applies — nested nodes are non-expandable.

`HoverPreviewPopup.result` is typed to `FilePreviewResultMessage` with a file‑specific header/footer — overloading it with transcript typing bloats it. So `SubagentPreviewPopup` is its own class that composes the shared `FloatingPreviewShell`, positions it at the click coordinates (reuse the viewport flip/clamp math from `HoverPreviewPopup.computePosition`), and fills its body with `loadingBody` → the transcript → `emptyState` atoms.
**Transcript render (oracle finding #2):** `renderNestedInto(container, detail, entryId, bag)` REQUIRES a `PreviewTimelineBag` (4th arg) whose `populateNested(entryId, body)` lazily fetches nested children (`previewTimeline.ts:78-94`). For MVP the popup passes a **stub bag**: `populateNested` is a no‑op and `isNestedExpanded` returns false, so the clicked subagent's transcript renders **flat** — nested sub‑subagent/teammate nodes appear as non‑expandable lines. Expand‑in‑popup is OUT of MVP scope. (A later follow‑up can wire a real bag that issues `requestVaultSessionDetail` and routes `vaultSessionDetailResponse` into the popup — the host handler already exists, `TerminalViewProvider.ts:647`.) This keeps appetite M.
**Rejected:** adding a transcript variant to `HoverPreviewPopup` (couples file‑preview typing to transcripts); full nested lazy‑fetch in the popup (extra pending‑map + response routing, not needed for MVP).

### D7: One factory‑singleton popup; dispose on open‑replace + any terminal teardown
Keep a single live `SubagentPreviewPopup` owned by the `TerminalFactory` (not per‑session). **(oracle finding #7)** Because it is a factory singleton — unlike the per‑session `hoverControllers` map — it MUST NOT be disposed inside the per‑session `disposeHoverController(id)` path (that would kill it whenever any *sibling* pane closes while a popup from another pane is open). Correct model: **dispose‑on‑open‑replace** (a new click disposes the prior popup) **plus** dispose on any terminal teardown (`removeTerminal`/`removeTab` at `main.ts:403,416`; split‑pane close at `main.ts:532,539`; panel dispose). Accept that closing pane B dismisses a popup opened from pane A — harmless, matches "single popup". `dispose()` is idempotent. Follows the prior body‑overlay disposal lesson (split close + tab close, not just explicit close).

### D8: Platform
Process‑tree walk on macOS (`ps -axo pid=,ppid=`) + Linux (`/proc`/`ps`); Windows returns an empty subtree → resolution uses cwd fallbacks. No new dependency.

## Interfaces

```ts
// src/types/messages.ts — webview → host
interface RequestSubagentPreviewMessage {
  type: "requestSubagentPreview";
  terminalId: string;
  requestId: string;
  description: string;   // captured verbatim from the terminal header line
  x: number; y: number;  // click viewport coords for popup anchor
}
// host → webview
interface SubagentPreviewResponseMessage {
  type: "subagentPreviewResponse";
  requestId: string;
  detail?: VaultSessionDetail;   // reuse existing vault detail type
  error?: string;                // "notFound" | "noSession" | read error
}

// src/vault/readers/runningSessions.ts
//   async + DI for testability; startedAt is `Date.now()` on disk → number.
interface RunningClaudeSession { sessionId: string; cwd: string; pid: number; startedAt?: number; }
function listRunningClaudeSessions(options?, deps?): Promise<RunningClaudeSession[]>;

// src/session/resolveClaudeSession.ts
//   terminalId stays the nominal input; SessionManager/reader access is injected
//   via `deps` so the resolution algorithm is unit-tested without the host.
interface ResolveClaudeSessionDeps {
  getPtyPid(terminalId: string): number | undefined;
  getCwd(terminalId: string): Promise<string | undefined>;
  listRunning(): Promise<RunningClaudeSession[]>;
  descendantPids(rootPid: number): Promise<number[]>;
  sessionMtime(sessionId: string): Promise<number | undefined>;
  newestSessionUnderCwd(cwd: string): Promise<{ sessionId: string; cwd: string } | null>;
}
function resolveClaudeSession(terminalId: string, deps: ResolveClaudeSessionDeps): Promise<{ sessionId: string; cwd: string } | null>;

// src/pty/processTree.ts
function parseProcessTable(text: string): Map<number, number[]>;        // pid → child pids (pure, unit-tested)
function collectDescendants(root: number, table: Map<number, number[]>): number[]; // pure BFS (unit-tested)
function descendantPids(rootPid: number, deps?): Promise<number[]>;     // OS-backed (async; macOS/Linux; [] on Windows)

// src/vault/readers/subagentLookup.ts  (cwd NOT needed — readers locate parent by sessionId)
function resolveSubagentDetail(sessionId: string, description: string, options?, limit?): Promise<VaultSessionDetail | null>;

// src/webview/vault/FloatingPreviewShell.ts — shared chrome for BOTH previews.
interface FloatingPreviewShellDeps {
  ariaLabel: string;
  role?: string;                                 // subagent → "dialog"; vault omits
  classNames?: string[];                         // e.g. ["vault-preview--claude"]; "vault-preview" always added
  getAnchorRow?: () => HTMLElement | null;       // default () => null
  initialGeometry?: () => VaultPreviewGeometry | null;
  persistGeometry?: (g: VaultPreviewGeometry) => void;
  onScrollTop: () => void;
  onRequestClose: () => void;                    // single close intent: button | Esc | outside
  shouldCloseOnEscape?: () => boolean;           // vault → !isContextMenuOpen()
  outsideCloseExclude?: string[];                // vault → [".vault-row"]
  captureCloseListeners?: boolean;               // subagent → true; vault bubble (default)
}
class FloatingPreviewShell {
  readonly el; readonly floatingWindow; readonly scrollNav;
  render(...nodes: Node[]): void;   // replaceChildren(...nodes, ...resizeHandles, scrollNav.element); scrollNav.wire()
  show(): void;                     // idempotent attach close-listeners + is-open + floatingWindow.place()
  hide(): void;                     // cancelGesture + clear + scrollNav.reset + disposeTooltips + detach (no onRequestClose)
  trackTooltips(d: Array<() => void>): void; disposeTooltips(): void; isOpen(): boolean; dispose(): void;
}

// src/webview/vault/previewHeader.ts — ONE builder for both consumers.
interface PreviewHeaderModel {
  badge: { icon?: AgentIcon; ariaLabel?: string; fallbackText?: string };
  chip?: { text: string; className: string };   // subagent @agentType; vault omits
  title: string;
  meta?: HTMLElement;                            // vault Folder/Modified/Activity | subagent Activity | undefined
}
// callbacks: isMaximized/onMovePointerDown/onToggleMaximize/onClose required;
//   onPrevUser?/onNextUser?/onResume? render that button only when supplied (vault only).
function buildPreviewHeader(model: PreviewHeaderModel, cb): { element: HTMLElement; disposers: Array<() => void> };
```

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| `subagentLineParser` | Blink glyph / reflow / right‑edge clip; false positive on a non‑agent header | Match the **header line directly** (no trailer join — oracle #1); exclude built‑in/`mcp__` names; tolerant glyph `[⏺●]?`; prefix‑capture description; false positives resolve to harmless `notFound` host‑side; pure parser unit‑tested on `translateToString` fixtures (task 3_1); verify `ILinkProvider` semantics against `/Users/huybuidac/Projects/ai-oss/xterm.js` |
| `processTree` / `resolveClaudeSession` | Per‑click OS query cost; permission limits; wrong session when cwd shared | On‑demand only; pure parser unit‑tested (task 1_2); cwd+mtime fallback then newest‑in‑cwd (task 1_3); null + graceful no‑op on failure |
| `subagentLookup` | Two subagents share a description | Prefix match + tie‑break by newest mtime; never throw → `notFound` (task 1_4) |
| `SubagentPreviewPopup` | Body‑mounted overlay leaks on split/tab close | Single instance + idempotent `dispose()` wired into every teardown path (task 4_3); jsdom dispose test |
| Host handler | Unknown terminal / no session | Reply with `error` marker, never throw (task 2_2) |
| Verification | biome lint OOMs; webview jsdom flake in full suite | Gate with `tsc` + vitest, sweep unused imports manually; afterEach DOM/listener cleanup, 10× full‑suite run (task 5_1) |
| Reuse base | Reuses uncommitted vault decomposition (`renderNestedInto`, subagent readers) | Build in main where present; do not branch off a HEAD lacking it |
