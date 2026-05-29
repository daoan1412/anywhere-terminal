## 1. Registry + types (foundation)

- [x] 1_1 Define vault types + the data-driven agent registry
  - **Deps**: none
  - **Refs**: specs/agent-vault-registry/spec.md; design.md D1; design.md Interfaces; docs/research/20260528-cmux-vault-mechanism.md §1,§5,§6,§7
  - **Scope**: `src/vault/types.ts`, `src/vault/registry.ts`, `src/vault/registry.test.ts`
  - **Acceptance**:
    - Outcome: `AgentVaultDefinition`/`CommandTemplate`/`VaultSessionEntry`/`VaultListResult` types exist; `registry.ts` exports records for `claude`, `codex`, `opencode` with the exact resume/fork templates, `forkMinVersion` 1.14.50 on opencode, and the 8-var `authEnvAllowlist` on claude.
    - Verify: unit src/vault/registry.test.ts
  - **Plan**:
    1. Add the interfaces from design.md Interfaces to `types.ts`.
    2. In `registry.ts` define the three records; encode resume/fork command shapes per agent-vault-registry spec, with optional flag fragments (model/permission/approval/sandbox/reasoning/agent).
    3. Test: assert each record's resume template contains `{{sessionId}}`, opencode carries `forkMinVersion`, claude carries the 8-var allowlist.

- [x] 1_2 Extend `SessionManager.createSession` with an optional `env` override
  - **Deps**: none
  - **Refs**: design.md D5; src/session/SessionManager.ts:346-409 (baseEnv at 395, injection auto-skips unknown shells at 403)
  - **Scope**: `src/session/SessionManager.ts`, `src/session/SessionManager.test.ts` (or nearest existing unit test for createSession)
  - **Acceptance**:
    - Outcome: `createSession` options accept an optional `env?: Record<string,string>` that is merged OVER `baseEnv` before spawn (and over the shell-integration env when injection applies); existing callers (no `env`) are unaffected.
    - Verify: unit src/session/SessionManager.test.ts
  - **Plan**:
    1. Add `env?` to the options type; after `baseEnv`/injection resolve, do `spawnEnv = { ...spawnEnv, ...options.env }`.
    2. Test: passing `env: { CLAUDE_CONFIG_DIR: "/x" }` reaches `pty.spawn` env; omitting it leaves env unchanged.

## 2. Session readers + aggregation (host)

- [x] 2_1 WAL-safe read-only SQLite helper via the `sqlite3` CLI
  - **Deps**: 1_1
  - **Refs**: specs/agent-session-index/spec.md (WAL-safe read-only SQLite access); design.md D3; docs/research/20260528-cmux-vault-mechanism.md §4,§7
  - **Scope**: `src/vault/sqlite.ts`, `src/vault/sqlite.test.ts`
  - **Acceptance**:
    - Outcome: `readSqlite(dbPath, sql): Promise<{ rows: Record<string,unknown>[]; status: "ok"|"no-db"|"no-sqlite3"|"query-error"; error?: string }>` — copies db+`-wal`+`-shm` to a temp dir, runs `sqlite3 -readonly -json <copy> <sql>` via `execFile` (argv, not shell), parses the JSON array, and removes the temp dir in a `finally`. A one-time capability probe `sqlite3 -readonly -json :memory: "select 1"` gates `no-sqlite3`. Never throws.
    - Verify: unit src/vault/sqlite.test.ts
  - **Plan**:
    1. Memoize the capability probe (injectable exec dep, mirroring `processCwd.ts:19-33`); when it fails → `{rows:[],status:"no-sqlite3"}`.
    2. If `dbPath` absent → `{rows:[],status:"no-db"}`. Else copy db + sidecars to `os.tmpdir()/at-vault-<uuid>/`, run sqlite3, `JSON.parse` stdout (retry once on failure), `rm -rf` temp in finally.
    3. Test (stubbed exec): rows→`ok`; missing-db→`no-db`; failed probe→`no-sqlite3`; bad stdout→`query-error`+error string.

