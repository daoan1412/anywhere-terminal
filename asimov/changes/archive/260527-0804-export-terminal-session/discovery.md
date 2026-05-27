# Discovery: export-terminal-session

> Source brief: `docs/external-research/top-quick-wins.md` #1 ("Save Buffer to File", PLAN.md §5.4)
> User scoping question: *Can we export one command + its result, or must we export everything?*

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Memory Recall | Done | `bun run asm memory search` |
| Architecture Snapshot | Done | finder subagent |
| External Research | Done | librarian subagent → `docs/research/20260526-export-session-research.md` |
| Internal Patterns (existing save/export) | Done | finder subagent |
| Constraint Check (deps) | Done | direct (`strip-ansi` only) |

## Key Findings

### 1. Existing buffer infrastructure is sufficient

- Each session has two buffers we can read **without new IPC**:
  - **Extension-side** `OutputBuffer` (`src/session/OutputBuffer.ts:62-328`) — raw PTY bytes, capped 1 MB FIFO. Held during in-flight flushes.
  - **Extension-side scrollback cache** (`src/session/SessionManager.ts:1091-1099` + `getScrollbackData()` at `:709-714`) — joined string of recent output, capped **512 KB per session**.
- For *fuller* scrollback than 512 KB, we have to ask the **webview** to serialize xterm.js's in-memory scrollback (xterm's `SerializeAddon` already used by `SnapshotPersistence.ts:22,56` for session restore). That requires a new IPC round-trip (`requestScrollbackDump` → `scrollbackDump` response) — not present today.
- Session lookup for "the focused terminal" exists: `getFocusedProvider().getActiveSessionId()` in `extension.ts:214`.

### 2. Command registration is straightforward

- Pattern: declare in `package.json` `contributes.commands` (around `:191-327`), implement in `extension.ts:128-138`.
- File I/O pattern available: `SessionStorage.ts:272-295` uses `fs.promises.writeFile` + atomic rename. For user-facing save we should use `vscode.window.showSaveDialog()` (no current callsite — first use in this repo).

### 3. Per-command export depends on shell integration we don't have today

- Our `OSC` parser (`src/pty/oscParser.ts:1-80`) reads OSC 7 + OSC 633's **`P;Cwd=` property only**. The `A` (prompt start), `B` (command end), `C` (pre-execution), `D` (finished + exit code) markers are **ignored** — there is no command-boundary state in our codebase.
- Per-command export requires that the running shell **emits** these markers. In VS Code's built-in terminal that injection happens transparently; in AnyWhere Terminal we own a separate PTY, so:
  - Users would have to source the script themselves (`source $(code --locate-shell-integration-path <shell>)` — works for bash/fish/pwsh/zsh on macOS/Linux, Git Bash + pwsh on Windows).
  - Or AT injects the script at PTY spawn time (MIT-licensed; non-trivial; need to handle profile-specific shells, rc files, Windows differences).
- VS Code's extension API exposes `TerminalShellIntegration.executeCommand()` / `onDidEnd…ShellExecution` for **VS Code's own terminal**, not for third-party PTYs — **not reusable here**.
- Reference terminals (WezTerm/iTerm2/Kitty/Warp) all rely on OSC 133 or OSC 633 markers; none have heuristic per-command detection that is reliable.

### 4. ANSI handling

- `strip-ansi` v7.2.0 (sindresorhus, actively maintained, 10k+ dependents) is the standard. Light add. For visual fidelity, an HTML render or asciinema `.cast` is the alternative — significantly bigger scope.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Session data source | `OutputBuffer` + `scrollbackCache` (512 KB) | Full scrollback for export | Optional new IPC dump for >512 KB **OR** accept cache cap |
| File save UX | none | `showSaveDialog` + write | Net-new helper |
| Command registration | existing pattern | one new command (or family) | Net-new entry |
| ANSI stripping | none | `strip-ansi` | Add dependency |
| Command-boundary detection | OSC 633 parser reads `Cwd=` only | Track `A/B/C/D/E` markers + command objects (`text`, `output`, `exitCode`, `cwd`, `startedAt`, `endedAt`) | **Significant** — new parser state + memory model |
| Shell-integration script injection | none | Either user-sources script or AT injects it | **Significant** — multi-shell, multi-platform |

