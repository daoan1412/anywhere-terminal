# Design: export-terminal-session

## Architecture

```
                     ┌────────────────────────────────────────┐
PTY (node-pty)  ───► │  ShellIntegrationParser (extends OSC)  │  ─► TerminalSession.commands[]
                     │   • OSC 633 A/B/C/D/E/P                │      (FIFO, capped 200 / 1 MB)
                     └────────────────────────────────────────┘
                                       ▲
                                       │  spawn: inject script + env
                              ┌────────┴────────────┐
                              │ ShellIntegrationInj │
                              │  bash | zsh | fish  │
                              │  pwsh (win+nix)     │
                              └─────────────────────┘

  Command palette → ExportCommands ──► SessionManager
                                          │
                                          ├─ getLastCompletedCommand(id)         (in-mem, sync)
                                          ├─ getTrackedCommands(id)              (in-mem, sync)
                                          └─ requestScrollbackDump(id) ───────► WebView (SerializeAddon)

  ExportCommands → strip-ansi → showSaveDialog → fs.writeFile (.tmp + rename)
```

Two new modules (`ShellIntegrationParser` extends existing `oscParser.ts`; `ShellIntegrationInjector` is new); one new IPC message pair; one new extension command module (`src/commands/exportCommands.ts`). Webview gets a small handler for the dump request.

## Decisions

### D1: Command model lives on `TerminalSession`, not in a separate manager

Each `TerminalSession` already owns its lifecycle (state machine: `live | exited-preserved | destroying | disposed`, `src/session/TerminalSession.ts:48-116`) and its `outputBuffer`/`scrollbackCache`. Adding `commands: TrackedCommand[]` and `_inFlightCommand: TrackedCommand | null` to the same object keeps disposal automatic (garbage-collected with the session) and means `SessionManager` is a thin facade. **Rejected**: separate `ShellIntegrationManager` indexed by `sessionId` — introduces a parallel map that needs explicit cleanup on every session dispose path (we already have 4 such paths per `SessionManager.deactivate.test.ts`) and adds a second source of truth for "does this session exist".

### D2: OSC 633 marker semantics

| Marker | Argument | Effect on tracker |
|---|---|---|
| `A` | none | Note "we are inside a prompt". Used only to suppress treating prompt bytes as output. |
| `B` | none | Output region starts. Close any open `_inFlightCommand`'s pre-execution buffer and start collecting `output`. |
| `C` | none | Same as `B`. Older shell scripts emit only `C`; newer also emit `B`. Treat as idempotent: if a command is already open via `B`, ignore `C`. |
| `D` | optional decimal exit code | Close `_inFlightCommand` with `exitCode = parsed | null`, set `endedAt = Date.now()`, push to `commands[]`, evict per D5. |
| `E` | command line `;` nonce | If nonce matches per-session value (see D3), set `_inFlightCommand.commandLine = decoded`. If mismatch, leave empty. |
| `P` | `Cwd=<path>` | Existing handler (`oscParser.ts:1-80`). On match, also write to `_inFlightCommand.cwd`. |

We accept that command-line capture is lossy for shells that don't emit `E` (the user sees their command but `output` is blank in the export). This is consistent with VS Code's own behavior. **Rejected**: trying to recover command line from terminal screen contents — race-prone, breaks on multi-line prompts.

### D3: Auto-inject shell-integration via per-session temp ZDOTDIR (zsh) / `--init-file` (bash) / `--init-command` (fish) / `-noexit -command` (pwsh)

We vendor VS Code's shell-integration scripts (MIT-licensed) under `resources/shell-integration/` with attribution in `NOTICE`. At PTY spawn we detect the shell binary by `path.basename(shellPath)` and inject as follows. **The exact mechanism per shell mirrors VS Code's `src/vs/platform/terminal/node/terminalEnvironment.ts`** — task 2_4 must read VS Code's source for the pinned tag and follow it; deviation requires updating this decision first.

| Shell | Mechanism |
|---|---|
| `bash` | Prepend `--init-file <session-temp>/shellIntegration.bash` to args. The vendored bash script (copied into a per-session writable temp dir at `0o700`) re-sources the user's normal rc (`.bashrc` for interactive non-login; `.bash_profile`/`.bash_login`/`.profile` chain for login shells), then emits OSC 633 hooks. Skip injection when args contain `--noprofile --norc` (user explicitly disabled rc). |
| `zsh` | Create a per-session writable temp dir at `0o700` (e.g. `os.tmpdir()/at-zdotdir-<uuid>`); copy four vendored files into it (`.zshenv`, `.zprofile`, `.zshrc`, `.zlogin`); set env `ZDOTDIR=<temp>` AND `USER_ZDOTDIR=<original-ZDOTDIR-or-empty>`. Each vendored file sources the matching `$USER_ZDOTDIR/<file>` (if present) before installing the OSC 633 hooks. **The user's original `ZDOTDIR` MUST be preserved as `USER_ZDOTDIR` — without this the user's rc never loads.** |
| `fish` | Prepend `--init-command "source <ext>/resources/shell-integration/shellIntegration.fish"` to args. Fish's `--init-command` runs after the user's rc, so no rc-sourcing logic is needed inside the script. |
| `pwsh` | Prepend `-noexit -command ". '<ext>/resources/shell-integration/shellIntegration.ps1'"` to args (lowercase flags, dot-source operator). Skip injection when args contain `-NoProfile` (case-insensitive). |
| other | No injection. The shell still spawns; per-command export commands surface the no-tracked-commands toast per spec. |

