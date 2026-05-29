---
topic: agent-session-transcript-schemas
created-by: research for the anywhere-terminal session detail reader design
date: 2026-05-29
libraries: [Claude Code, Codex, OpenCode, cmux]
used-by: []
---

# Research: agent-session-transcript-schemas

## Answers

- First user prompt extraction depends on the agent store:
  - **Claude Code**: stream the JSONL transcript and take the first `type: "user"` record with text content. The current reader already uses this pattern for the session title, but it stops once title and assistant model are found, so it is not yet a transcript-detail reader. `src/vault/readers/claudeReader.ts:62-138,155-205`
  - **Codex**: the primary SQLite index already stores `first_user_message` in `threads`, so the cheap path is the index query. The current reader reads that column directly and only falls back to JSONL sessions when SQLite is unavailable. `src/vault/readers/codexReader.ts:23-29,129-188,169-203`
  - **OpenCode**: first-user-prompt data is not exposed by the current metadata-only reader. The source schema is normalized across `session`, `message`, and `part`, and the prompt-generation logic explicitly identifies the first non-synthetic user message, with a subtask-only special case. `packages/opencode/src/session/session.sql.ts:1-76`, `packages/opencode/src/session/prompt.ts:298-319,360-399,1991-2038`

- Recent activity timeline is only reconstructable from transcript-level data, not from the current index readers:
  - **Claude Code**: JSONL is append-only and mixed-event; a real sample showed `user`, `assistant`, and `last-prompt` records, which means a timeline reader must classify event types rather than assume a simple chat transcript.
  - **OpenCode**: the transcript model supports `user`, `assistant`, `tool`, and `subtask` parts, plus compaction and synthetic messages. This is the strongest schema for building a timeline view. `packages/opencode/src/session/message-v2.ts:16-191,216-455,508-922`, `packages/opencode/src/session/compaction.ts:84-132,208-233,256-333`
  - **Codex**: the `threads` table is an index, not a transcript. For deeper activity, the sibling Codex rollout-trace code points to a separate append-only event log (`trace.jsonl`) and child-thread/subagent structure; the index alone is insufficient for a timeline. `cmux/Sources/SessionIndexStore+CodexSQL.swift:25-133`

- Latest assistant message extraction is straightforward only when the store preserves assistant payloads:
  - **Claude Code**: assistant records include model/usage and content arrays in the JSONL stream; the current reader already stops after the first assistant model field, but a detail view can parse the full assistant event when needed.
  - **Codex**: the SQLite index surfaces `title`, `model`, `git_branch`, `first_user_message`, and `updated_at_ms`, but not the latest assistant transcript body.
  - **OpenCode**: the current reader already queries the latest assistant `message` JSON with a correlated subquery, then parses `providerID`, `modelID`, and `agent`. `src/vault/readers/opencodeReader.ts:19-26,47-63,84-115`, `cmux/Sources/SessionIndexStore.swift:1696-1757`

- Activity stats should be derived from transcript rows/parts, not from the summary index:
  - **Message count**: count transcript records/messages in the store.
  - **Tool count**: count tool-call parts or tool events; in OpenCode, `part.type === "tool"` is explicit in the schema.
  - **Subagent count**: count subtask parts / task invocations; OpenCode has a dedicated `subtask` part with `agent`, `prompt`, `description`, and optional `command`. `packages/opencode/src/session/message-v2.ts:508-922`, `packages/opencode/src/tool/task.ts:15-166`
  - **Token count**: use the assistant message token fields when present. OpenCode stores exact token totals on assistant messages and the UI derives totals as `input + output + reasoning + cache.read + cache.write`. `packages/opencode/src/session/message-v2.ts:216-455`, `packages/app/src/components/session/session-context-metrics.ts:1-83`

## Recommended Approach

- Keep the existing metadata readers as the **list/index path**, and add separate **detail readers** for transcript reconstruction.
- For **Claude**, stream JSONL, capture the first user prompt, latest assistant message, and a bounded tail of events; include subagent files if the store splits them under `subagents/`.
- For **OpenCode**, reconstruct the detail pane from `session` + `message` + `part` tables and use the built-in `tokens` fields for exact stats.
- For **Codex**, use the `threads` table as the session index, then add a transcript/event reader for rollout traces or per-session JSONL if the full activity pane needs tool/subagent history.

## Core API / Schema Evidence

### Current repository readers

