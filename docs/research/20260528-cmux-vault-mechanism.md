---
topic: cmux-vault-mechanism
created-by: research request to port cmux vault/session mechanisms into the anywhere-terminal VS Code extension MVP
date: 2026-05-28
libraries: [cmux]
used-by: []
---

# Research: cmux-vault-mechanism

## Answers

### 1) Agent registry data model
- `CmuxVaultAgentRegistration` is the exact record shape: `id`, `name`, optional `iconAssetName`, `detect`, `sessionIdSource`, `resumeCommand`, `cwd`, optional `sessionDirectory` (`Sources/VaultAgentRegistry.swift:12-43`).
- Validation rules:
  - `id` must match `^[A-Za-z0-9._-]+$` and cannot equal any built-in `RestorableAgentKind` rawValue (`Sources/VaultAgentRegistry.swift:46-57,100-102`).
  - `name` cannot be blank (`58-65`).
  - `resumeCommand` must contain `{{sessionId}}` or `{{sessionPath}}` (`67-75`).
  - `cwd` defaults to `.preserve`; `sessionDirectory` is trimmed and blank becomes `nil` (`84-87`).
- `CmuxVaultAgentDetectRule` fields: `processName: String?`, `processNames: [String]`, `argvContains: [String]` (`155-173`).
- `CmuxVaultAgentSessionIDSource` cases are exactly:
  - `.argvOption(String)`
  - `.piSessionFile`
  - `.grokSessionDirectory`
  (`200-285`).
- Built-in registry entries in source are only `pi`, `antigravity`, and `grok` (`116-151`). I did not find concrete `CmuxVaultAgentRegistration` entries for `claude` or `codex`; those are native session kinds elsewhere (`SessionAgent`/`RestorableAgentKind`), not vault registry records.

### 2) Process scan → PID↔pane mapping
- PTY-launch context tags are injected as:
  - `CMUX_WORKSPACE_ID`
  - `CMUX_SURFACE_ID`
  - aliases: `CMUX_PANEL_ID`, `CMUX_TAB_ID`
  - `CMUX_SOCKET_PATH`
  (`Sources/TerminalStartupEnvironment.swift:35-52`).
- The current launch cwd is separately propagated as `CMUX_AGENT_LAUNCH_CWD` by launcher/wrapper code (`CLI/cmux.swift:16337-16353,17344-17355`), and scanner code falls back to `PWD` if absent (`Sources/VaultAgentProcessScanner.swift:103,379,977`).
- Scope matching back to a pane happens in `cmuxScopeFromEnvironment`: any process with either workspace or surface env tag is attributed with reason `cmux-environment`; accepted keys are `CMUX_WORKSPACE_ID`/`CMUX_TAB_ID` and `CMUX_SURFACE_ID`/`CMUX_PANEL_ID` (`Sources/CmuxTopSnapshotScopeCache.swift:102-120`).
- The scanner then iterates `processSnapshot.cmuxScopedProcesses()` and requires both IDs:
  - `workspaceId = process.cmuxWorkspaceID`
  - `panelId = process.cmuxSurfaceID`
  - `PanelKey(workspaceId:workspaceId,panelId:panelId)` becomes the map key (`Sources/VaultAgentProcessScanner.swift:91-135`).
- Generic agent detection is `processName/processNames` basename match AND `argvContains` all-match (`766-795`). The repo does not define built-in `claude`/`codex` registry rules here; if you port this, the detector shape is generic, but the concrete claude/codex needles are not present in source.

### 3) Claude Code session index
- Root scan path pattern is `~/.claude/projects/<encoded-cwd>/*.jsonl`, with roots discovered from:
  - `CLAUDE_CONFIG_DIR` if set
  - `~/.codex-accounts/claude/*` (only if configured)
  - `~/.claude`
  (`Sources/SessionIndexStore.swift:698-749`).
- The directory name encoding is exactly `encodeClaudeProjectDir(path) = path.replacingOccurrences(of: "/", with: "-")` (`875-880`). Example: `/Users/x/y` → `-Users-x-y`.
- Decoding is the inverse fast-path, but lossy:
  - strip a leading `-`
  - replace `-` with `/`
  - only accept it if the resulting path exists on disk (`846-863`).
