---
topic: claude-cli-running-detection-and-subagent-linkage
created-by: VS Code extension feature `preview-subagent-popup` — needs to (1) detect a live Claude CLI session and (2) map a Task subagent invocation to its sub-transcript
date: 2026-06-01
libraries: [claude-code]
used-by: [preview-subagent-popup]
---

# Research: Claude Code CLI — live-session detection & subagent→sub-session linkage

**Source read directly** (NOT guessed): `/Users/huybuidac/Projects/ai-oss/claude-code` — a sourcemap-reconstructed dump of the real Claude Code CLI (see its `README.md`: "Claude Code's Entire Source Code Got Leaked via a Sourcemap in npm"). 1332 `.ts` + 552 `.tsx` files. Cross-referenced against `/Users/huybuidac/Projects/ai-oss/opencode` and `/Users/huybuidac/Projects/ai-oss/codex`.

All paths below are relative to the `claude-code/` tree unless noted. `~/.claude` = `$CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')`, NFC-normalized — `src/utils/envUtils.ts:7-15`.

---

## QUESTION 1 — Detecting a LIVE / running Claude CLI session

### 1a. PID registry files — the primary externally-observable "running" signal ✅

**`~/.claude/sessions/<pid>.json`** — written by every top-level REPL session.

Evidence: `src/utils/concurrentSessions.ts`

```ts
// line 21-23
function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')   // ~/.claude/sessions
}

// line 59-97  registerSession()
const pidFile = join(dir, `${process.pid}.json`)      // ~/.claude/sessions/<pid>.json
...
await mkdir(dir, { recursive: true, mode: 0o700 })
await writeFile(pidFile, jsonStringify({
  pid: process.pid,
  sessionId: getSessionId(),     // ← the JSONL transcript id
  cwd: getOriginalCwd(),
  startedAt: Date.now(),
  kind,                          // 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
  entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
  // gated extras (see reliability notes):
  messagingSocketPath: process.env.CLAUDE_CODE_MESSAGING_SOCKET,   // feature('UDS_INBOX')
  name, logPath, agent,                                            // feature('BG_SESSIONS')
}))
```

- **Registered for**: interactive CLI, SDK (vscode/desktop/ts/py), `-p`, `claude --bg`, daemon spawns. **Skipped** only for teammates/subagents (`if (getAgentId() != null) return false` — line 60). Comment lines 49-57.
- **Cleanup**: `registerCleanup(async () => unlink(pidFile))` (line 66-72) — removed on graceful exit. **Crashes leave a stale file.**
- **Called from**: `src/main.tsx:2530` (`void registerSession().then(...)`) — only on the REPL path, not subcommands like `claude doctor` (comment lines 2526-2528).
- **`sessionId` is kept fresh on `--resume`/`/resume`**: `onSessionSwitch(id => updatePidFile({ sessionId: id }))` (line 101-103).

**Liveness probe** (how Claude itself decides a PID file is live vs. stale) — `src/utils/genericProcessUtils.ts:20-28`:

```ts
export function isProcessRunning(pid: number): boolean {
  if (pid <= 1) return false
  try { process.kill(pid, 0); return true }   // signal-0 probe
  catch { return false }
}
```

