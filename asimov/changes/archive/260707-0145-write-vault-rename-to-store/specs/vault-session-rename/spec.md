## MODIFIED Requirements

### Requirement: User rename via sidecar registry

The system SHALL let a user assign a custom name to any vault session (claude, codex, or opencode). For a **Claude** session the system SHALL persist the name in extension global state keyed by the entry id `<agent>:<sessionId>` and SHALL NOT modify, append to, or rewrite any Claude-owned session file. For a **Codex** or **OpenCode** session the system SHALL write the name into the agent's own SQLite store (see *Native title write for SQLite agents*), falling back to the sidecar registry only when the native write cannot be performed.

#### Scenario: Rename survives vault reopen

- **WHEN** the user renames a session and later reopens the vault
- **THEN** the custom name is shown for that session — sourced from the agent's SQLite store for Codex/OpenCode, or from extension global state for Claude (and for any Codex/OpenCode entry whose native write failed)

### Requirement: Name normalization and clearing

The system SHALL trim surrounding whitespace and cap the name to the same maximum length used for terminal tab rename before storing or writing it. A name that is empty after trimming SHALL clear the sidecar custom name, reverting a Claude session (or an overlay-only Codex/OpenCode entry) to its reader-derived title; a Codex/OpenCode session that was previously written natively retains its last written title (the store cannot recover the original auto-derived title).

#### Scenario: Clearing a natively-renamed session keeps its last written title

- **WHEN** a Codex or OpenCode session whose title was written natively is renamed to an empty (after-trim) name
- **THEN** the sidecar overlay is cleared AND the store keeps the last natively-written title (no empty title is written, and the original auto-derived title is not restored)

#### Scenario: Over-long native name is capped

- **WHEN** a Codex or OpenCode session is renamed to a name longer than the cap
- **THEN** the value written into the store is the trimmed name truncated to the cap (identical to what the overlay would have stored)

## ADDED Requirements

### Requirement: Native title write for SQLite agents

When the user renames a **Codex** or **OpenCode** session to a non-empty name, the system SHALL update that session's `title` column in the agent's live SQLite store (`threads.title` for Codex keyed by `id`; `session.title` for OpenCode keyed by `id`). On a successful native write the system SHALL clear any sidecar custom name for that entry so the agent-owned title is the single source of truth, and SHALL refresh the vault list so the new title is shown. When the native write cannot be performed (the `node:sqlite` engine is unavailable, the store or row is absent, or the write errors) the system SHALL fall back to storing the name in the sidecar registry.

#### Scenario: Native write is authoritative

- **WHEN** a Codex or OpenCode session is renamed and the SQLite write succeeds
- **THEN** the agent's own store holds the new title AND no sidecar overlay remains for that entry

#### Scenario: Native write failure degrades to overlay

- **WHEN** a Codex or OpenCode session rename cannot write the store (no `node:sqlite`, missing row, or write error)
- **THEN** the name is stored in the sidecar registry and displayed via the serve-time overlay, exactly as a Claude rename

### Requirement: Native write safety

The native title write MUST bind the user-supplied name as a SQL parameter (never string-concatenated) and MUST target a session id that has already passed the agent's id-safety guard, scoped to the same visibility as the vault list (Codex non-archived threads; OpenCode root sessions) so a stale/forged id cannot rename a hidden row. The write MUST open the live store with a short busy timeout so a concurrently-running agent's WAL lock does not fail the write while bounding how long the synchronous write can block, and MUST NOT hold a long-lived transaction. An empty (after-trim) name for a Codex/OpenCode session SHALL clear the sidecar overlay only and MUST NOT write an empty title into the store.