- `src/vault/readers/claudeReader.ts:62-138` — streams JSONL, skips malformed lines, records first user title and first assistant model, then exits early.
- `src/vault/readers/codexReader.ts:23-29` — primary SQL query against `threads` with `first_user_message`, `model`, `approval_mode`, `sandbox_policy`, `reasoning_effort`, `updated_at_ms`.
- `src/vault/readers/codexReader.ts:129-188` — JSONL fallback; `query-error` is intentionally surfaced as unreadable instead of masked by fallback.
- `src/vault/readers/opencodeReader.ts:19-26` — correlated subquery to recover the latest assistant message from `message`.
- `src/vault/readers/opencodeReader.ts:47-63` — assistant JSON parsing for provider/model and agent.
- `src/vault/readers/opencodeReader.ts:84-115` — no fallback; absent DB yields zero entries.
- `src/vault/types.ts:25-33,75-95` — shared flags and session entry shape; current model is metadata-only.

### OpenCode transcript schema

- `packages/opencode/src/session/session.sql.ts:1-76` — normalized SQLite tables:
  - `session` (session metadata)
  - `message` (JSON payload per message)
  - `part` (JSON payload per part)
- `packages/opencode/src/session/message-v2.ts:16-191` — user message shape, summary fields, model metadata, and general message lifecycle.
- `packages/opencode/src/session/message-v2.ts:216-455` — assistant message shape, including `tokens`, `agent`, `mode`, `path`, and completion metadata.
- `packages/opencode/src/session/message-v2.ts:508-922` — part types; `tool` and `subtask` are first-class, which is ideal for an activity timeline.
- `packages/opencode/src/session/compaction.ts:84-132,208-233,256-333` — compaction and token pruning; detail readers must tolerate synthetic/compacted entries.
- `packages/opencode/src/session/prompt.ts:298-319,360-399,1991-2038` — first real user prompt detection and the subtask-only shortcut used for title synthesis.

### cmux / Codex evidence

- `cmux/Sources/SessionIndexStore+CodexSQL.swift:25-133` — Codex `threads` query used for indexing; good for metadata, not enough for a timeline.
- `cmux/Sources/SessionIndexStore.swift:752-817` — Claude metadata extraction from head/tail lines, including first user prompt/title and assistant model.
- `cmux/Sources/SessionIndexStore.swift:846-879` — Claude project-dir encode/decode logic (`/` <-> `-`).
- `cmux/Sources/SessionIndexStore.swift:1696-1757` — OpenCode latest assistant lookup via correlated subquery and JSON parsing.

## Usage Examples

- **OpenCode tool labels**:
  - `packages/opencode/src/tool/read.ts:21-27,147-231` shows the concise read tool shape and path-derived labels.
  - `packages/opencode/src/tool/bash.ts:55-269` shows `description`-driven command labeling and captured output metadata.
  - `packages/opencode/src/tool/edit.ts:37-166` and `packages/opencode/src/tool/grep.ts:15-156` define the exact input shapes that would appear in a transcript timeline.
  - `packages/opencode/src/tool/task.ts:15-166` defines subagent/task invocation shape (`description`, `prompt`, `subagent_type`, optional `command`).

## Gotchas & Constraints

- The current `anywhere-terminal` readers are **metadata-only**; they are not sufficient for a session-detail pane without a transcript reader.
- Codex’s SQLite `query-error` is intentionally not downgraded to fallback JSONL, so the UI should distinguish “unreadable store” from “store unavailable”. `src/vault/readers/codexReader.ts:181-188`
- OpenCode stores exact token counts on assistant messages; if a session is compacted or synthetic, some parts will not reflect the original conversation and must be treated carefully.
- Claude JSONL is mixed-event and tolerant of malformed lines, so a detail reader must be defensive and continue past corrupt records.
- OpenCode’s transcript schema separates message metadata from part content; to label tools/subagents correctly, reconstruct from both tables rather than only the `session` table.

## Gaps

- I did not verify a full Codex per-session transcript schema inside the current repo beyond the `threads` index and sibling `rollout-trace` evidence.
- I did not fully enumerate Claude subagent file naming/placement beyond the observed JSONL transcript behavior and the current reader’s directory scan strategy.
- I did not confirm a stable token-count source for Claude or Codex equivalent to OpenCode’s `tokens` object; those may need approximation or provider-specific parsing.

## Confidence

High — the report is grounded in the current repo readers plus the OpenCode and cmux source schemas, with line-level evidence for the critical session-store and transcript shapes.