`countConcurrentSessions()` (`concurrentSessions.ts:168-204`) reads the dir, matches **only** `/^\d+\.json$/` (strict guard — see anthropics/claude-code#34210, line 184-186), probes each PID, and **sweeps stale files** via `unlink` (except on WSL, line 194-200).

> **External-detection recipe**: read `~/.claude/sessions/*.json`, parse, and call your own equivalent of `process.kill(pid, 0)` (Node: `process.kill(pid, 0)` in a try/catch). A file whose PID is alive AND whose `cwd`/`sessionId` matches the transcript you're previewing = a live session for that transcript. Note `process.kill(pid,0)` throws `EPERM` (reported as "not running") if the process is owned by another user — conservative (comment lines 15-19).

### 1b. Live activity status on the PID file (gated) ⚠️

`updateSessionActivity({ status, waitingFor, updatedAt })` patches the same `<pid>.json` — `concurrentSessions.ts:155-161`:

```ts
export async function updateSessionActivity(patch: { status?: 'busy'|'idle'|'waiting'; waitingFor?: string }) {
  if (!feature('BG_SESSIONS')) return            // ← GATED
  await updatePidFile({ ...patch, updatedAt: Date.now() })
}
```

Pushed from the REPL render loop — `src/screens/REPL.tsx:1160-1167`:

```ts
useEffect(() => {
  if (feature('BG_SESSIONS')) {
    void updateSessionActivity({ status: sessionStatus, waitingFor })  // 'busy'|'idle'|'waiting'
  }
}, [sessionStatus, waitingFor])
```

So `status`/`updatedAt`/`waitingFor` give a real-time busy/idle heartbeat — **but only in builds where `feature('BG_SESSIONS')` is enabled.** `feature(...)` comes from `import { feature } from 'bun:bundle'` (`concurrentSessions.ts:1`), i.e. a **build-time bundle flag** that DCE-strips gated code from external builds. I could **not** confirm from source whether the public npm build ships with `BG_SESSIONS`/`UDS_INBOX` on. Treat `status`/`updatedAt` as **best-effort, may be absent**. The base fields (`pid`, `sessionId`, `cwd`, `startedAt`, `kind`) are **ungated** and always written.

### 1c. The JSONL transcript is appended LIVE → mtime/tail is a valid freshness signal ✅

The transcript writer appends each entry through a per-file queue with a 100 ms flush — `src/utils/sessionStorage.ts`:

```ts
private FLUSH_INTERVAL_MS = 100                                    // line 567
private async appendToFile(filePath, data) {                      // line 634-643
  try { await fsAppendFile(filePath, data, { mode: 0o600 }) }     // append-only
  catch { await mkdir(dirname(filePath), {recursive:true, mode:0o700}); await fsAppendFile(...) }
}
// drainWriteQueue (645-678): jsonStringify(entry) + '\n' per record, append-only
```

`import { appendFile as fsAppendFile } from 'fs/promises'` (line 9). Append-only discipline is explicitly relied upon (`sessionStorage.ts:3257`: "parents appear at earlier file offsets than children"). **So: the live session's `<sessionId>.jsonl` grows during the session; its mtime advances on every assistant/user/tool message** (~100 ms latency). `claude ps` itself falls back to "transcript-tail derivation" when the PID-file status is missing/stale (REPL.tsx:1158-1159 comment; concurrentSessions.ts:154-157 comment).

> Caveat: mtime alone cannot distinguish "running but idle/waiting for user" from "exited". Combine mtime with the PID-liveness probe (1a) for a reliable verdict.

### 1d. IPC / sockets (gated, secondary)

- **Unix domain socket inbox**: `process.env.CLAUDE_CODE_MESSAGING_SOCKET` is recorded on the PID file as `messagingSocketPath` under `feature('UDS_INBOX')` (`concurrentSessions.ts:86-88`). Set up in `src/main.tsx:1910-1945`. This is a teammate-messaging channel, not a general "running" flag, and is gated.
- **Remote Control bridge**: `src/bridge/*` + `updateSessionBridgeId()` (`concurrentSessions.ts:144-148`) — cloud session id, not a local on-disk marker.
- **`src/utils/sessionActivity.ts`** (despite the name) is an **in-memory** refcount/heartbeat timer to keep a *remote container* alive (`CLAUDE_CODE_REMOTE_SEND_KEEPALIVES`); it writes nothing to disk and is **not** externally observable. Ignore it for this feature.
- No general `.lock`/`flock`/`mkfifo` guarding a session was found. Locks that DO exist are scoped: `src/utils/cronTasksLock.ts`, `src/utils/nativeInstaller/pidLock.ts`, `src/utils/computerUse/computerUseLock.ts`, `src/services/autoDream/consolidationLock.ts` — none signal "a session is running."

### 1e. Q1 verdict

**Most reliable external "is a Claude session live for transcript X" check, in order:**
1. Find `~/.claude/sessions/<pid>.json` whose `sessionId` (or `cwd`) matches → confirms a registered session and gives you the PID. **(ungated, reliable)**
2. Probe `process.kill(pid, 0)` → alive vs. crashed. **(reliable)**
3. Optionally use `<sessionId>.jsonl` mtime/tail for "actively producing output right now." **(reliable as freshness, not as idle-detection)**
4. If present, `status`/`updatedAt` on the PID file gives busy/idle/waiting. **(gated by BG_SESSIONS — may be absent)**

Stale-file risk: a crash leaves the PID file; mitigate with the signal-0 probe exactly as Claude does.

---

## QUESTION 2 — Subagent (Task) → sub-session linkage in the transcript schema

### 2a. Storage model: subagent records go to a SEPARATE child file (NOT inline sidechain in the main JSONL) ✅

Path helpers — `src/utils/sessionStorage.ts`:

```ts
// Main session transcript (line 198-205)
getProjectsDir()      = join(getClaudeConfigHomeDir(), 'projects')
getTranscriptPath()   = join(projectDir, `${getSessionId()}.jsonl`)
//   → ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl

// Subagent transcript (line 247-258)
getAgentTranscriptPath(agentId) =
  join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`)
//   → ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl

// Sidecar metadata (line 260-262)
getAgentMetadataPath(agentId) = <same>/agent-<agentId>.meta.json
//   AgentMetadata = { agentType, worktreePath?, description? }  (line 264-272)
```

The **routing decision** that proves subagent records are split out — `sessionStorage.ts:1224-1228` (inside `appendEntry`):

```ts
const isAgentSidechain = entry.isSidechain && entry.agentId !== undefined
const targetFile = isAgentSidechain
  ? getAgentTranscriptPath(asAgentId(entry.agentId!))   // subagents/agent-<id>.jsonl
  : sessionFile                                          // <sessionId>.jsonl
