# Discovery: nest-workflow-team-sessions

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| On-disk storage layout (Claude teams + workflows) | Done | direct inspection of live `~/.claude/projects/**` |
| Architecture Snapshot (reader + classifier + webview) | Done | direct read: `claudeReader.ts`, `detail.ts`, `types.ts`, `VaultPanel.ts`, `VaultService.ts` |
| Constraint Check | Done | direct read: existing specs, entryId protocol |

## Key Findings

### 1. Claude Code now has THREE child-session mechanisms; the reader handles ONE

| Kind | Storage | `isSidechain` | Link to parent | Reader today |
|---|---|---|---|---|
| Flat subagent (`Agent`/`Task`, unnamed) | `<projects>/<dir>/<parentId>/subagents/agent-*.jsonl` + `.meta.json` | `true` | dir nesting | ✅ `listClaudeSubagentStubs` |
| Workflow agent (`/workflow`) | `<parentId>/subagents/workflows/<wfId>/agent-*.jsonl` + `.meta.json`; manifest `<parentId>/workflows/<wfId>.json` | `true` | dir nesting (one level deeper) | ❌ never recursed into |
| Team member (named/addressable agent) | top-level sibling `<projects>/<dir>/<uuid>.jsonl` | **`false`** | in-file `teamName`+`agentName` | ❌ shows as its own top-level entry |

Evidence (live store): ghola session `2681b036` → `subagents/workflows/wf_1a0044b3-1c2/` has **30** `agent-*.jsonl`, `wf_bbebaf6f-378/` has 20; only **1** flat subagent. The redesign-vault-panel-ui review created leader `a62dbe32` + teammates `522a701a` (oracle) / `c71bc69c` (frontend), all sharing `teamName="redesign-vault-panel-ui-review"`.

### 2. The webview already supports arbitrary multi-tier nesting

`VaultPanel.renderSubagentSession` renders a collapsible block that lazily `requestVaultSessionDetail({entryId})` on expand; `renderNestedInto` renders the child's `timeline` through `renderTimelineItem`, which handles `subagentSession` **recursively**. So a "group" node is simply a `subagentSession` whose fetched detail's `timeline` is a list of `subagentSession`s. **No webview/render change is required** — this is a host-reader + entryId-protocol change.

### 3. Manifest is the workflow label source; per-agent `.meta.json` is bare

`workflows/<wfId>.json` carries `workflowName`, `agentCount`, `status`, `phases[]`, `workflowProgress[]` (`{index,title,type}`), `summary`, `startTime`, `totalTokens`. The agent `.meta.json` is only `{"agentType":"workflow-subagent"}`. The parent's `Workflow` tool-call input is just `{script}` — **no runId**, so a call cannot be correlated to its manifest by id; placement must use the manifest `startTime`.

### 4. Team linkage is durable only in the session files

`~/.claude/teams/<team>/config.json` (has `leadSessionId` + members) is **deleted on team teardown** (the review team's config is already gone). The durable signal is the in-file `teamName`/`agentName`. A teammate file's FIRST record carries both; a leader's first record carries neither (the team is created mid-session), and the leader records its `teamName` only on a small % of records scattered through the transcript.

### 5. entryId protocol + dispatch are extensible

`parseEntryId` splits on the FIRST colon, so `claude:<parentId>:<marker>:…` keeps the marker payload in `sessionId`. `readClaudeDetail` already self-dispatches on the `:subagent:` marker, and `isSafeSessionId` rejects any id containing `:` — so synthetic group ids are inherently **non-launchable** via `getEntry` with no extra guard. `VaultService.getDetail` passes `sessionId` straight through → all new resolution lives inside `readClaudeDetail`.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| `claudeReader` child discovery | flat `subagents/` only | + workflow runs + team members | recurse `subagents/workflows/`; scan sibling team files |
| entryId markers | `:subagent:` | `:workflow:` / `:wfagent:` / `:team:` | new markers + validators + parse |
| `readClaudeDetail` | subagent + main | + 3 synthetic-id branches | resolve group/leaf details |
| Top-level list | every `<dir>/*.jsonl` | exclude non-lead members | first-record `agentName` check |
| Webview | recursive nesting works | — | none |

## Options

### Option A — New `agentGroup` timeline kind + bespoke group render
A first-class group item with inline children. Rejected: duplicates the lazy-load/expand machinery `subagentSession` already has; touches the webview, schema, and tests for no behavioral gain.

### Option B — Group = `subagentSession` with a synthetic group entryId (Recommended)
A group is a `subagentSession` whose `getDetail` returns a timeline of child `subagentSession`s. Reuses the existing recursive render + lazy-load verbatim → **host-only change**. Lower risk, smaller surface.

## Risks

1. **Leader's `teamName` sits in the dropped middle of a huge transcript** — bounded head+tail read could miss it → teammates ungrouped. Mitigation: collect `teamName` via a side-channel during the streaming pass (before bounding), so every record contributes regardless of the head+tail window.
2. **Orphan member (leader file deleted)** — excluded from the top-level list AND ungroupable → unreachable. Rare; documented as accepted; a future "Teams" view is out of scope.
3. **Per-open cost** — workflow/team discovery on every Claude detail open. Mitigation: gate the sibling team scan on the parent having ≥1 `teamName`; workflow discovery is a single `readdir` that ENOENT-fast-fails when absent.
4. **Redundant plain subagent step** for named-agent spawns (the leader's `Agent` call still emits a transcript-less step alongside the Team group). Cosmetic; documented.