- [x] 2_2 Claude Code session reader
  - **Deps**: 1_1
  - **Refs**: specs/agent-session-index/spec.md (Read Claude Code sessions; Metadata-only); design.md D4,D7,D8; docs/research/20260528-cmux-vault-mechanism.md §3
  - **Scope**: `src/vault/readers/claudeReader.ts`, `src/vault/readers/claudeReader.test.ts`, `src/vault/__fixtures__/claude/`, `src/vault/preview.ts`, `src/vault/preview.test.ts` _(preview.ts: shared D4 bounded-title helper reused by all 3 readers — added during build to avoid duplicating the privacy bound; see workflow Revision Log 2026-05-28)_
  - **Acceptance**:
    - Outcome: reader enumerates `<$CLAUDE_CONFIG_DIR|~/.claude>/projects/<enc-cwd>/*.jsonl`, yields `VaultSessionEntry[]` with sessionId=filename stem, cwd/gitBranch/permissionMode/model/title preview, modified=mtime; unparseable files are skipped and counted, not thrown.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. Resolve roots; glob `projects/*/*.jsonl` (cwd-encode `/`→`-` per D7).
    2. Stream each jsonl: first user line → title preview; first assistant line → `message.model`; capture cwd/gitBranch/permissionMode; `fs.stat` mtime.
    3. Wrap per-file parse in try/catch → skip + increment unreadable. Add 2 fixtures (valid + malformed); assert fields + skip behavior; assert no message body beyond the title string is retained (D4).

- [x] 2_3 Codex session reader (SQLite + JSONL fallback)
  - **Deps**: 2_1
  - **Refs**: specs/agent-session-index/spec.md (Read Codex sessions); design.md D3,D8; docs/research/20260528-cmux-vault-mechanism.md §4
  - **Scope**: `src/vault/readers/codexReader.ts`, `src/vault/readers/codexReader.test.ts`, `src/vault/__fixtures__/codex/`
  - **Acceptance**:
    - Outcome: reads `~/.codex/state_5.sqlite` `threads` (`WHERE archived=0 ORDER BY updated_at_ms DESC`) via `readSqlite`, mapping columns→`VaultSessionEntry` (incl. flags model/approval/sandbox/reasoning); when the db/sqlite3 is unavailable, falls back to `~/.codex/sessions/**/*.jsonl` (first-line `session_meta.payload.cwd`); both paths skip-and-count bad rows.
    - Verify: unit src/vault/readers/codexReader.test.ts
  - **Plan**:
    1. Build the static SELECT (design.md D3) and call `readSqlite`.
    2. Map rows → entries (flags from approval_mode/sandbox_policy/reasoning_effort; title from `title` else `first_user_message`).
    3. On `status` `no-db`/`no-sqlite3` → JSONL fallback (`~/.codex/sessions/**/*.jsonl`); on `query-error` → count unreadable, no fallback. Test all branches via stubbed `readSqlite` returning each status + a jsonl fixture.

- [x] 2_4 OpenCode session reader (SQLite)
  - **Deps**: 2_1
  - **Refs**: specs/agent-session-index/spec.md (Read OpenCode sessions); design.md D3,D8; docs/research/20260528-cmux-vault-mechanism.md §7
  - **Scope**: `src/vault/readers/opencodeReader.ts`, `src/vault/readers/opencodeReader.test.ts`, `src/vault/__fixtures__/opencode/`
  - **Acceptance**:
    - Outcome: reads `~/.local/share/opencode/opencode.db` `session` (+ correlated latest-assistant `message` subquery) ordered `time_updated DESC` via `readSqlite`; maps id=`s.id` (entry id `opencode:<id>`), cwd=`s.directory`, title=`s.title`, modified=`s.time_updated`, model/agent from the assistant JSON; absent db → `[]`.
    - Verify: unit src/vault/readers/opencodeReader.test.ts
  - **Plan**:
    1. Use the exact SQL from research §7 via `readSqlite`.
    2. Parse `last_assistant` JSON for `providerID`/`modelID`/`agent`; map row→entry.
    3. Test with stubbed `readSqlite` rows incl. one with malformed assistant JSON (→ model/agent undefined, entry still listed).

- [x] 2_5 VaultService — aggregate, sort, dedup, fork-support, unreadable count
  - **Deps**: 1_1, 2_2, 2_3, 2_4
  - **Refs**: specs/agent-session-index/spec.md (Aggregate and sort; Defensive parsing); specs/vault-session-launch/spec.md (Fork when supported); design.md D2,D8
  - **Scope**: `src/vault/VaultService.ts`, `src/vault/forkSupport.ts`, `src/vault/VaultService.test.ts`
  - **Acceptance**:
    - Outcome: `VaultService.list(): Promise<VaultListResult>` calls all enabled readers, merges into one list sorted by `modified` desc with agent-namespaced ids, sums `unreadable`, and sets `canFork` per entry (opencode gated on a memoized `opencode --version` ≥ 1.14.50 probe; claude/codex from registry `forkCommand` presence). A reader that throws contributes 0 entries without breaking the aggregate.
    - Verify: unit src/vault/VaultService.test.ts
  - **Plan**:
    1. `forkSupport.ts`: memoized `canForkOpenCode()` spawning `opencode --version`, parse first semver, compare to 1.14.50; on probe failure → false.
    2. `VaultService.list()`: `Promise.allSettled` over readers; flatten fulfilled, count rejected/unreadable; sort desc; set `canFork`.
    3. Test: stub readers (one rejects) → aggregate excludes it + still returns others; ordering + canFork logic asserted.