```

> So a record is written to the **separate child file** iff it has **both** `isSidechain === true` **and** a defined `agentId`. Records are appended there via the same `fsAppendFile` queue. The dir is created lazily on first write.

Subagent records are emitted by `recordSidechainTranscript(messages, agentId)` (`sessionStorage.ts:1451-1462`), which calls `insertMessageChain(messages, /*isSidechain*/ true, agentId)`. Call sites: `src/tools/AgentTool/runAgent.ts:735` & `:794`, `src/utils/forkedAgent.ts:531,588`.

### 2b. Exact record shapes

**Common stamped fields on every transcript record** — `insertMessageChain`, `sessionStorage.ts:1039-1064`:

```ts
const transcriptMessage: TranscriptMessage = {
  parentUuid,          // UUID | null — intra-file chain pointer
  logicalParentUuid,   // set only across compact boundaries
  isSidechain,         // boolean
  teamName, agentName, // swarm only
  promptId,            // user msgs only
  agentId,             // ← present (and isSidechain=true) for subagent records
  ...message,          // type:'user'|'assistant'|..., uuid, message{...}
  userType, entrypoint,
  cwd,
  sessionId,           // ← getSessionId() = the PARENT session id (NOT a new child id)
  version, gitBranch, slug,
}
```

Type defs — `src/types/logs.ts:8-17` (`SerializedMessage`: `cwd,userType,entrypoint?,sessionId,timestamp,version,gitBranch?,slug?`) and `:221-231` (`TranscriptMessage` adds `parentUuid, logicalParentUuid?, isSidechain, gitBranch?, agentId?, teamName?, agentName?, agentColor?, promptId?`). The persisted top-level shape always starts `{"parentUuid":...` (relied on at `sessionStorage.ts:3244-3247, 3310`).

**(a) Parent assistant message containing the Task `tool_use`** — an ordinary `assistant` record in `<sessionId>.jsonl`. `isSidechain:false`, `agentId` undefined. Its `message.content[]` holds a `tool_use` block: `{ type:'tool_use', id:'<toolUseId>', name:'Task' /*or the agent name*/, input:{...} }`. The `id` here is **the Task tool_use id** — the join anchor.

**(b) The subagent's own records** — `user`/`assistant` records in `subagents/agent-<agentId>.jsonl`. Each has `isSidechain:true`, `agentId:'<agentId>'`, **and `sessionId` = the parent's session id** (because it's stamped from `getSessionId()`, 2a above). They form their own `parentUuid` chain *within that file*.

**(c) The `tool_result` returned to the parent** — a `user` record in the **main** `<sessionId>.jsonl` (`isSidechain:false`). `message.content[]` holds `{ type:'tool_result', tool_use_id:'<toolUseId>', content:[...] }` where `tool_use_id` === the Task tool_use `id` from (a). Built at `src/tools/AgentTool/AgentTool.tsx:1298-1371` (`mapToolResultToToolResultBlockParam(data, toolUseID)`), and the result text carries a trailing `<usage>` block + `agentId: <id>` hint (lines 1364-1371).

### 2c. The deterministic join: Task `tool_use.id` → `agentId` → child file ✅

There is **no `parentToolUseID` field persisted on the user/assistant transcript records** (confirmed: `grep` finds `parentToolUseID`/`parentToolUseId` only in runtime/streaming code — `src/utils/messages.ts`, `queryHelpers.ts`, `toolExecution.ts` — never in `src/types/logs.ts`). The bridge on disk is the **`agent_progress` progress record**.

`progress` records are normally ephemeral and NOT persisted (`sessionStorage.ts:139-156`), **but `agent_progress` (and `skill_progress`/`hook_progress`) are explicitly NON-ephemeral and ARE written to the main JSONL** — `src/screens/REPL.tsx:2608-2627` (only `isEphemeralToolProgress` types — `bash_progress`/`mcp_progress`/… per `sessionStorage.ts:186-193` — are replaced-in-place/skipped). The loader even has special parsing for them: "agent_progress entries carry a nested Message in data.message" (`sessionStorage.ts:3251, 3343-3346`).

The `agent_progress` record's fields (set when the parent forwards subagent activity):
- `parentToolUseID` = **the Task tool_use `id`** — `src/services/tools/toolExecution.ts:549-554`:
  ```ts
  createProgressMessage({ toolUseID: progress.toolUseID, parentToolUseID: toolUseID, data: progress.data })
  //                                                       ^^^^^^^^^^^^^^^^^^^^^^^^^ = the Task tool_use id
  ```
- `data.type === 'agent_progress'`, `data.agentId === '<agentId>'`, `data.message` = the subagent's message — emitted at `src/tools/AgentTool/AgentTool.tsx:796-804` and `:1112-1122`:
  ```ts
  onProgress({ toolUseID: `agent_${assistantMessage.message.id}`,
    data: { message: m, type: 'agent_progress', prompt, agentId: syncAgentId } })
  ```

`extractAgentIdsFromMessages(messages)` (`sessionStorage.ts:4244-4263`) is exactly this reverse lookup: it scans persisted `progress` records for `data.type==='agent_progress' && data.agentId`.

**On-disk join chain (deterministic):**

```
parent assistant record (main jsonl)
   └─ message.content[].tool_use { id: T, name:'Task' }
        │
        │  same value T
        ▼
agent_progress record (main jsonl)
   ├─ parentToolUseID === T
   └─ data.agentId === A
        │
        │  A
        ▼
~/.claude/projects/<cwd>/<sessionId>/subagents/agent-A.jsonl
   └─ every record: { isSidechain:true, agentId:A, sessionId:<parent sessionId>, ... }
```

**Two equivalent strategies for the popup:**
1. **From a specific Task tool_use** (what the feature wants): take the `tool_use.id` `T` from the clicked parent block → find the `agent_progress` record(s) with `parentToolUseID === T` → read `data.agentId` `A` → open `subagents/agent-A.jsonl`.
2. **Enumerate all subagents** without parsing progress: glob the `subagents/` dir directly — `loadAllSubagentTranscriptsFromDisk()` (`sessionStorage.ts:4324-4346`) lists `agent-*.jsonl`, slices the `agent-`/`.jsonl` affixes to recover each `agentId`, and loads via `getAgentTranscript(agentId)` (`:4190-4236`, which filters `msg.agentId===agentId && msg.isSidechain` and rebuilds the chain). Pair each with its `agent-<id>.meta.json` for `agentType`/`description`.

> Edge case — **async/backgrounded agents**: launched async, the `agentId` is also surfaced in the parent tool_result text as `agentId: <id>` (AgentTool.tsx:1328, 1368) and persisted via `remote-agents/remote-agent-<taskId>.meta.json` (`sessionStorage.ts:320-329`) for resume.
> Edge case — **legacy transcripts** (pre-PR #24099): older files inlined `progress` entries into the chain with their own `uuid`/`parentUuid`; `loadTranscriptFile` "bridges the chain across them" (`sessionStorage.ts:158-178`). Modern subagent records live in the separate file.

### 2d. "Done (N tool uses · X tokens · Ym Zs)" summary derivation ✅

The literal string — `src/tools/AgentTool/UI.tsx:376-377`:

```ts
const result = [
  totalToolUseCount === 1 ? '1 tool use' : `${totalToolUseCount} tool uses`,
  formatNumber(totalTokens) + ' tokens',
  formatDuration(totalDurationMs),
];
const completionMessage = `Done (${result.join(' · ')})`;   // "Done (3 tool uses · 12,345 tokens · 1m 2s)"
```

(`formatDuration`, `formatNumber` from `src/utils/format.js`.)

The three numbers come from the agent's final result object — `src/tools/AgentTool/agentToolUtils.ts:319-356` (`finalizeAgentTool`):

```ts
const totalTokens       = getTokenCountFromUsage(lastAssistantMessage.message.usage)  // line 319
const totalToolUseCount = countToolUses(agentMessages)                                 // line 320
return { agentId, agentType, content,
  totalDurationMs: Date.now() - startTime,   // wall-clock since agent start (line 352)
  totalTokens, totalToolUseCount, usage }
```

- **tokens** = `getTokenCountFromUsage(usage)` of the **last** assistant message: `input_tokens + (cache_creation_input_tokens ?? 0) + (cache_read_input_tokens ?? 0) + output_tokens` — `src/utils/tokens.ts:46-58`. (i.e. the **final context-window size**, not a sum across turns.)
- **tool uses** = `countToolUses(agentMessages)` — counts every `tool_use` content block across all assistant messages — `agentToolUtils.ts:262-274`.
- **duration** = `Date.now() - startTime` (agent spawn → completion wall-clock).

The same trio is also embedded in the tool_result `<usage>` trailer the parent LLM sees — `AgentTool.tsx:1369-1371`: `total_tokens / tool_uses / duration_ms`.

> **To reproduce in the popup from the child JSONL alone**: load `subagents/agent-<id>.jsonl`, take the last `assistant` record's `message.usage` for tokens, count `tool_use` blocks across its `assistant` records for tool-use count. Duration is NOT a single field on disk — derive it from `last.timestamp − first.timestamp` of the child records (the original `startTime` is in-memory only).

---

## Confidence & gaps

**Confidence: High.** Every claim above is backed by exact file paths + line numbers in the directly-read Claude Code source. The two storage paths (`sessions/<pid>.json`, `projects/<cwd>/<sessionId>/subagents/agent-<id>.jsonl`), the `isSidechain`+`agentId` routing rule, the `agent_progress.parentToolUseID → data.agentId` bridge, and the "Done(...)" derivation were each read in full, not inferred.

**Gaps / caveats:**
1. **Build-flag uncertainty.** `feature('BG_SESSIONS')` / `feature('UDS_INBOX')` are `bun:bundle` compile-time flags. I could not determine from source whether the public npm build enables them — so treat the PID-file **`status`/`updatedAt`** fields and **`messagingSocketPath`** as possibly-absent. The **base** PID file (`pid, sessionId, cwd, startedAt, kind`) and the separate-file subagent storage are **ungated**. **Recommend verifying empirically** against a real `~/.claude/sessions/` and a real `subagents/` dir on the target machine before relying on the gated fields.
2. **Exact `name` of the Task tool block** (`name:'Task'` vs. a renamed/legacy `LEGACY_AGENT_TOOL_NAME`) — the rename Task→Agent is referenced (`agentToolUtils.ts:435-436`) but I did not pin the exact persisted `name` string. The join uses `tool_use.id`, not `name`, so this does not affect linkage; verify the `name` empirically if you filter on it.
3. **`encoded-cwd` directory encoding** — `getProjectDir(cwd)` (the cwd→dirname slugging used for `projects/<encoded-cwd>/`) was referenced but its exact transform was not opened in this pass; verify against a real directory listing (commonly cwd with `/` and other chars replaced by `-`).
4. **Cross-CLI note (not applicable to a Claude transcript reader):** opencode stores sessions in **SQLite** (`opencode/packages/opencode/src/session/index.ts`, `storage/db`) and has a generic `util/flock.ts` lockdir-with-heartbeat — different model. codex (Rust) uses **rollout** files (`codex/codex-rs/rollout-trace/`, `core/src/session`). Neither shares Claude Code's `~/.claude/projects/*.jsonl` schema, so their mechanisms don't transfer to this feature.

---

## Terminal render format + terminal→session mapping

_Appended 2026-06-01. Same directly-read source tree. Resolves prior gap #2 (the persisted Task `name`). All paths relative to `claude-code/`._

### Q1 — exact terminal render of a subagent (Task) invocation

**TL;DR header (ANSI-stripped):** `<glyph> <UserFacingName>(<description>)` then on the next line(s) a child summary. A Task call renders through the **same generic tool-use renderer** as Read/Bash/Edit (`AssistantToolUseMessage`) — there is **no special glyph or badge**. The discriminator is the **name word** (an agent type, never a built-in tool name) plus the trailing **`Done (… tool uses …)`** summary.

#### The glyph — it IS `⏺` (on macOS) / `●` (else)

`src/constants/figures.ts:4`:

```ts
export const BLACK_CIRCLE = env.platform === 'darwin' ? '⏺' : '●'
```

This single glyph is used for **every** tool-use header (Read, Bash, Edit, Task…) — emitted by `ToolUseLoader` (`src/components/ToolUseLoader.tsx:20`) and, for queued calls, directly as `BLACK_CIRCLE` in `AssistantToolUseMessage.tsx:186`. While the tool is still running the loader **blinks the same dot** (alternates `BLACK_CIRCLE` ↔ `' '` via `useBlink`) — there is **no spinner character and no `Running…` word on the header line**. So your regex must NOT rely on the glyph to distinguish a subagent; it only marks "this is a tool-use header line".

> Regex caveat: on Linux/Windows the glyph is `●` (U+25CF), on macOS `⏺` (U+23FA). Match `[⏺●]` (or strip the leading glyph+space generically). A blinking in-progress header may momentarily render the glyph cell as a space.

#### Header composition — `AssistantToolUseMessage.tsx`

The header row is assembled at `src/components/messages/AssistantToolUseMessage.tsx:228`:

```tsx
<Box flexDirection="row" flexWrap="nowrap" minWidth={…}>{t7}{t9}{t10}{t11}</Box>
//   t7 = glyph/loader  t9 = userFacingToolName (bold)  t10 = "(description)"  t11 = optional model tag
```

- `t9` — the **name word**, `userFacingToolName = tool.userFacingName(input)` (`:77`, rendered `:200`) — bold, **`wrap="truncate-end"`** (the *name* truncates, not the description).
- `t10` — the parenthetical (`:210`): `renderedToolUseMessage !== "" && <Box flexWrap="nowrap"><Text>({renderedToolUseMessage})</Text></Box>`. **The `(` and `)` are literal**, wrapping whatever `renderToolUseMessage` returns.

For the Agent/Task tool, `renderToolUseMessage` returns the **description verbatim** — `src/tools/AgentTool/UI.tsx:411-421`:

```ts
export function renderToolUseMessage({ description, prompt }) {
  if (!description || !prompt) return null;
  return description;          // ← printed verbatim inside ( … )
}
```

So a single Task header prints exactly: **`⏺ Explore(Find the auth middleware)`** — i.e. `<glyph> <agentType>(<description>)`.

#### Is `<AgentName>` the `subagent_type` or literally `Task`? → it's the **subagent_type** (with two fallbacks)

`userFacingName` — `src/tools/AgentTool/UI.tsx:760-775`:

```ts
export function userFacingName(input) {
  if (input?.subagent_type && input.subagent_type !== GENERAL_PURPOSE_AGENT.agentType) {
    if (input.subagent_type === 'worker') return 'Agent';   // teammates shown as "Agent"
    return input.subagent_type;                              // ← e.g. "Explore", "Plan", "verification", custom
  }
  return 'Agent';                                            // general-purpose OR missing → "Agent"
}
```

Built-in `agentType` values (the literal strings you'll see): `Explore` (`built-in/exploreAgent.ts:65`), `Plan` (`planAgent.ts:74`), `verification` (`verificationAgent.ts:135`), `statusline-setup`, `general-purpose` (`generalPurposeAgent.ts:26`). **Rule:** header word = `subagent_type` literally, **except** `general-purpose` and `worker` both print **`Agent`**. It is **never** the word `Task` in the header.

> **Persisted wire `name` (resolves prior gap #2):** the tool is registered `name: 'Agent'` with `aliases: ['Task']` — `src/tools/AgentTool/constants.ts:1-2` (`AGENT_TOOL_NAME='Agent'`, `LEGACY_AGENT_TOOL_NAME='Task'`), wired at `AgentTool.tsx:226,228`. So the on-disk `tool_use.name` is **`Agent`** for modern sessions and **`Task`** for legacy/resumed ones. This is distinct from the **header word** (`userFacingName`), which is the agentType. Linkage still uses `tool_use.id`, so `name` only matters if you filter the JSONL.

#### Summary line — completed variant (verbatim template)

`src/tools/AgentTool/UI.tsx:376-377`:

```ts
const result = [
  totalToolUseCount === 1 ? '1 tool use' : `${totalToolUseCount} tool uses`,
  formatNumber(totalTokens) + ' tokens',
  formatDuration(totalDurationMs),
];
const completionMessage = `Done (${result.join(' · ')})`;
// → "Done (3 tool uses · 12,345 tokens · 1m 2s)"
```

Separator is ` · ` (U+00B7 with surrounding spaces). `formatNumber` inserts thousands separators (commas). This `completionMessage` is then rendered as an assistant message line (`:402-404`) and so prints under its own `⏺` glyph as a standalone line: **`⏺ Done (3 tool uses · 12,345 tokens · 1m 2s)`**.

#### Summary line — in-progress / running variants

There is **no elapsed timer and no `Running…` word on a single agent's header**. Instead the live state shows as **child progress lines** under the header, via `renderToolUseProgressMessage` (`src/tools/AgentTool/UI.tsx:445-569`):

1. **Before any progress:** `Initializing…` — `INITIALIZING_TEXT` (`:444`, rendered `:462-464, 535-537`).
2. **Condensed mode** (terminal too short): one line — `:495-502`:
   ```
   In progress… · <N> tool uses · <X> tokens · (ctrl+o to expand)
   ```
3. **Normal mode:** the last up-to-3 child tool-use headers are shown (`MAX_PROGRESS_MESSAGES_TO_SHOW=3`, `:33,510`), plus `+N more tool uses` (`:564-567`).

**Multi-agent batch / per-agent tree view** (`src/tools/AgentTool/UI.tsx:738-758` + `src/components/AgentProgressLine.tsx`) — when multiple agents run, or for the per-agent rollup line, the header reads:

```
Running <N> [<Type>] agents…          ← in progress (UI.tsx:751-752)
<N> [<Type>] agents finished          ← all complete (UI.tsx:748-749)
<N> background agents launched (↓ to manage)   ← async (UI.tsx:742-746)
```

and each agent gets a tree-prefixed line — `AgentProgressLine.tsx`:

```
├─ <agentType>(<description>) · <N> tool uses · <X> tokens   (treeChar "├─"/"└─", :treeChar)
   ⏿  <lastToolInfo | "Initializing…">                       ← status sub-line while unresolved (:t10)
```

The per-agent status text (`AgentProgressLine.tsx`, `getStatusText`): unresolved → `lastToolInfo || "Initializing…"`; backgrounded → `taskDescription ?? "Running in the background"`; else → `"Done"`. **Note `AgentProgressLine` prints the description without truncation too** (`:t6`: `<Text>(…){description}(…)</Text>`, no `wrap`).

#### CRITICAL: is `(description)` == `input.description` == on-disk `meta.json.description`? → **YES, verbatim**, modulo flexbox width

- The header parenthetical is `input.description` printed verbatim (`UI.tsx:411-421`, above) — **no truncation/ellipsis applied by the description component itself.** The `wrap="truncate-end"` on `:200` applies to the **name** word only; the description Box (`:210`) is `flexWrap="nowrap"` with **no** `wrap`/`truncate` prop.
- The on-disk `agent-<id>.meta.json` `description` is **the same `input.description`, written verbatim** — `writeAgentMetadata(agentId, { agentType, …, description })` at `runAgent.ts:738-742` and `AgentTool.tsx:673-676`; the field is documented as "Original task description from the AgentTool input" (`sessionStorage.ts:268-271`). Schema: `description: z.string().describe('A short (3-5 word) description of the task')` (`AgentTool.tsx:83`).

  **⇒ A clicked terminal `(description)` string can be matched 1:1 (exact string equality) against `meta.json.description`** — provided the line wasn't visually clipped by terminal width. The component does not ellipsize the description, but Ink/flexbox **can drop characters off the right edge** if `name(description) · tag` exceeds the terminal columns (the row is `flexWrap="nowrap"`). The description is short by contract (3-5 words), so clipping is unlikely but possible for verbose descriptions on narrow terminals. **Mitigation:** prefer a *prefix/`startsWith`* or longest-common-prefix match against `meta.json.description` rather than strict equality, to survive right-edge clipping; and de-dup if two agents share a description (tie-break by transcript order / `agent-*.jsonl` mtime).

#### Discriminator — how to tell a SUBAGENT header from a normal tool call

Normal tools render the **identical** `⏺ <Name>(<args>)` shape. Distinguish by the **name word** and/or the **`Done (…)` summary**:

1. **Name word is an agent type, never a built-in tool name.** Built-in `userFacingName`s are fixed strings: Read→`Read` / `Reading Plan` / `Read agent output` (`FileReadTool/UI.tsx:165-173`); Bash→`Bash` (`BashTool.tsx:484`); Edit→`Update` / `Create` / `Updated plan` (`FileEditTool/UI.tsx:24-45`). A subagent's word is `Explore`/`Plan`/`verification`/`Agent`/`<custom agentType>`. **Build an allow-list of built-in tool names and treat any other capitalized header word as a candidate agent.** (Caveat: `general-purpose` and `worker` both surface as `Agent` — match `Agent` too.)
2. **Only agents emit the `Done (N tool uses · X tokens · Ym Zs)` follow-up line** (`UI.tsx:377`). Built-in tools print result lines like `Read N lines`, `Update`d-file diffs, etc. — **never** a `Done (… tool uses …)` line. The `· N tool uses · … tokens` token-accounting trailer is unique to Agent/Task. This is the most reliable discriminator if the header word alone is ambiguous.
3. There is **no distinct glyph, indent, or agent badge** on the header itself — do not rely on those.

### Q2 — terminal → running sessionId mapping

#### Is the PID-file `pid` the node REPL pid, and is it a descendant of the pty's shell? → **YES to both**

`registerSession()` writes `pid: process.pid` (`concurrentSessions.ts:35` per prior section) — that's the **node process running the Claude REPL** (`src/main.tsx:2530`). In a VS Code terminal, the pty's **direct child is the shell** (zsh/bash); `claude` is launched by the user inside that shell, so the node pid is a **descendant** of the pty's direct child, **not** the direct child itself. ⇒ You cannot use the pty's immediate child pid directly; you must walk the process tree (children-of-children) or match by `cwd`/`sessionId` from the registry. (No source line "proves" the shell layering — that's an OS/pty fact — but the registry pid being `process.pid` of the node REPL is confirmed in source.)

#### Does the running process expose its sessionId via ENV or argv to an external observer? → **NO env var; YES via argv (only if explicitly passed)**

**Env vars — sessionId is NOT exported.** `getSessionId()` reads **in-memory** bootstrap state, not the environment — `src/bootstrap/state.ts:431-433`:

```ts
export function getSessionId(): SessionId { return STATE.sessionId }
```

- There is **no `process.env.CLAUDE_SESSION_ID = …` assignment anywhere** in the source (exhaustive grep: zero matches for any assignment to `CLAUDE_SESSION_ID`/`*SESSION_ID` of the active session).
- `${CLAUDE_SESSION_ID}` exists **only as a literal template token** substituted inside skill/plugin markdown via `.replace(/\$\{CLAUDE_SESSION_ID\}/g, getSessionId())` — `SkillTool.ts:1079`, `loadPluginCommands.ts:374`. It is **not** an exported process env var.
- **Hooks do NOT get sessionId via env either.** Hook subprocesses are spawned with `env: envVars` where `envVars = { ...subprocessEnv(), CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_ROOT?, CLAUDE_PLUGIN_DATA?, CLAUDE_PLUGIN_OPTION_*? }` — `hooks.ts:882-909`. **No `CLAUDE_SESSION_ID`.** The hook receives `session_id` only in its **stdin JSON payload** (the standard hook contract), which is ephemeral and not observable via `/proc`.
- Session-related env vars that DO exist are **remote/cloud-only and not the local interactive id:** `CLAUDE_CODE_REMOTE_SESSION_ID` (`upstreamproxy.ts:96`, `attribution.ts:58`), `CLAUDE_CODE_SESSION_ACCESS_TOKEN` (bridge auth). Ignore these for local terminal mapping.

  **⇒ Reading `/proc/<pid>/environ` (or `ps -E`) will NOT yield the local interactive sessionId.** Don't build on that.

**Argv / CLI flags — observable only if the user passed them.** Parsed in `src/main.tsx:988-1000`:

- `--session-id <uuid>` — explicit session id (validated UUID; only with `--continue`/`--resume` if also `--fork-session`, `main.tsx:1279-1282`).
- `-r, --resume [value]` — resume by session id (or interactive picker).
- `-c, --continue` — continue most recent in cwd (no id on argv).
- `-n, --name <name>` — display name (also used as terminal title).
- `--from-pr [value]`, `--fork-session`, `--parent-session-id <id>` (`main.tsx:3856`, hidden), `--resume-session-at <message id>`.

`--session-id`/`--resume <uuid>` are readable from the process command line (`ps`, `/proc/<pid>/cmdline`, macOS `ps -o command`). **But a normal interactive `claude` invocation passes none of these** (the session id is generated at runtime), so argv is unreliable as the primary signal. Treat argv as a *bonus* confirmation when present.

**Terminal title (weak side-channel):** the REPL writes an OSC title = the session title/name — `REPL.tsx:1127-1135` (`getCurrentSessionTitle(getSessionId())` → `AnimatedTerminalTitle`, ink emits the OSC). Observable as the pty title, but it's the human title (or `Claude Code`), **not** the sessionId, and only set when `terminalTitleFromRename !== false`. Not a reliable id source.

#### ⇒ Recommended terminal→session mapping (no env, no reliable argv)

The **PID registry** (Q1 of the prior section) remains the join. To map a specific terminal/pty to its sessionId:

1. Get the pty's process subtree and find the **node `claude` descendant pid** (walk children; the registry `pid` is that node pid, a descendant of the shell).
2. Look up `~/.claude/sessions/<pid>.json` for that pid → gives `sessionId` + `cwd` directly. **(best: exact pid match, no ambiguity.)**
3. Fallback if you can't resolve the pid from the pty: filter the registry by `cwd === terminal.cwd` and PID-liveness (`process.kill(pid,0)`).

#### Tie-break when multiple live sessions share a cwd

If filtering by `cwd` yields several live PID files, the registry's own fields give the order: **prefer the most recently active session.** Best signal = **`<sessionId>.jsonl` transcript mtime** (advances ~100 ms after every message — see prior §1c), which reflects *current activity*, over `startedAt` (which only reflects launch time and would mis-rank a long-idle-but-older session above a freshly-busy newer one). Concretely: among cwd-matching live PIDs, pick the one whose `projects/<encoded-cwd>/<sessionId>.jsonl` has the newest mtime; use `startedAt` only as a secondary tie-break when mtimes are equal/missing. Caveat (prior doc): mtime advances on output, not on idle-waiting — so a session waiting for user input may have a slightly stale mtime; if you need "the one the user is typing in", there is no on-disk signal distinguishing concurrent same-cwd idle sessions, so fall back to the exact-pid path (steps 1-2).

### Q1/Q2 confidence & residual gaps

**Confidence: High.** Header composition (`AssistantToolUseMessage.tsx:200,210,228`), glyph (`figures.ts:4`), name resolution (`UI.tsx:760-775`), the `Done(…)` template (`UI.tsx:376-377`), verbatim description→meta.json (`runAgent.ts:738-742`, `sessionStorage.ts:268-271`), the no-env-var finding (`state.ts:431-433`, `hooks.ts:882-909`, exhaustive grep), and the argv flags (`main.tsx:988-1000`) were each read directly.

Residual gaps:
1. **Right-edge width clipping of `(description)`** is an Ink/flexbox runtime behavior (row is `flexWrap="nowrap"`), not something the component spells out — verify empirically on a narrow terminal before relying on strict string equality; prefer prefix matching (above).
2. **`"external" === 'ant'` dead-code branches.** Several UI paths (e.g. the search/read grouping in `processProgressMessages`, ANT-ONLY lines) are gated to internal builds and DCE-stripped externally. The header/`Done(…)`/`Running N agents…` paths analyzed here are **ungated** and ship in the public build, but verify the exact in-progress child-line rendering against a real running terminal.
3. **Shell→node layering** is asserted from OS/pty semantics, not a source line. Confirm by walking a real pty's process tree on the target platform (the node pid in the registry is confirmed = `process.pid` of the REPL).
4. **`encoded-cwd` transform** (carried over from prior gap #3) still needs an empirical directory listing to pin the cwd→dirname slug used in `projects/<encoded-cwd>/`.
