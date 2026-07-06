# vault-metadata-display Specification
## Requirements

### Requirement: Per-assistant-message model and token usage

For each assistant message rendered in a session preview, where the agent's transcript records it, the system SHALL display the model id and the message's token usage (prompt/context tokens and output tokens). When the agent records a model context window (Codex `model_context_window`), the system SHALL display it alongside the usage. Messages for which the agent records no model/token data SHALL omit the meta line entirely — the system SHALL NOT display fabricated or zero-filled values.

#### Scenario: Assistant message with usage

- **WHEN** an assistant message's transcript record carries a model id and token usage
- **THEN** a compact meta line shows the model and token counts (and context window when present) for that message

#### Scenario: Message without usage data

- **WHEN** a message record has no model/token fields (e.g. a user message, or an agent that omits them)
- **THEN** no meta line is shown for that message

### Requirement: Session git branch chip

Where the agent records a git branch for the session (Claude top-level `gitBranch`, Codex `git_branch`), the system SHALL surface the branch as a session-level chip in the preview header. OpenCode sessions, which record no git branch, SHALL omit the branch chip rather than showing an empty or derived value.