- For listing, the loader enumerates `*.jsonl` directly under the encoded project dir (`882-929`). The session id is the filename without extension (`1511-1518`).
- Parsed Claude fields:
  - `cwd`
  - `gitBranch`
  - `permissionMode`
  - assistant `message.model`
  - first user message title/preview via `SessionEntry.claudeDisplayTitle(from:...)`
  - PR metadata (`type == "pr-link"`, `prNumber`, `prUrl`, `prRepository`) (`752-823`).
- `SessionEntry` uses file mtime as `modified` and stores `sessionId`, `cwd`, `title`, `gitBranch`, `pullRequest`, `fileURL`, and `specifics: .claude(model:permissionMode:configDirectoryForResume:)` (`1399-1529`).

### 4) Codex SQLite index
- WAL-safe snapshot pattern:
  1. check `~/.codex/state_5.sqlite` exists
  2. create temp dir `cmux-codex-search-<UUID>`
  3. copy `state_5.sqlite` to `state.db`
  4. copy `state_5.sqlite-wal` and `state_5.sqlite-shm` if present
  5. open the copy read-only with `sqlite3_open_v2(..., SQLITE_OPEN_READONLY, nil)`
  (`Sources/SessionIndexStore+CodexSQL.swift:25-55`).
- Exact SQL against `threads`:

```sql
SELECT id, rollout_path, cwd, title, model, git_branch,
       approval_mode, sandbox_policy, reasoning_effort,
       first_user_message, updated_at_ms
FROM threads
WHERE archived = 0
```

- If `cwdFilter` is provided, append `AND cwd = ?1`. If `needle` is empty, order by `updated_at_ms DESC LIMIT <limit> OFFSET <offset>`; otherwise the SQL orders by `updated_at_ms DESC LIMIT searchMaxFiles` and does in-memory filtering afterward (`57-83`).
- Parsed columns map into `CodexThreadRecord(sessionId, rolloutPath, cwd, titleField, model, gitBranch, approvalMode, sandboxJSON, reasoningEffort, firstUserMessage, updatedMs)` (`5-23,90-105`).
- `SessionEntry` conversion uses:
  - `titleField` if present, else `realCodexUserMessage(firstUserMessage)`
  - `rollout_path` as `fileURL`
  - `cwd`, `gitBranch`, `model`, `approval_mode`, `sandbox_policy.type`, `reasoning_effort`
  (`158-190`).
- Disk fallback path is `~/.codex/sessions/**/*.jsonl` (`Sources/SessionIndexStore.swift:1588-1662`), with `peekCodexSessionMetaCwd()` reading the first line’s `session_meta.payload.cwd` for a fast cwd reject (`951-967`).

### 5) Resume command synthesis
- Claude resume command shape is built in `SessionIndexModels.swift` as:

```text
claude --resume <sessionId> [--model <model>] [--permission-mode <permissionMode>]
```

  with `--model` before `--permission-mode` (`Sources/SessionIndexModels.swift:315-328`).
- If `configDirectoryForResume` is present, the command is wrapped in an `env` prefix with:
  - `CLAUDE_CONFIG_DIR=<path>`
  - `CMUX_PRESERVE_CLAUDE_AUTH_SELECTION_ENV=1`
  - `CMUX_PRESERVE_CLAUDE_AUTH_SELECTION_ENV_KEYS=CLAUDE_CONFIG_DIR`
  (`325-328`).
- Codex resume command shape is:

```text
codex resume <sessionId> [-m <model>] [-a <approvalPolicy>] [-s <sandboxMode>] [-c model_reasoning_effort=<effort>]
```

  with flags emitted in that exact order (`329-343`).