**Environment hygiene:**

- The injector MUST NOT set `VSCODE_INJECTION=1`. Setting it causes any user `.bashrc`/`.zshrc` containing `[[ -n "$VSCODE_INJECTION" ]] && source $(code --locate-shell-integration-path …)` to ALSO source the script, producing duplicate OSC 633 markers.
- `TERM_PROGRAM` is already set to `AnyWhereTerminal` by the existing PTY spawn path (`src/pty/PtyManager.ts`). The injector MUST NOT overwrite it; the injector test MUST assert no modification.
- A per-session UUIDv4 **nonce** is set as `VSCODE_NONCE=<uuid>` env; the parser accepts `E` markers only when their carried nonce matches. This mirrors VS Code's anti-spoofing approach.

**Cleanup**: the per-session temp dir (zsh ZDOTDIR + bash init file) MUST be removed on session dispose — covered by task 2_4 step 5. On crash, OS temp cleanup eventually reclaims.

**Rejected**: documentation-only ("ask users to source the script themselves"). >90% of users will skip the setup step and report the feature as broken.

### D4: New IPC contract for scrollback dump

```ts
// extension → webview
interface RequestScrollbackDump {
  type: "requestScrollbackDump";
  tabId: string;
  requestId: string;   // UUID, used to correlate response
}
// webview → extension
interface ScrollbackDump {
  type: "scrollbackDump";
  tabId: string;
  requestId: string;
  data: string;        // SerializeAddon output (ANSI preserved)
  lineCount: number;
  truncated: boolean;  // true iff xterm's `scrollback` cap was hit
}
```

The extension wrapper `SessionManager.requestScrollbackDump(sessionId)` returns a `Promise` resolved when the matching `requestId` arrives. **Three safeguards:**

1. **Session-dispose cancellation** — `_pendingDumps: Map<requestId, { resolve, reject, sessionId }>` is iterated on `disposeSession`; matching entries reject with `ScrollbackDumpAbortedError`.
2. **15-second timeout** — `setTimeout` registered with each pending entry; on fire, reject with `ScrollbackDumpTimeoutError`. Raised from an earlier 5 s draft because on a backgrounded VS Code window with `requestAnimationFrame`-throttled webview dispatch, a fully-populated 5000-line wide-char scrollback can take 2–4 s to serialise on a loaded laptop; 15 s leaves headroom. Both error classes carry `sessionId` and `requestId` for diagnostics.
3. **Webview-side dedupe by `tabId`** — when `requestScrollbackDump` arrives for a `tabId` that already has a serialisation in flight, the webview handler MUST reuse the in-flight `Promise` rather than starting a second `SerializeAddon.serialize()`. Both `requestId`s receive identical `data`, `lineCount`, and `truncated`. This protects against spam-clicking the export command launching N concurrent serialisations on the same Terminal.

**Rejected**: streaming dump (multiple `scrollbackDumpChunk` messages). xterm's `SerializeAddon` is synchronous and the typical 5000-line cap is ≤5 MB; one message is fine.

### D5: Command eviction policy

Run after every `D`-marker push:

```ts
while (
  session.commands.length > 200 ||
  totalOutputBytes(session.commands) > 1_000_000
) {
  session.commands.shift(); // FIFO
}
```

`totalOutputBytes` sums `command.output.length` (NOT `outputBytes`, which can exceed `output.length` when truncated — we count actual memory). Per-command `output` is itself capped at 100 KB (see spec scenario). Combined: worst case ≤ 1 MB + 100 KB headroom per session.

### D6: Degradation when shell integration is absent OR list reset by window reload

Two empty-list cases share one UX:

- **Shell binary unrecognised** → no integration injected → `getLastCompletedCommand` returns `null`, `getTrackedCommands` returns `[]`.
- **Window reload** → tracked-commands list resets. We do **not** persist `TrackedCommand[]` across reloads (out of scope for this change). The existing snapshot/restore work (`asimov/changes/archive/260526-0918-restore-terminal-sessions/`) restores xterm scrollback, so the user *sees* prior output on screen while the command list is empty — a confusing combination if the toast isn't honest about it.

Both cases surface the **same** info toast (DRY in `exportCommands.ts`); the toast text — defined in `specs/terminal-session-export/spec.md` — acknowledges the reload-reset case explicitly so post-reload silence isn't a perceived bug. The `Help` button links to `README.md#shell-integration`.