## Options

### Option A — Whole-buffer export only

Export the entire scrollback (or last 512 KB / 1 MB) of the focused session to a `.txt`/`.log` file with `Plain text` (default), `ANSI stripped`, or `ANSI preserved` formats. No command awareness.

- **Effort**: ~1 day (matches PLAN.md §5.4 estimate)
- **Pros**: Lowest risk, matches the original quick-win brief, zero shell-integration dependency, works on every platform/shell.
- **Cons**: Can't answer the user's "just one command + result" question — user gets the whole thing and has to trim manually.
- **Direct answer to user's question**: *No per-command export.*

### Option B — Whole-buffer + selection range (Recommended)

A + a second command "Export Selection…" that exports the **currently-selected text** in the focused terminal (xterm.js `terminal.getSelection()`). User highlights a command and its output, runs the command, gets a file.

- **Effort**: ~1–1.5 day (adds a tiny IPC `getSelection` round-trip + a second palette entry).
- **Pros**: Directly answers the user's question with **predictable, no-magic UX**. User picks the range; we don't have to detect anything. Works on every shell. Falls back cleanly to whole-buffer when nothing is selected.
- **Cons**: Manual selection — not as polished as Warp-style "click a block".
- **Direct answer to user's question**: *Yes — user selects the command + its output, then "Export Selection".*

### Option C — Per-command export via OSC 633 shell integration

Track `A/B/C/D` markers, build an in-memory list of commands per session, expose "Export Last Command Output" + "Export Command N…" picker.

- **Effort**: ~1 week minimum (parser state, command model, eviction, UI, plus shell-integration script injection or activation docs).
- **Pros**: Best UX when it works ("AT: Export Last Command"). Lays groundwork for "copy last output", "run recent command", quick-win-like polish.
- **Cons**:
  - Requires shell-integration script (either user sources it, or AT injects — both have multi-shell/Windows complexity).
  - Silently degrades on shells without integration → user confusion ("why is my command list empty?").
  - Out of scope for the original "1-day quick win" framing in PLAN.md §5.4.
  - Risk: Microsoft expands `TerminalShellIntegration` API or absorbs the feature; our parser becomes parallel code to maintain.

## Risks

1. **Memory disclosure via ANSI codes** — Exported buffers may contain credentials echoed via password prompts that didn't honor `echo off`, or secrets in `env` dumps. *Mitigation:* honest README note, no auto-upload, default filename includes timestamp + session name (so file lands in user-controlled location).
2. **Buffer-size truncation surprises** — 512 KB scrollback cap means long sessions silently lose head. *Mitigation:* either add IPC dump for full webview scrollback (extra ~50 LOC) or document the cap clearly in the save dialog.
3. **Selection across panes/splits ambiguous (Option B)** — `terminal.getSelection()` returns one terminal's selection; the active pane determines which. *Mitigation:* explicit "Active pane only" in the command title + fall back to whole-buffer if nothing selected.
4. **Per-command tracking grows unbounded (Option C)** — without eviction, a long-running session accumulates command objects. *Mitigation:* cap by count (last 200) + by total bytes (1 MB).
5. **Microsoft absorption risk** — VS Code core might ship Save Buffer in 2026. *Mitigation:* none for risk, but Options A/B ship fast enough to plant a flag before that.

## Open Questions

1. **Scope decision** — A, B, or C? (Gate 1.)
2. If A or B: do we add the IPC `requestScrollbackDump` round-trip (full webview scrollback, up to xterm's configured 5000 lines) or accept the 512 KB extension-side cap?
3. Default format: plain text (ANSI stripped), or ANSI-preserved?
4. Filename convention: `<terminal-name>-<timestamp>.txt` (per quick-wins doc) — confirm.
