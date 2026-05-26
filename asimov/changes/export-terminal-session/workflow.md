# Workflow State: export-terminal-session

> **Source of truth:** Workflow stages/gates → this file · Task completion → `tasks.md`
>
> **Checkbox states:** `[ ]` pending · `[/]` in progress · `[x]` done · `[-]` skipped/N/A

## Plan

- [x] 1. Context + Triage
  - [x] Read `asimov/project.md`, run `bun run asm change list` + `bun run asm spec list`
  - [x] Choose `change-id`, run `bun run asm change new`
  - [x] Classify complexity + escalation flags → record in Notes
- [x] 2. Discovery
  - [x] Execute workstreams (parallel finder/librarian subagents)
  - [x] Fill `discovery.md` — findings, gap analysis, options, risks
  - [x] **GATE 1: user approved direction** _(skip for trivial)_
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — scenarios only when they pin acceptance beyond the requirement (default = none)
  - [x] Fill design.md _(standard or escalation-forced — skip if LOW risk + no escalation flags)_
  - [x] Fill tasks.md (deps, refs, done, test, files, approach)
- [x] 7. Validation
  - [x] `bun run asm change validate` passes
  - [x] Oracle review _(asm-oracle 4× gateway 524; succeeded via general-purpose opus background spawn; 8 findings, all accepted — triage in Revision Log)_
  - [x] **GATE 2: user approved plan**

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [ ] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [ ] 2. Execute tasks sequentially in dependency order
- [ ] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [x] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [x] Type check (pnpm run check-types — clean)
  - [x] Lint (biome via `rtk proxy` — 0 errors, 27 style-only warnings consistent with existing code; full-repo lint OOMs in this session, per-touched-file lint clean)
  - [x] Test (pnpm run test:unit — 1443/1443 pass)
  - [-] E2E (project.md → N/A)
- [ ] 5. Review (adaptive — skip for trivial or doc/design-only):
  - [ ] Code Review
- [ ] 6. Findings triage: accept/rebut each finding with rationale
- [ ] 7. Review Fix Loop _(max 3 rounds — fix, re-verify, re-review)_
- [ ] 8. Validation
  - [ ] **Gate: user approved implementation**
  - [ ] Extract knowledge

## Archive

- [ ] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_:
  - [ ] Run deploy command
  - [ ] Run smoke test
- [ ] Apply deltas: `bun run asm change apply`
- [ ] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

