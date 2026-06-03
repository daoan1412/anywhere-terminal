# vault-session-preview Specification
## Requirements

### Requirement: On-demand session detail read

The system SHALL, on request for a single session entry, read that session's content and return a bounded `VaultSessionDetail` carrying: `firstPrompt` (the first real user message text, truncated), `recentActivity` (an ordered list of the most-recent steps — each a tool **call** `{ kind: "tool", tool, detail?, diff? }` or a subagent invocation `{ kind: "subagent", name, prompt? }`), `latestMessage` (`{ role, text, timestamp }`), and `stats` (`{ messageCount, toolCount, subagentCount, tokenCount? }`).

The read SHALL be per-agent — Claude: stream the session `jsonl`; OpenCode: read `session`/`message`/`part` rows; Codex: parse the per-session rollout `jsonl` when present — SHALL skip malformed records and continue, and SHALL bound output (cap `recentActivity` to the most-recent steps and truncate each text field). `firstPrompt` and `latestMessage` SHALL be selected independently of the bounded `recentActivity` window (a long session MUST still surface its first prompt), and SHALL exclude synthetic, compaction, summary, and subagent-sidechain records. `recentActivity` SHALL record tool **calls** and subagent invocations only, never tool results as standalone steps. `tokenCount` SHALL be populated only when derivable from the agent's stored usage; otherwise it is omitted.

WHEN only an index is available for the session and no transcript can be read (e.g. a Codex session with no rollout file), the detail MAY be **partial** — omitting `recentActivity` and `latestMessage` — and SHALL set `partial: true` with a short `limitedReason`, which the preview surfaces so the session does not appear broken.

### Requirement: Session detail IPC

The webview SHALL request detail via a `requestVaultSessionDetail` message carrying the entry `id` only, and the host SHALL reply with `vaultSessionDetailResponse` carrying the same `entryId` plus either the `VaultSessionDetail` or an `error` marker. The host SHALL resolve the session's on-disk location itself from the session id within the agent's store (never from a webview-supplied path), holding no detail cache and not re-listing the full index.

### Requirement: Nested sub-sessions fold into the parent

WHERE an agent records a subagent or workflow sub-session as a distinct stored transcript linked to a parent (OpenCode: a `session` row with `session.parent_id`; Claude: an `agent-<id>.jsonl` under `<parentSessionId>/subagents/` with an `agent-<id>.meta.json`; Codex: a child `threads` row linked by `thread_spawn_edges`, child `source.subagent.thread_spawn.parent_thread_id`, or first-line `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`), the system SHALL NOT list those children as standalone entries — the list SHALL show only top-level sessions. The parent's `VaultSessionDetail` SHALL embed each direct child as a `timeline` item of kind `subagentSession` (`{ entryId, title, firstMessage?, agent?, timestamp? }`), placed chronologically (OpenCode: by the child's creation time; Claude: at its spawning `Agent`/`Task` tool call, matched by description; Codex: at the parent rollout's `collab_agent_spawn_end` event matched by `new_thread_id` when available, otherwise by child metadata time) and bounded with the rest of the timeline.

For Codex child placement, timestamp precedence SHALL be: matched parent `collab_agent_spawn_end.timestamp`, child first-line `session_meta.timestamp`, optional child `threads.created_at_ms`, then child `threads.updated_at_ms`. Codex child labels SHALL prefer the child thread title, then first user message, then parent spawn prompt, then `Subagent`. Codex child agent labels SHALL prefer `agent_nickname`, then `agent_role`, then a generic subagent label.

The preview SHALL render each `subagentSession` as a collapsed block showing its title and first message. Expanding it SHALL fetch the child's detail on demand (reusing the standard detail request, resolving the child by its `entryId`) and render the child's transcript nested within the block. WHERE a Claude subagent transcript is stored as a sidechain file, the on-demand read SHALL include its `isSidechain` records (that file IS the subagent conversation). WHERE a Codex child thread is expanded, the on-demand read SHALL resolve the child by its normal `codex:<childThreadId>` id and parse its own rollout or index row like any other Codex session. A nested child's own `subagentSession` items SHALL themselves be expandable, supporting arbitrary nesting depth without eagerly loading the whole tree. The host SHALL resolve every child transcript from its id within the agent's store (containment-checked), never from a webview-supplied path.

#### Scenario: Codex child appears inside parent preview

- **WHEN** a Codex parent rollout contains `collab_agent_spawn_end.new_thread_id` for a child thread
- **THEN** the parent detail timeline contains one `subagentSession` item with `entryId` `codex:<childThreadId>` at that event timestamp

#### Scenario: Codex partial detail still shows known children

- **WHEN** a Codex parent has no readable rollout file but direct child metadata is available from SQLite
- **THEN** the parent detail MAY be partial and SHALL still include the direct child `subagentSession` stubs that can be discovered from the index

### Requirement: Safe preview rendering

The preview overlay SHALL render all session-derived text as plain text (never as HTML), so transcript content cannot inject markup. Wrapper tokens present in raw content (e.g. `<command-message>`) SHALL be displayed literally. Agent icons in the overlay SHALL come only from the static agent-icon map, never constructed from session data. The overlay SHALL show a header (agent badge, title, Resume, Close), a meta block (folder, modified, activity summary), and body sections for First prompt, Recent activity, and Latest message; a section with no data SHALL be omitted.

### Requirement: Bounded detail retains both transcript ends

WHEN a session's transcript exceeds the on-demand detail read window, the per-agent read SHALL retain both the **head** and the **tail** of the transcript — never the head alone — so that `firstPrompt` (selected from the head) and the final assistant message (surfaced as `latestMessage` and as the trailing `{ kind: "message", role: "assistant" }` timeline item, selected from the tail) BOTH survive, and SHALL set `truncated: true`. For OpenCode specifically the read SHALL retain both the earliest and the most-recent `message` and `part` rows (head ASC ∪ tail DESC), de-duplicated by row id, rather than only the earliest rows.

#### Scenario: Long OpenCode session surfaces both ends

- **WHEN** an OpenCode session's `message`/`part` rows exceed the read window
- **THEN** the detail's `firstPrompt` is still the first user message, `latestMessage` is the final assistant message text and the timeline includes its trailing assistant `message` item, and `truncated` is `true`

