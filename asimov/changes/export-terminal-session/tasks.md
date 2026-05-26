<!-- Parallelisation: section 2 (shell-integration tracking) and section 3 (webview scrollback dump IPC) touch disjoint files and may proceed in parallel after 1_1 lands. Section 4 (export commands) depends on the end of both. -->

## 1. Foundation

- [x] 1_1 Add `strip-ansi@^7.2.0` runtime dependency
  - **Deps**: none
  - **Refs**: `proposal.md` In scope · `design.md` D7
  - **Scope**: `package.json`, `pnpm-lock.yaml`
  - **Acceptance**:
    - Outcome: `strip-ansi` resolves to v7.2.x in lockfile; bundle size delta documented in commit message; type check passes.
    - Verify: manual pnpm run check-types passes after install
  - **Plan**:
    1. `pnpm add strip-ansi@^7.2.0`; run `pnpm run check-types`; ensure no transitive duplicate (`pnpm why strip-ansi` shows one resolved version).

## 2. Shell integration tracking

- [x] 2_1 Vendor MIT shell-integration scripts from VS Code
  - **Deps**: none
  - **Refs**: `specs/shell-integration-tracker/spec.md` Requirement "Inject shell-integration scripts at PTY spawn" · `design.md` D3 · `docs/research/20260526-export-session-research.md` §Platform-Specific Setup
  - **Scope**: `resources/shell-integration/shellIntegration-bash.sh`, `resources/shell-integration/shellIntegration-rc.zsh`, `resources/shell-integration/shellIntegration-profile.zsh`, `resources/shell-integration/shellIntegration-env.zsh`, `resources/shell-integration/shellIntegration-login.zsh`, `resources/shell-integration/shellIntegration.fish`, `resources/shell-integration/shellIntegration.ps1`, `NOTICE`
  - **Acceptance**:
    - Outcome: vendored scripts verbatim from `microsoft/vscode` `src/vs/workbench/contrib/terminal/common/scripts/` at pinned tag; MIT attribution added to `NOTICE`; scripts referenced are loadable by their respective shells when sourced directly.
    - Verify: manual ls resources/shell-integration/ shows all 7 files; head -5 of each file shows VS Code copyright header preserved
  - **Plan**:
    1. Copy the seven scripts from `microsoft/vscode` at the tag pinned in `docs/research/20260526-export-session-research.md`, preserve headers verbatim, add a `NOTICE` block crediting VS Code.

- [x] 2_2 Extend OSC parser with A/B/C/D/E markers + nonce check
  - **Deps**: 1_1
  - **Refs**: `specs/shell-integration-tracker/spec.md` Requirement "Parse OSC 633 command-boundary markers" · `design.md` D2 · `design.md` D3 (nonce wiring)
  - **Scope**: `src/pty/oscParser.ts`, `src/pty/oscParser.test.ts`, `src/pty/ShellIntegrationEvents.ts` (new — typed event shapes)
  - **Acceptance**:
    - Outcome: parser emits typed events `{ kind: "promptStart" | "commandStart" | "commandEnd" | "commandLine" | "cwd", payload }` for OSC 633 A/B/C/D/E/P respectively; existing `P;Cwd=` behaviour unchanged; `E` events without matching nonce carry `nonceValid: false`.
    - Verify: unit src/pty/oscParser.test.ts
  - **Plan**:
    1. Add event union type in `ShellIntegrationEvents.ts`.
    2. Refactor `oscParser.ts` to dispatch via the union; keep the `;P;Cwd=` fast path as today.
    3. Add Vitest fixtures: pure markers, mixed-with-output, malformed `D` arg (`xyz`), `E` with bad nonce, `E` with good nonce.

