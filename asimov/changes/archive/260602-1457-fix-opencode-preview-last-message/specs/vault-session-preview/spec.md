## ADDED Requirements

### Requirement: Bounded detail retains both transcript ends

WHEN a session's transcript exceeds the on-demand detail read window, the per-agent read SHALL retain both the **head** and the **tail** of the transcript — never the head alone — so that `firstPrompt` (selected from the head) and the final assistant message (surfaced as `latestMessage` and as the trailing `{ kind: "message", role: "assistant" }` timeline item, selected from the tail) BOTH survive, and SHALL set `truncated: true`. For OpenCode specifically the read SHALL retain both the earliest and the most-recent `message` and `part` rows (head ASC ∪ tail DESC), de-duplicated by row id, rather than only the earliest rows.

#### Scenario: Long OpenCode session surfaces both ends

- **WHEN** an OpenCode session's `message`/`part` rows exceed the read window
- **THEN** the detail's `firstPrompt` is still the first user message, `latestMessage` is the final assistant message text and the timeline includes its trailing assistant `message` item, and `truncated` is `true`
