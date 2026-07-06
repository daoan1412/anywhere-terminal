# vault-session-rename Specification
## Requirements

### Requirement: User rename via sidecar registry

The system SHALL let a user assign a custom name to any vault session (claude, codex, or opencode) and SHALL persist it in extension global state keyed by the session entry id `<agent>:<sessionId>`. The system SHALL NOT modify, append to, or rewrite any agent-owned session file or database when renaming.

#### Scenario: Rename survives vault reopen

- **WHEN** the user renames a session and later reopens the vault
- **THEN** the custom name is shown for that session, sourced from extension global state (no agent file was written)

### Requirement: Custom name overrides derived title

When a custom name exists for an entry, the vault list row and the preview header SHALL display the custom name in place of the reader-derived title. The overlay SHALL be applied at serve time and SHALL NOT be persisted into the vault list cache (the cache stays agent-derived).

### Requirement: Name normalization and clearing

The system SHALL trim surrounding whitespace and cap the stored custom name to the same maximum length used for terminal tab rename. A name that is empty after trimming SHALL clear the custom name, reverting the session to its reader-derived title.

