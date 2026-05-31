# vault-session-preview Specification
## Requirements

### Requirement: On-demand session detail read

The system SHALL, on request for a single session entry, read that session's content and return a bounded `VaultSessionDetail` carrying: `firstPrompt` (the first real user message text, truncated), `recentActivity` (an ordered list of the most-recent steps — each a tool **call** `{ kind: "tool", tool, detail?, diff? }` or a subagent invocation `{ kind: "subagent", name, prompt? }`), `latestMessage` (`{ role, text, timestamp }`), and `stats` (`{ messageCount, toolCount, subagentCount, tokenCount? }`).

The read SHALL be per-agent — Claude: stream the session `jsonl`; OpenCode: read `session`/`message`/`part` rows; Codex: parse the per-session rollout `jsonl` when present — SHALL skip malformed records and continue, and SHALL bound output (cap `recentActivity` to the most-recent steps and truncate each text field). `firstPrompt` and `latestMessage` SHALL be selected independently of the bounded `recentActivity` window (a long session MUST still surface its first prompt), and SHALL exclude synthetic, compaction, summary, and subagent-sidechain records. `recentActivity` SHALL record tool **calls** and subagent invocations only, never tool results as standalone steps. `tokenCount` SHALL be populated only when derivable from the agent's stored usage; otherwise it is omitted.

WHEN only an index is available for the session and no transcript can be read (e.g. a Codex session with no rollout file), the detail MAY be **partial** — omitting `recentActivity` and `latestMessage` — and SHALL set `partial: true` with a short `limitedReason`, which the preview surfaces so the session does not appear broken.

### Requirement: Session detail IPC

The webview SHALL request detail via a `requestVaultSessionDetail` message carrying the entry `id` only, and the host SHALL reply with `vaultSessionDetailResponse` carrying the same `entryId` plus either the `VaultSessionDetail` or an `error` marker. The host SHALL resolve the session's on-disk location itself from the session id within the agent's store (never from a webview-supplied path), holding no detail cache and not re-listing the full index.

### Requirement: Nested sub-sessions fold into the parent

WHERE an agent records a subagent or workflow sub-session as a distinct stored transcript linked to a parent (OpenCode: a `session` row with `session.parent_id`; Claude: an `agent-<id>.jsonl` under `<parentSessionId>/subagents/` with an `agent-<id>.meta.json`), the system SHALL NOT list those children as standalone entries — the list SHALL show only top-level sessions. The parent's `VaultSessionDetail` SHALL embed each direct child as a `timeline` item of kind `subagentSession` (`{ entryId, title, firstMessage?, agent?, timestamp? }`), placed chronologically (OpenCode: by the child's creation time; Claude: at its spawning `Agent`/`Task` tool call, matched by description) and bounded with the rest of the timeline.

The preview SHALL render each `subagentSession` as a collapsed block showing its title and first message. Expanding it SHALL fetch the child's detail on demand (reusing the standard detail request, resolving the child by its `entryId`) and render the child's transcript nested within the block. WHERE a Claude subagent transcript is stored as a sidechain file, the on-demand read SHALL include its `isSidechain` records (that file IS the subagent conversation). A nested child's own `subagentSession` items SHALL themselves be expandable, supporting arbitrary nesting depth without eagerly loading the whole tree. The host SHALL resolve every child transcript from its id within the agent's store (containment-checked), never from a webview-supplied path.

### Requirement: Safe preview rendering

The preview overlay SHALL render all session-derived text as plain text (never as HTML), so transcript content cannot inject markup. Wrapper tokens present in raw content (e.g. `<command-message>`) SHALL be displayed literally. Agent icons in the overlay SHALL come only from the static agent-icon map, never constructed from session data. The overlay SHALL show a header (agent badge, title, Resume, Close), a meta block (folder, modified, activity summary), and body sections for First prompt, Recent activity, and Latest message; a section with no data SHALL be omitted.