- **Source**: `docs/external-research/top-quick-wins.md` #1 "Save Buffer to File" + PLAN.md §5.4
- **User question (scope research)**: Can we export *just one command + its result*, or must we export the whole buffer? → Discovery must investigate command-boundary detection (shell integration / OSC 633 / prompt heuristics).
- **Complexity**: Standard — new feature, UI surface, scope ambiguity, file IO
- **Escalation flags**: None obvious yet (`strip-ansi` is lightweight; no cross-boundary refactor; new command palette entry follows existing pattern)
- **Related existing spec**: `output-buffer` (3 reqs) — likely the data source for export

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-26T00:00:00Z | claude | Stage 1 | Triage: standard complexity; no escalation flags initially | New feature, scope ambiguity flagged for discovery |
| 2026-05-26T00:00:00Z | claude | Stage 2 | Discovery written; finder + librarian + memory recall workstreams | User question on per-command vs whole-buffer scope required research |
| 2026-05-26T00:00:00Z | claude | Gate 1 | User chose Option C (per-command via OSC 633) + full webview scrollback IPC + ANSI-stripped default | Most ambitious path; escalates appetite S→L and adds new-dep + cross-boundary flags |
| 2026-05-26T00:00:00Z | claude | Stage 3-6 | proposal + 3 specs + design (D1–D8 + Risk Map) + 12 tasks batch-written | Gate 1 selection drives full ceremony with design.md required |
| 2026-05-26T00:00:00Z | claude | Stage 7 | `asm change validate` passes after Verify-field backtick fix in tasks.md | Validator requires bareword enum value |
| 2026-05-26T00:00:00Z | claude | Stage 7 | Oracle review attempted 4× (sync, background, post-model-switch); all returned Cloudflare 524 at the inference gateway | Gateway 120 s proxy timeout vs 175–242 s oracle response time |
| 2026-05-26T00:00:00Z | claude | Stage 7 | Review succeeded via background general-purpose opus spawn; 8 findings returned | asm-oracle subagent system prompt likely pushed runtime above gateway limit |
| 2026-05-26T00:00:00Z | claude | Stage 7 | Triage — F1 (D3 injection mechanism diverges from VS Code): **accepted, severity downgraded BLOCKER→IMPORTANT** (reviewer's `--rcfile`/`--init-file` claim was wrong — they are bash aliases — but USER_ZDOTDIR preservation + per-session writable temp + fish `--init-command` corrections are real). Rewrote D3 to mirror VS Code's `terminalEnvironment.ts`; task 2_4 plan now explicitly requires reading VS Code's source. | Avoid breaking user rc loading in zsh/fish/login-bash |
| 2026-05-26T00:00:00Z | claude | Stage 7 | F2 (duplicate-marker storm): **accepted**. Dropped `VSCODE_INJECTION=1` from D3 env vars; D3 now states injector MUST NOT overwrite `TERM_PROGRAM` (existing `AnyWhereTerminal` from PtyManager preserved) | Prevent user's own `.bashrc` re-sourcing the integration script and double-firing OSC 633 markers |
| 2026-05-26T00:00:00Z | claude | Stage 7 | F3 (tracked commands evaporate on reload): **accepted**. Amended D6 + the no-tracked-commands toast in `terminal-session-export` spec to acknowledge `"Commands track from window reload onward"`. Persisting `TrackedCommand[]` across reloads explicitly out of scope | Cheap honest-UX fix; persistence is a follow-up change |
| 2026-05-26T00:00:00Z | claude | Stage 7 | F4 (in-flight unbounded growth): **accepted**. Tightened spec scenario to specify append-time check ("WHEN appending bytes ... would cause output.length to exceed 100 KB"), eliminating close-time-only ambiguity | Defend against `cat /dev/urandom` style long-running commands |
| 2026-05-26T00:00:00Z | claude | Stage 7 | F5 (5 s timeout tight + spam-click race): **accepted**. D4 timeout 5 s → 15 s; added webview-side `tabId` dedupe (reuse in-flight Promise) | Slow-machine + backgrounded-window legitimate exports must not time out; concurrent serialisations waste CPU |
| 2026-05-26T00:00:00Z | claude | Stage 7 | F6 (spec leaks implementation details): **accepted**. Moved `strip-ansi@^7.2.0` version pin and `vscode.workspace.fs.writeFile` API name out of `terminal-session-export` spec into design.md D7/D8; removed `SerializeAddon` / `SnapshotPersistence.ts` mentions from `webview-scrollback-dump` spec | Specs encode behaviour contracts; implementation choices live in design |
| 2026-05-26T00:00:00Z | claude | Stage 7 | F7 (parallelisation): **accepted**. `tasks.md` 2_1 Deps `1_1`→`none`; added preamble noting section 2 and section 3 may run in parallel | Saves ~2 days on a 12-day plan |
| 2026-05-26T00:00:00Z | claude | Stage 7 | F8 (privacy framing): **accepted**. Task 5_1 README now includes a one-line privacy note about exported content (command line + cwd + exit code + raw output) | Users sharing files may not realise sensitive content is included |
| 2026-05-26T00:00:00Z | claude | Stage 7 | Re-validate after triage edits: `bun run asm change validate` passes | Gate 2 ready |
| 2026-05-26T00:00:00Z | claude | Gate 2 | User approved (workflow direction: apply all 8 fixes + proceed to asimov-build) | Handoff |
| 2026-05-26T00:00:00Z | claude | Build 1_1 | `pnpm add strip-ansi@^7.2.0` → installed as direct prod dep; `pnpm run check-types` clean. Production tree has only `strip-ansi@7.2.0`; devDep duplicates (6.0.1 via test-cli/c8/yargs chain) don't ship | Acceptance met; runtime bundle clean |
| 2026-05-26T00:00:00Z | claude | Build 2_1 | Fetched 7 shell-integration scripts from `microsoft/vscode@1.95.3` via raw.githubusercontent.com into `resources/shell-integration/`; fish lives under `fish_xdg_data/fish/vendor_conf.d/` in the source tree (404 on initial guess). NOTICE file created with MIT attribution + tag pin | Acceptance met; scripts verbatim with VS Code copyright headers preserved |
| 2026-05-26T00:00:00Z | claude | Build 3_1 | `RequestScrollbackDumpMessage` + `ScrollbackDumpMessage` added to `src/types/messages.ts`; appended to both discriminated unions in the correct direction (request → ExtensionToWebView, response → WebViewToExtension); `pnpm run check-types` clean | Type check is the acceptance |
| 2026-05-26T00:00:00Z | claude | Build 2_2 | New `src/pty/ShellIntegrationEvents.ts` (event union); refactored `oscParser.ts`: API changed from `feed(chunk, onCwd)` to `feed(chunk, onEvent)` + `setNonce()` method; sub-cmd dispatch for A/B/C/D/E with `__vsc_escape_value` unescape (\\x3b + \\\\); existing tests migrated via `cwdsOf` helper; 23 new tests for markers/nonce/lifecycle/chunk-split; PtySession wires new event sink + `setShellIntegrationNonce`. 1345/1345 tests pass | Acceptance met |
| 2026-05-26T00:00:00Z | claude | Build 2_3 | New `src/session/TrackedCommand.ts` (pure runtime — open/append/setLine/close + eviction); `TerminalSession.commandTracking` field; `SessionManager._handleShellIntegrationEvent` state machine + `getTrackedCommands` / `getLastCompletedCommand` public APIs; 21 new unit tests covering lifecycle, append-time cap (F4), dual eviction (entries + bytes), lastCompleted skipping in-flight; updated 9 test files' PtySession mocks for new `setShellIntegrationSink` / `setShellIntegrationNonce` methods. 1366/1366 tests pass | Acceptance met |
| 2026-05-26T00:00:00Z | claude | Commit | `18eda95 feat(export): section 2+3.1 — OSC 633 marker tracking, command runtime, IPC types` (Groups A + B per user direction; Group C user WIP left unstaged) | Checkpoint after 4/15 tasks |
| 2026-05-26T00:00:00Z | claude | Build 2_4 | New `src/pty/ShellIntegrationInjector.ts` with per-shell injection: bash `--init-file <session-temp>/shellIntegration.bash`; zsh per-session temp ZDOTDIR with 4 vendored files + USER_ZDOTDIR preserved; fish `--init-command "source <path>"`; pwsh `-noexit -command ". '<path>'"`. Skips `--noprofile --norc`, `-NoProfile` (case-insensitive). Drops `VSCODE_INJECTION=1` (F2), preserves existing `TERM_PROGRAM`. Per-session UUID nonce. 22 new tests for all 4 shells + opt-outs + env hygiene. Wired into SessionManager spawn path + cleanup callback registry. Real context wired in extension.ts (extensionPath/resources/shell-integration). 1385/1385 tests pass | Acceptance met |
| 2026-05-26T00:00:00Z | claude | Build 3_2 | New `src/webview/messaging/scrollbackDumpHandler.ts` — microtask-deduped handler that reuses one `SerializeAddon.serialize()` for N requests against the same `tabId`. Wired into `MessageRouter` + `main.ts` with a real `SerializeAddon` factory. 7 new tests for happy/empty-tab/dedupe/post-flush/dispose-on-throw. 1392/1392 tests pass | Acceptance met (F5 dedupe applied) |
| 2026-05-26T00:00:00Z | claude | Build 3_3 | `SessionManager.requestScrollbackDump(sessionId)` returns a Promise; `handleScrollbackDump(requestId, payload)` resolves matching pending request. New typed errors `ScrollbackDumpAbortedError` / `ScrollbackDumpTimeoutError`. 15-s backstop timeout (D4 F5). Cleanup path: rejects on session destroy + on full dispose. IPC wired in both `TerminalViewProvider` + `TerminalEditorProvider`. 9 new tests cover happy, abort, timeout, 14.999 s boundary, concurrent, unknown requestId, late reply, ghost session, dispose. 1403/1403 tests pass | Acceptance met |
| 2026-05-26T00:00:00Z | claude | Commit | `feat(export): section 2_4–3_3 — shell-integration injector + scrollback dump IPC` (8/15 tasks) | Section 3 complete |
| 2026-05-26T00:00:00Z | claude | Build 4_1 | New `src/commands/exportHelpers.ts` — pure helpers (`sanitizeFilenameSegment`, `defaultExportFilename` with deterministic-time injection, `applyAnsiPreference`, `formatCommandBlock`, `writeExportAtomically` with .tmp + rename + orphan cleanup, `preferenceFromExtension`). 20 new unit tests. 1423/1423 pass | Acceptance met |
| 2026-05-26T00:00:00Z | claude | Build 4_2–4_4 | New `src/commands/exportCommands.ts` — three handlers (`exportBuffer`, `exportLastCommand`, `exportCommand` quickpick). Full dependency-injection surface (VscodeSurface stub for tests). DRY no-tracked-commands toast (D6). Most-recent-first quickpick ordering; 80-char label truncation; Help button opens README anchor. 20 new tests covering no-focus warning, dump failure, ANSI preference, save-dialog cancel, no-tracked fallback, picker order + truncation. 1443/1443 pass | Acceptance met (commands tested at unit level; manual smoke deferred to 5_2) |
| 2026-05-26T00:00:00Z | claude | Build 4_5 | Three `contributes.commands` entries in package.json; three `registerCommand` calls in `extension.ts`; `buildExportDeps` helper assembles the VscodeSurface from `vscode.window.*` + `vscode.workspace.fs`. Type check clean. Lint via biome auto-fix applied (formatting only, no behaviour changes) | Acceptance met |
| 2026-05-26T00:00:00Z | claude | Build 5_1 | README.md "## Export terminal session" section: three commands table, save-dialog formats, F8 privacy line, supported-shell × platform matrix from D3, reload-resets-list note (F3) | Acceptance met |
| 2026-05-26T00:00:00Z | claude | Build 5_2 | `docs/qa/export-session-smoke.md` matrix scaffold: bash/zsh on macOS marked pending local test, fish/pwsh on macOS marked not-installed, Linux/Windows rows marked deferred-with-follow-up — honest record of what's reachable from this session | Acceptance met (partial — see Deferred section) |
| 2026-05-26T00:00:00Z | claude | Verify Gate | check-types clean; biome per-file clean (0 errors, 27 style-only warnings consistent with project baseline); 1443/1443 unit tests pass; E2E N/A per project.md | All gates passed |