- In the generic launcher path, Claude auth env preservation is whitelisted by `AgentResumeCommandBuilder.claudeAuthSelectionEnvironmentKeys`:
  - `ANTHROPIC_API_KEY`
  - `ANTHROPIC_AUTH_TOKEN`
  - `ANTHROPIC_BASE_URL`
  - `ANTHROPIC_MODEL`
  - `ANTHROPIC_SMALL_FAST_MODEL`
  - `CLAUDE_CODE_USE_BEDROCK`
  - `CLAUDE_CODE_USE_VERTEX`
  - `CLAUDE_CONFIG_DIR`
  (`Sources/RestorableAgentSession.swift:276-286,390-415`).
- Important split:
  - `SessionIndexModels.swift` only injects `CLAUDE_CONFIG_DIR` for Claude resume.
  - `RestorableAgentSession.swift` is where the broader auth-env whitelist is re-exported into the shell command via `env ...` (`390-415`).

### 6) Fork
- Claude fork command shape is:

```text
claude --resume <sessionId> --fork-session
```

  (`Sources/RestorableAgentSession.swift:636-640`).
- Codex fork command shape is:

```text
codex fork <sessionId>
```

  (`641-644`).
- There is no Claude/Codex fork version gate in source. `AgentForkSupport.supportsFork()` only version-gates OpenCode; for non-OpenCode kinds it returns `true` once a fork command exists (`Sources/AgentForkSupport.swift:292-351`).

## Recommended Approach
- Reimplement the vault registry as a strict data record with the exact field set above, but treat `claude`/`codex` as native agent kinds rather than vault registrations unless you intentionally want them configurable.
- For Claude sessions, mirror the lossy cwd directory encoding exactly (`/` → `-`) and keep the existence check on decode so your reverse lookup stays compatible with cmux behavior.
- For Codex, prefer the SQLite snapshot path first and keep the JSONL scan as a compatibility fallback only.

## Confidence
High — the key behaviors were confirmed from the source files above, including exact SQL, exact env tags, exact resume/fork strings, and exact path encoding/decoding logic.

## Gaps
- I did not find source-defined `CmuxVaultAgentRegistration` entries for `claude` or `codex`; source only shows built-in registry records for `pi`, `antigravity`, and `grok`.
- I did not find a claude/codex-specific process detector in `VaultAgentProcessScanner.swift`; only the generic `processName/processNames + argvContains` matcher is present.

### 7) OpenCode
- **On-disk store path:** `~/.local/share/opencode/opencode.db` (`Sources/SessionIndexStore.swift:1672-1678` via `OpenCodeDatabaseSnapshot.sourcePath` in `SessionIndexModels.swift:152-156`).
- **WAL-safe read pattern:** `OpenCodeDatabaseSnapshot.make(prefix:)` copies `opencode.db` into a temp dir (`cmux-opencode-search-<UUID>`), then copies `-wal` and `-shm` sidecars if present, and returns a snapshot opened read-only (`Sources/SessionIndexModels.swift:137-186`). `loadOpenCodeEntries` then opens the copied DB with `sqlite3_open_v2(..., SQLITE_OPEN_READONLY, nil)` and `defer { snapshot.remove() }` cleans up the temp dir (`Sources/SessionIndexStore.swift:1668-1694`).
- **SQL/table/columns:** the reader queries `session` plus a correlated `message` subquery:

```sql
SELECT s.id, s.title, s.directory, s.time_updated, (
    SELECT data FROM message
    WHERE session_id = s.id AND data LIKE '%"role":"assistant"%'
    ORDER BY time_created DESC LIMIT 1
) AS last_assistant
FROM session s
```

  Optional filters are appended as `WHERE (LOWER(s.title) LIKE ? OR LOWER(s.directory) LIKE ?)` and `s.directory = ?`, then the final clause is `ORDER BY s.time_updated DESC LIMIT <limit> OFFSET <offset>` (`Sources/SessionIndexStore.swift:1696-1757`).