`ExportBuffer` works regardless of marker tracking — full scrollback dump never depends on shell integration.

We do **not** add a status-bar indicator in v1. Reason: status-bar real estate is contested already (split-controls, focus-pane). Reassess based on telemetry / user reports.

### D7: ANSI stripping happens in the extension, on the export path only

`strip-ansi@^7.2.0` runs in the export command handler after the `SerializeAddon` data arrives. The PTY-side stream and the tracked-command `output` field both **preserve** ANSI; stripping is a render-time concern, applied based on the save-dialog filter the user selected. Stripping is synchronous and `O(n)` over a string typically ≤5 MB — well under one event-loop tick.

**Rejected**: stripping in the webview before sending. Forces the webview to know about export semantics, and the webview already has the data in xterm's screen buffer; sending raw is cheaper than two transforms.

### D8: Save flow uses VS Code FS API + atomic rename

```ts
const tmpUri = uri.with({ path: uri.path + ".tmp" });
await vscode.workspace.fs.writeFile(tmpUri, Buffer.from(content, "utf8"));
await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true });
```

This mirrors `SessionStorage.ts:272-295` (the project's only existing file-write pattern). Using `vscode.workspace.fs` (not `node:fs`) means remote / virtual workspaces work transparently — relevant because AnyWhere Terminal is positioned as cross-platform-future.

## Interfaces

### TrackedCommand (in `src/session/TerminalSession.ts` or new `src/session/TrackedCommand.ts`)

```ts
export interface TrackedCommand {
  id: string;             // UUIDv4
  commandLine: string;    // "" if no nonce-verified E marker seen
  output: string;         // ANSI preserved, capped at 100 KB
  exitCode: number | null;
  cwd: string | null;
  startedAt: number;      // Date.now() at A or B (whichever first)
  endedAt: number | null; // Date.now() at D
  outputBytes: number;    // true byte count (>= output.length when truncated)
  outputTruncated: boolean;
}
```

### ShellIntegrationInjector (new — `src/pty/ShellIntegrationInjector.ts`)

```ts
export interface InjectionResult {
  args: string[];
  env: Record<string, string>;
  nonce: string;
}
export function injectShellIntegration(
  shellPath: string,
  baseArgs: string[],
  baseEnv: Record<string, string>,
): InjectionResult | null;  // null when shell unrecognised
```

### SessionManager additions

```ts
class SessionManager {
  getTrackedCommands(sessionId: string): readonly TrackedCommand[];
  getLastCompletedCommand(sessionId: string): TrackedCommand | null;
  requestScrollbackDump(sessionId: string): Promise<{
    data: string; lineCount: number; truncated: boolean;
  }>;
}
```

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| `ShellIntegrationInjector` (bash/zsh/fish/pwsh) | Multi-shell rc loading is brittle; each shell has corner cases (zsh `ZDOTDIR`, fish `vendor_conf.d`, pwsh strict mode) | Vendor exact VS Code scripts (MIT) without modification. Smoke-test matrix in `tasks.md` task 4_x: bash + zsh + fish on macOS; bash on Linux (Docker); pwsh on Windows VM. Document gaps in README. |
| `oscParser.ts` (hot path) | New marker handling on every PTY byte risks regressing existing OSC 7 / OSC 633;P behavior | Keep existing fast-path branches; add new markers as an `else if` chain inside the same dispatch. Cover with unit tests (Vitest) on a fixture stream containing every marker combination. |
| `requestScrollbackDump` round-trip | Promise leak if session disposes mid-request | D4 safeguard: `_pendingDumps` iterated on dispose, rejected with `ScrollbackDumpAbortedError`. 5-second backstop timeout. Unit-test both paths. |
| Tracked-command memory growth | Long-running shells accumulate command objects | D5 eviction + 100 KB per-command output cap. Unit-test eviction at boundaries (200th, 201st; 1 MB ± 1 byte). |
| OSC 633 `E` spoofing | Malicious output could forge command-line entries | Per-session nonce (UUIDv4) issued at spawn, set as `VSCODE_NONCE` env; parser rejects `E` markers without matching nonce. Mirrors VS Code's own approach. |
| Save-dialog write failure | Permission denied / read-only volume mid-write leaves orphan `.tmp` | `.tmp` + `rename` (D8) is atomic on POSIX and VS Code's fs API. On failure, attempt `vscode.workspace.fs.delete(tmpUri)` in a `finally`; if cleanup itself fails, log only — we already surfaced the original error toast. |
| ANSI stripping perf on >5 MB buffer | Brief main-thread block (~10-50 ms) | Acceptable for an explicit user-initiated export. Document the size threshold; if user reports complaint, move to a worker. Not optimising preemptively. |
| Cross-cutting test infrastructure | This change introduces patterns (vendored scripts + new IPC) that touch areas with low test density | Add Vitest unit coverage at the OSC parser + injector + eviction layers. Manual smoke-test matrix documented in tasks.md task 5_2. |