- [x] 2_3 Add tracked-command model to `TerminalSession` + eviction
  - **Deps**: 2_2
  - **Refs**: `specs/shell-integration-tracker/spec.md` Requirements "Per-session command list with bounded memory" + "Public read API for tracked commands" · `design.md` D1 · `design.md` D5
  - **Scope**: `src/session/TrackedCommand.ts` (new), `src/session/TerminalSession.ts`, `src/session/TerminalSession.test.ts`, `src/session/SessionManager.ts`, `src/session/SessionManager.trackedCommands.test.ts` (new)
  - **Acceptance**:
    - Outcome: `TerminalSession.commands: TrackedCommand[]` exists and is updated on each parser event; per-command output cap (100 KB) + per-session caps (200 entries OR 1 MB total `output`) enforced FIFO; `SessionManager.getTrackedCommands()` and `getLastCompletedCommand()` behave per spec.
    - Verify: unit src/session/SessionManager.trackedCommands.test.ts
  - **Plan**:
    1. Define `TrackedCommand` interface in its own file per `design.md` D1 Interfaces.
    2. Wire `oscParser` events to a private `_handleShellEvent()` on `TerminalSession`.
    3. Implement `_inFlightCommand` open/close per D2.
    4. Enforce 100 KB output cap + truncation flag inside the open-command append path.
    5. Run eviction after every D-marker close (200 / 1 MB rule).
    6. Expose `getTrackedCommands` + `getLastCompletedCommand` on `SessionManager`; Vitest covers boundary at 200/201, 1 MB ± 1 byte, in-flight-skipped.

- [ ] 2_4 Shell-integration injector
  - **Deps**: 2_1, 2_3
  - **Refs**: `specs/shell-integration-tracker/spec.md` Requirement "Inject shell-integration scripts at PTY spawn" · `design.md` D3
  - **Scope**: `src/pty/ShellIntegrationInjector.ts` (new), `src/pty/ShellIntegrationInjector.test.ts` (new), `src/pty/PtyManager.ts` (or whichever module currently calls `node-pty.spawn`)
  - **Acceptance**:
    - Outcome: `injectShellIntegration(shellPath, args, env)` returns `{ args, env, nonce }` with shell-specific transformations from D3 for bash/zsh/fish/pwsh and `null` for others; PTY spawn path uses the result when non-null; per-session nonce stored on `TerminalSession` for parser comparison.
    - Verify: unit src/pty/ShellIntegrationInjector.test.ts
  - **Plan**:
    1. Implement detection by `path.basename(shellPath)` matching `bash | zsh | fish | pwsh | pwsh.exe`.
    2. For each shell, build the args/env transformation per D3 table.
    3. Generate per-spawn UUID nonce, set `VSCODE_NONCE` env, and return it for the session to store.
    4. In PTY spawn module, call the injector and merge result; pass nonce into `TerminalSession` constructor.
    5. Tests: snapshot the args+env triplet per shell; ensure `null` for `cmd.exe` / `nushell`.

## 3. Webview scrollback dump IPC

- [x] 3_1 Add IPC message types
  - **Deps**: none
  - **Refs**: `specs/webview-scrollback-dump/spec.md` Requirement "Request/response IPC for full xterm scrollback" · `design.md` D4
  - **Scope**: `src/types/messages.ts`
  - **Acceptance**:
    - Outcome: `RequestScrollbackDump` + `ScrollbackDump` shapes exported and added to the discriminated message union in both directions; type check passes.
    - Verify: manual pnpm run check-types passes
  - **Plan**:
    1. Add the two interfaces verbatim from `design.md` D4 to the message-types union.

- [ ] 3_2 Webview-side handler using SerializeAddon
  - **Deps**: 3_1
  - **Refs**: `specs/webview-scrollback-dump/spec.md` Requirement "Request/response IPC for full xterm scrollback"
  - **Scope**: `src/webview/messages/scrollbackDumpHandler.ts` (new), wiring file (`src/webview/messages/index.ts` or the existing dispatch site found by finder), `src/webview/terminal/TerminalFactory.ts` (only if needs reference to existing SerializeAddon import — read first; modify only if necessary)
  - **Acceptance**:
    - Outcome: on receiving `requestScrollbackDump`, the webview locates the xterm Terminal by `tabId`, serialises via `SerializeAddon.serialize({ scrollback: undefined })` (full), and replies with `data`, `lineCount = terminal.buffer.normal.length`, `truncated` true iff `lineCount === terminal.options.scrollback`. Unknown `tabId` replies with the empty-payload scenario.
    - Verify: unit src/webview/messages/scrollbackDumpHandler.test.ts
  - **Plan**:
    1. Implement the handler module.
    2. Register it in the webview dispatch table (find existing pattern, follow it).
    3. Unit tests with a stubbed Terminal that exposes the necessary buffer/options/SerializeAddon surface; cover the unknown-tab scenario per spec.