## 3. Launch (host)

- [x] 3_1 LaunchBuilder — synthesize resume/fork argv + auth env + injection safety
  - **Deps**: 1_1
  - **Refs**: specs/vault-session-launch/spec.md (Resume; Fork; Preserve Claude auth/config; Injection-safe construction); design.md D5,D6,D9
  - **Scope**: `src/vault/LaunchBuilder.ts`, `src/vault/LaunchBuilder.test.ts`
  - **Acceptance**:
    - Outcome: `build(entry, mode: "resume"|"fork", hostEnv): { file: string; args: string[]; cwd: string; env: Record<string,string> }` resolves the registry template into an **argv array** (no shell string), injecting captured flags only when present; for claude, merges the present-in-`hostEnv` 8-var allowlist + captured `configDir`; a session id/flag containing shell metacharacters is passed as one inert arg.
    - Verify: unit src/vault/LaunchBuilder.test.ts
  - **Plan**:
    1. Resolve template `executable` + expand `args` (static tokens + present flag fragments).
    2. Build `env`: base = {} for non-claude; for claude pick allowlisted keys from `hostEnv` + entry.flags.configDir.
    3. Test: claude resume argv + env allowlist; codex resume flag ordering; fork argv; **injection test** — id `"a; rm -rf ~"` stays a single `args` element (spec scenario).

- [x] 3_2 VaultLauncher — resolve an entry into `createSession` options
  - **Deps**: 3_1, 2_5
  - **Refs**: specs/vault-session-launch/spec.md (Resume; Fork when supported); design.md D5,D9
  - **Scope**: `src/vault/VaultLauncher.ts`, `src/vault/VaultLauncher.test.ts`
  - **Acceptance**:
    - Outcome: `VaultLauncher.resolve(entryId, mode): Promise<{ shell: string; shellArgs: string[]; cwd: string; env?: Record<string,string> }>` looks the entry up via VaultService, builds argv+env+cwd via LaunchBuilder, and maps to the `createSession` options shape (`shell`=executable, `shellArgs`=argv, `env`=Claude override); throws a typed "fork unsupported" error when `mode==="fork"` and `entry.canFork` is false. It does NOT spawn — the provider does (3_2 returns options only).
    - Verify: unit src/vault/VaultLauncher.test.ts
  - **Plan**:
    1. Resolve entry from VaultService.list() by id; map LaunchBuilder `{file,args,cwd,env}` → `{shell:file, shellArgs:args, cwd, env}`.
    2. Guard fork on `canFork`; throw typed error otherwise.
    3. Test (stub VaultService): resume + fork option shapes; unknown id and fork-unsupported throw.

## 4. IPC + panel + command (webview wiring)

- [x] 4_1 Add vault IPC + host handlers (incl. createSession + tabCreated wiring)
  - **Deps**: 2_5, 3_2, 1_2
  - **Refs**: specs/vault-panel/spec.md (Refresh on open); specs/vault-session-launch/spec.md (Resume a session in a new visible terminal); design.md D5,D6 Interfaces; src/providers/TerminalViewProvider.ts:374-398 (createTab flow: createSession → post `tabCreated`; catch → `error`)
  - **Scope**: `src/types/messages.ts`, `src/providers/TerminalViewProvider.ts`, `src/webview/messaging/MessageRouter.ts`, `src/extension.ts`
  - **Acceptance**:
    - Outcome: the 4 message interfaces are added to the two unions; `requestVaultSessions` → `VaultService.list()` → reply `vaultSessionsResponse`; `vaultResume`/`vaultFork` → `VaultLauncher.resolve(...)` then **mirror the `createTab` flow**: `sessionManager.createSession(viewId, webview, {shell,shellArgs,cwd,env})` followed by posting `tabCreated` so the terminal is visible; any launch/resolve failure posts an `error` notice (no silent broken terminal). `VaultService`+`VaultLauncher` are constructed in `extension.ts` activation alongside `SessionManager`.
    - Verify: manual — run the open-vault command, click resume: a new tab appears running the agent; force a bad executable → an error notice shows
  - **Plan**:
    1. Add the 4 interfaces to the two unions in `messages.ts`; construct VaultService+VaultLauncher in `extension.ts` and pass into the provider.
    2. In `TerminalViewProvider` onDidReceiveMessage add `requestVaultSessions`/`vaultResume`/`vaultFork` cases; for resume/fork copy the createTab pattern (createSession + `tabCreated` + try/catch→`error`).
    3. Add the webview-side dispatch case in `MessageRouter` for `vaultSessionsResponse` → forward to the panel.

