# vault-session-preview Specification

## MODIFIED Requirements

### Requirement: Nested sub-sessions fold into the parent

WHERE an agent records a subagent or workflow sub-session as a distinct stored transcript linked to a parent (OpenCode: a `session` row with `session.parent_id`; Claude: an `agent-<id>.jsonl` under `<parentSessionId>/subagents/` with an `agent-<id>.meta.json` carrying `toolUseId`; Codex: a child `threads` row linked by `thread_spawn_edges`, child `source.subagent.thread_spawn.parent_thread_id`, or first-line `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`), the system SHALL NOT list those children as standalone entries — the list SHALL show only top-level sessions. The parent's `VaultSessionDetail` SHALL embed each **direct** child as a `timeline` item of kind `subagentSession` (`{ entryId, title, firstMessage?, agent?, timestamp? }`), placed chronologically and bounded with the rest of the timeline.

For Claude, all subagents of a session are stored flat under `<parentSessionId>/subagents/` regardless of nesting depth, and each child's `agent-<id>.meta.json` carries the `toolUseId` of the `Agent`/`Task` `tool_use` that spawned it. A transcript's **direct** children are therefore exactly the subagents whose `meta.toolUseId` appears as a `tool_use` id within **that** transcript (the root session transcript, or a subagent's own transcript). The system SHALL scope each Claude transcript's embedded `subagentSession` items to its direct children only — a subagent spawned inside another subagent SHALL NOT appear under the root. Each `subagentSession` SHALL be placed at its spawning `tool_use` (matched by `toolUseId`). WHERE a child carries no `toolUseId` (legacy transcripts written before this field), the system SHALL fall back to matching by the spawning call's description and, if still unmatched, to chronological placement under the root — so existing sessions do not regress. `stats.subagentCount` SHALL count the direct children of the rendered transcript, not the whole subtree.

For Codex child placement, timestamp precedence SHALL be: matched parent `collab_agent_spawn_end.timestamp`, child first-line `session_meta.timestamp`, optional child `threads.created_at_ms`, then child `threads.updated_at_ms`. Codex child labels SHALL prefer the child thread title, then first user message, then parent spawn prompt, then `Subagent`. Codex child agent labels SHALL prefer `agent_nickname`, then `agent_role`, then a generic subagent label. OpenCode children SHALL be placed by the child's creation time.

The preview SHALL render each `subagentSession` as a collapsed block showing its title and first message. Expanding it SHALL fetch the child's detail on demand (reusing the standard detail request, resolving the child by its `entryId`) and render the child's transcript nested within the block. WHERE a Claude subagent transcript is stored as a sidechain file, the on-demand read SHALL include its `isSidechain` records (that file IS the subagent conversation) AND SHALL itself embed that subagent's own direct children as nested `subagentSession` items. WHERE a Codex child thread is expanded, the on-demand read SHALL resolve the child by its normal `codex:<childThreadId>` id and parse its own rollout or index row like any other Codex session. A nested child's own `subagentSession` items SHALL themselves be expandable, supporting arbitrary nesting depth (bounded by the agent runtime's own spawn-depth cap) without eagerly loading the whole tree. The host SHALL resolve every child transcript from its id within the agent's store (containment-checked), never from a webview-supplied path.

#### Scenario: Claude nested subagent nests under its real parent, not the root

- **WHEN** a Claude session's root agent spawns subagent A, and A spawns subagent B (B's `meta.toolUseId` appears in A's transcript, not the root's)
- **THEN** the root `VaultSessionDetail` timeline contains a `subagentSession` for A but NOT for B, and expanding A fetches A's detail whose timeline contains a `subagentSession` for B

#### Scenario: Codex child appears inside parent preview

- **WHEN** a Codex parent rollout contains `collab_agent_spawn_end.new_thread_id` for a child thread
- **THEN** the parent detail timeline contains one `subagentSession` item with `entryId` `codex:<childThreadId>` at that event timestamp

#### Scenario: Codex partial detail still shows known children

- **WHEN** a Codex parent has no readable rollout file but direct child metadata is available from SQLite
- **THEN** the parent detail MAY be partial and SHALL still include the direct child `subagentSession` stubs that can be discovered from the index