- **Session id + list-entry mapping:** `sessionId` is `s.id` from the `session` table; the visible entry is `SessionEntry(id: "opencode:" + sid, agent: .opencode, sessionId: sid, title: title, cwd: directory, modified: Date(timeIntervalSince1970: updatedMs/1000), fileURL: nil, specifics: .opencode(providerModel: providerModel, agentName: agentName))` (`Sources/SessionIndexStore.swift:1735-1755`). The `providerModel`/`agentName` are extracted from the latest assistant JSON blob’s `providerID`, `modelID`, and `agent` keys (`Sources/SessionIndexStore.swift:1071-1087,1742-1755`).
- **Fallback:** I found no non-SQLite fallback for OpenCode history in source. Unlike Claude/Codex, there is no `*.jsonl` fallback path or alternate loader for OpenCode; `loadOpenCodeEntries` is the only history reader present (`Sources/SessionIndexStore.swift:1668-1758`).
- **Resume command:** `opencode --session <sessionId> -m <providerModel> --agent <agentName>` with the `-m` and `--agent` flags appended only when present (`Sources/SessionIndexModels.swift:360-368`).
- **Fork command:** `opencode --session <sessionId> --fork` (`Sources/RestorableAgentSession.swift:636-649`).
- **Version gate:** `AgentForkSupport.minimumOpenCodeForkVersion` is `SemanticVersion(major: 1, minor: 14, patch: 50)` (`Sources/AgentForkSupport.swift:49-53`). Fork support runs `openCodeVersionProbe`, which returns `(executable, ["--version"])` for normal OpenCode launches, captures stdout/stderr, parses the first semantic version in output via `SemanticVersion.first(in:)`, and requires `version >= 1.14.50` (`Sources/AgentForkSupport.swift:308-351`). The probe is skipped for `omo`, `omx`, and `omc` launchers (`Sources/AgentForkSupport.swift:308-313,376-388`).

### 8) Agent coverage map
- **Indexable / browsable history exists in source:**
  - `claude` → `loadClaudeEntries` over `~/.claude/projects/<encoded-cwd>/*.jsonl` (`Sources/SessionIndexStore.swift:1399-1554`)
  - `codex` → `loadCodexEntriesViaSQL` / `loadCodexEntriesFromDisk` over `~/.codex/state_5.sqlite` and `~/.codex/sessions/**/*.jsonl` (`Sources/SessionIndexStore+CodexSQL.swift:25-133`, `Sources/SessionIndexStore.swift:1562-1662`)
  - `opencode` → `loadOpenCodeEntries` over `~/.local/share/opencode/opencode.db` (`Sources/SessionIndexStore.swift:1668-1758`)
  - `grok` → `loadGrokEntries` over `~/.grok/sessions/**/chat_history.jsonl` or custom `GROK_HOME` roots (`Sources/SessionIndexRegisteredAgents.swift:250-367`)
  - `pi` → `loadRegisteredAgentEntries` using `PiSessionLocator` / `sessionDirectory` / `*.jsonl` (`Sources/SessionIndexRegisteredAgents.swift:552-728,369-463`)
  - `antigravity` → `loadAntigravityHistoryEntries` via `history.jsonl` under the registered root (`Sources/SessionIndexRegisteredAgents.swift:376-549,466-549`)
  - `rovodev` → `RovoDevIndex.loadRovoDevEntries` (`Sources/RovoDevIndex.swift:5-48`)
  - `hermes-agent` → `HermesAgentIndex.loadHermesAgentEntries` (`Sources/HermesAgentIndex.swift:5-62`)
  - `registered(...)` custom agents → generic `loadRegisteredAgentEntries` JSONL reader, including `sessionDirectory`-backed layouts (`Sources/SessionIndexRegisteredAgents.swift:369-463,552-728`)
- **Hook/process-only in source; no history reader found:**
  - `amp`, `cursor`, `gemini`, `copilot`, `codebuddy`, `factory`, `qoder` are defined as hook integrations in `CLI/CMUXCLI+AgentHookDefinitions.swift:168-296` and present in `RestorableAgentKind` (`Sources/RestorableAgentTypes.swift:8-18,21-38`), but there is no corresponding `load<Agent>Entries` reader in the repo search. These are the current "detect running / hook only" candidates if you want more vault coverage later.
- **Practical extension rule:** any new agent can join the vault only if cmux can supply a reader that maps on-disk history or transcript files to `SessionEntry`. Pure hook-only integrations are not enough to make the sessions browseable without inventing a new reader.