- [ ] 3_3 Extension-side `requestScrollbackDump()` with dispose + timeout safety
  - **Deps**: 3_1
  - **Refs**: `specs/webview-scrollback-dump/spec.md` Requirement "Extension-side promise wrapper with session-dispose safety" · `design.md` D4
  - **Scope**: `src/session/SessionManager.ts`, `src/session/SessionManager.scrollbackDump.test.ts` (new), `src/session/errors.ts` (or wherever existing session errors live — add `ScrollbackDumpAbortedError`, `ScrollbackDumpTimeoutError`)
  - **Acceptance**:
    - Outcome: `requestScrollbackDump(sessionId)` posts the message, awaits a reply matching `requestId`, resolves with the payload; if the session is disposed first the promise rejects with `ScrollbackDumpAbortedError`; if neither happens within 5 s it rejects with `ScrollbackDumpTimeoutError`; concurrent requests for the same session resolve independently.
    - Verify: unit src/session/SessionManager.scrollbackDump.test.ts
  - **Plan**:
    1. Add `_pendingDumps: Map<string, { resolve; reject; sessionId; timer }>` on SessionManager.
    2. Implement post + register in the map; webview-side reply handler resolves + clears timer.
    3. On `disposeSession`, iterate the map, reject matching entries, clear their timers.
    4. Add the two typed error classes.
    5. Cover happy / dispose / timeout / concurrent paths in unit test using a fake webview that records posts and lets the test trigger replies.

## 4. Export commands

- [ ] 4_1 Shared export helpers (sanitize filename, ANSI strip, save flow)
  - **Deps**: 1_1, 3_3
  - **Refs**: `specs/terminal-session-export/spec.md` Requirements "ANSI stripping by default with raw-preserved option" · `design.md` D7 · `design.md` D8
  - **Scope**: `src/commands/exportHelpers.ts` (new), `src/commands/exportHelpers.test.ts` (new)
  - **Acceptance**:
    - Outcome: exports `sanitizeFilenameSegment(name)`, `defaultExportFilename(sessionName, ext)`, `writeExportAtomically(uri, content)`, `formatCommandBlock(cmd)` (returns the `$ <commandLine>\n[exit ...] [cwd ...]\n\n<output>` layout per spec), `applyAnsiPreference(text, preserveAnsi)`; all pure (no `vscode.window` calls).
    - Verify: unit src/commands/exportHelpers.test.ts
  - **Plan**:
    1. Implement each helper per the spec/design clauses.
    2. Tests: sanitization regex `[^A-Za-z0-9._-]`→`_`, timestamp format `YYYYMMDD-HHmmss`, atomic-rename happy + write-fail + cleanup paths, command-block formatter (null exit code → `[exit ?]`).

- [ ] 4_2 Implement `anywhereTerminal.exportBuffer` command
  - **Deps**: 3_3, 4_1
  - **Refs**: `specs/terminal-session-export/spec.md` Requirement "Export Buffer command" · `design.md` D7, D8
  - **Scope**: `src/commands/exportBufferCommand.ts` (new)
  - **Acceptance**:
    - Outcome: command resolves focused session via `getFocusedProvider().getActiveSessionId()`, calls `SessionManager.requestScrollbackDump`, runs `applyAnsiPreference` based on save-dialog filter the user chose, calls `writeExportAtomically`, shows success/error toasts per spec. No-focus path shows the warning toast verbatim from spec.
    - Verify: manual run command from palette in a live session, save file, verify content + ANSI-stripped output
  - **Plan**:
    1. Implement the handler using the helpers from 4_1.
    2. Save-dialog `filters`: `{ "Text (ANSI stripped)": ["txt", "log"], "Raw (ANSI preserved)": ["log", "ansi"] }`.
    3. Detect chosen filter from returned URI extension (`.ansi` → preserve; else strip).
    4. Wrap the dump in try/catch — on `ScrollbackDumpTimeoutError`/`ScrollbackDumpAbortedError` show error toast with cause.

- [ ] 4_3 Implement `anywhereTerminal.exportLastCommand` command
  - **Deps**: 2_3, 4_1
  - **Refs**: `specs/terminal-session-export/spec.md` Requirement "Export Last Command Output command"
  - **Scope**: `src/commands/exportLastCommandCommand.ts` (new)
  - **Acceptance**:
    - Outcome: command calls `SessionManager.getLastCompletedCommand(sessionId)`; if null, shows the info toast with `Help` button (opens README anchor); otherwise formats via `formatCommandBlock`, runs ANSI preference, writes file via shared save flow.
    - Verify: manual run command in a shell with integration active; run command in a shell without integration to confirm the help toast appears
  - **Plan**:
    1. Implement using helpers from 4_1.
    2. `Help` button uses `vscode.env.openExternal` with `README.md#shell-integration` GitHub URL (or `vscode.commands.executeCommand("markdown.showPreview", ...)` to the bundled README — pick whichever works locally; document choice in the commit).