- [x] 4_2 VaultPanel webview component (flat searchable list) + hidden sibling mount
  - **Deps**: 4_1
  - **Refs**: specs/vault-panel/spec.md (Searchable vault panel; In-panel search; Empty/partial-failure states); design.md D10; src/webview/fileTree/FileTreePanel.ts:50-107,770-929 (composition + header/search-bar pattern); src/providers/webviewHtml.ts:561-566 (layout DOM); src/webview/main.ts (composition root)
  - **Scope**: `src/webview/vault/VaultPanel.ts`, `src/webview/vault/vaultPanel.css`, `src/providers/webviewHtml.ts`, `src/webview/main.ts`
  - **Acceptance**:
    - Outcome: a new `#vault-panel` div is added as a sibling of `#file-tree` under `#webview-layout`; `new VaultPanel({ host, postMessage, getActiveSessionId })` renders rows (agent badge, title, cwd, relative time, resume + conditional fork buttons), has a client-side search box filtering on title/cwd/agent, shows empty-state + an "N unreadable" notice, posts `vaultResume`/`vaultFork` on click, and is **hidden by default**. Mounted in the composition root and fed by `vaultSessionsResponse`.
    - Verify: manual — open vault with ≥1 real claude/codex/opencode session; search filters; clicking resume opens a terminal running the agent
  - **Plan**:
    1. Add `#vault-panel` to `webviewHtml.ts` layout; build `VaultPanel` modeled on FileTreePanel's deps/header/search-bar shape (D10) but a flat list, not Tree.
    2. Render rows from `VaultListResult`; wire resume/fork buttons to `postMessage`; implement client-side filter + empty/notice states.
    3. Mount in `main.ts` (hidden initially), route `vaultSessionsResponse` to `panel.render(result)`; add CSS using theme vars.

- [x] 4_3 AuxiliaryPanelManager — single-visible-panel exclusivity + persistence
  - **Deps**: 4_2
  - **Refs**: specs/vault-panel/spec.md (Auxiliary-panel exclusivity); design.md D11; src/webview/state/WebviewState.ts:14-36 (state shape); src/webview/main.ts:604-623 (file-tree mount); fileTreePanel.css:325-327 (`.file-tree-hidden`)
  - **Scope**: `src/webview/AuxiliaryPanelManager.ts`, `src/webview/AuxiliaryPanelManager.test.ts`, `src/webview/state/WebviewState.ts`, `src/webview/vault/vaultPanel.css`, `src/webview/main.ts`
  - **Acceptance**:
    - Outcome: a manager registers panels by id (`"file-tree" | "vault"`) and exposes `activate(id)` which hides the currently-shown panel and shows the target (at most one visible) by toggling `.file-tree-hidden` / `.vault-hidden`; the active id is persisted via a new `WebviewState.auxiliaryPanelActive` field and restored on reload; a hidden panel's own state is untouched. Adding a future panel = one `register()` call, no swap-logic edits.
    - Verify: unit src/webview/AuxiliaryPanelManager.test.ts
  - **Plan**:
    1. Add `auxiliaryPanelActive?: "file-tree" | "vault"` to `WebviewState`.
    2. Implement the manager (register/activate/hide-others) toggling host classes; add `.vault-hidden` CSS; persist+restore active id via the state store.
    3. Wire file-tree + vault into the manager in `main.ts` (default active = persisted or "file-tree"). Test: activate("vault") hides file-tree + persists; activate("file-tree") reverses; restore reads persisted id.

- [x] 4_4 Register the "Open AI Vault" command + manifest contribution
  - **Deps**: 4_3
  - **Refs**: specs/vault-panel/spec.md (Open command; Auxiliary-panel exclusivity); design.md D11; finder note (commands.registerCommand pattern)
  - **Scope**: `package.json` (contributes.commands + menu/view), `src/extension.ts`, `src/webview/main.ts`, `src/types/messages.ts`, `src/webview/messaging/MessageRouter.ts` _(messages.ts + MessageRouter added during build: the host command needs a host→webview `openVault` message to reach the AuxiliaryPanelManager; posts via view.webview directly so TerminalViewProvider is untouched. See workflow Revision Log 2026-05-28)_
  - **Acceptance**:
    - Outcome: a command (e.g. `anywhereTerminal.openVault`) is contributed and registered; invoking it activates the vault via the AuxiliaryPanelManager (hiding the file-tree) and triggers a fresh `requestVaultSessions`.
    - Verify: manual — run the command from the palette; the vault appears, the file-tree hides, and sessions list
  - **Plan**:
    1. Add the command (+ optional panel title-bar button) to `package.json` contributes.
    2. Register it in `extension.ts`; on invoke, signal the webview to `manager.activate("vault")` + post a refresh request.