- [ ] 4_4 Implement `anywhereTerminal.exportCommand` picker
  - **Deps**: 2_3, 4_1
  - **Refs**: `specs/terminal-session-export/spec.md` Requirement "Export Command picker"
  - **Scope**: `src/commands/exportCommandPickerCommand.ts` (new)
  - **Acceptance**:
    - Outcome: command calls `SessionManager.getTrackedCommands(sessionId)`; if empty, falls back to the same toast as 4_3; otherwise opens `showQuickPick` with `label` = truncated command-line (≤80 chars, `…` suffix on truncation) and `detail` = `exit <exitCode> · <cwd> · <relative-time>`; selected pick written via shared save flow.
    - Verify: manual run command in a shell with ≥3 tracked commands; verify picker order is most-recent-first and selection writes correct content
  - **Plan**:
    1. Implement using helpers from 4_1.
    2. Relative-time format: use a small inline helper (`s/m/h/d` ago) — avoid adding `date-fns` for one usage.
    3. Quick-pick `placeholder`: `"Select a command to export"`.

- [ ] 4_5 Register the three commands in `package.json` + `extension.ts`
  - **Deps**: 4_2, 4_3, 4_4
  - **Refs**: `specs/terminal-session-export/spec.md` (all three command requirements)
  - **Scope**: `package.json`, `src/extension.ts`
  - **Acceptance**:
    - Outcome: three new `contributes.commands` entries with titles per spec; three `vscode.commands.registerCommand` calls in `extension.ts`, each subscribing to disposal on extension deactivate.
    - Verify: manual pnpm run check-types passes; commands appear in Command Palette under "AnyWhere Terminal:"
  - **Plan**:
    1. Add `contributes.commands` entries for `anywhereTerminal.exportBuffer`, `anywhereTerminal.exportLastCommand`, `anywhereTerminal.exportCommand`.
    2. Register handlers in `activate()` following the existing pattern at `extension.ts:128-138`; push to `context.subscriptions`.

## 5. Docs + smoke-test matrix

- [ ] 5_1 README section "Export Terminal Session" with shell-integration setup + privacy note
  - **Deps**: 4_5
  - **Refs**: `proposal.md` In scope · `design.md` D3 · `design.md` D6
  - **Scope**: `README.md`
  - **Acceptance**:
    - Outcome: new H2 section explains the three commands, lists supported shells per D3 table, includes a `#shell-integration` anchor matching the `Help` button URL in 4_3, honestly states that unrecognised shells fall back to whole-buffer export only, AND includes a one-line privacy note: `"Exports include the literal command line, current working directory, exit code, and raw output of the terminal — review files before sharing."` The privacy note appears under all three command descriptions so it cannot be missed.
    - Verify: none — docs-only
  - **Plan**:
    1. Write the section under existing structure; cross-link from the features overview; include the privacy line verbatim.

- [ ] 5_2 Smoke-test matrix execution and result documentation
  - **Deps**: 4_5
  - **Refs**: `design.md` Risk Map row "`ShellIntegrationInjector`" · `specs/shell-integration-tracker/spec.md` Requirement "Inject shell-integration scripts at PTY spawn"
  - **Scope**: `docs/qa/export-session-smoke.md` (new — manual test log)
  - **Acceptance**:
    - Outcome: log records pass/fail for: bash on macOS, zsh on macOS, fish on macOS, bash in Linux Docker, pwsh on Windows VM (or noted-skipped with reason). Each row records: did markers fire, did `exportLastCommand` produce a non-empty file, did `exportBuffer` fall back cleanly when integration was disabled.
    - Verify: manual fill the log table for every reachable shell/platform; flag the rest as deferred to a follow-up issue
  - **Plan**:
    1. Run the AT extension locally, spawn each shell, run a representative command, exercise the three export commands, record results.
    2. For Windows pwsh / Linux bash where local hardware isn't available, file a follow-up issue and link it in the log.
