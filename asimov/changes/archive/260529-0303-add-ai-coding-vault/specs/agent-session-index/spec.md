## ADDED Requirements

### Requirement: Read Claude Code sessions

The system SHALL enumerate Claude sessions from `<root>/projects/<encoded-cwd>/*.jsonl`, where `root` is `$CLAUDE_CONFIG_DIR` when set else `~/.claude`, and `encoded-cwd` is the project cwd with every `/` replaced by `-`. For each file the session id SHALL be the filename without the `.jsonl` extension, and the entry SHALL carry `cwd`, `gitBranch`, `permissionMode`, `model` (from the first assistant message's `message.model`), a `title` preview (from the first user message), and `modified` (the file's mtime).

### Requirement: Read Codex sessions

The system SHALL read Codex sessions from the `threads` table of `<codexDir>/state_5.sqlite` (columns `id, rollout_path, cwd, title, model, git_branch, approval_mode, sandbox_policy, reasoning_effort, first_user_message, updated_at_ms`) filtered `WHERE archived = 0` and ordered `updated_at_ms DESC`, where `codexDir` is `$CODEX_HOME` when set else `~/.codex`, and the SQLite file MAY be relocated to `$CODEX_SQLITE_HOME` when set. When the SQLite store is absent or unreadable, the system SHALL fall back to scanning `<codexDir>/sessions/**/*.jsonl` (reading the first line's `session_meta.payload.cwd`).

### Requirement: Read OpenCode sessions

The system SHALL read OpenCode sessions from the `session` table of `<dataDir>/opencode.db`, ordered `time_updated DESC`, mapping `session id = s.id`, `cwd = s.directory`, `title = s.title`, `modified = s.time_updated`, and deriving `model`/`agent` from the latest assistant `message` row for that session, where `dataDir` is `$XDG_DATA_HOME/opencode` when set else `~/.local/share/opencode` (the same location on every OS — OpenCode resolves it via the OS-agnostic `xdg-basedir`, NOT `%APPDATA%`). OpenCode has no fallback store; when the DB is absent, OpenCode contributes zero entries (not an error).

### Requirement: WAL-safe read-only SQLite access

For any SQLite-backed store, the system SHALL read a consistent snapshot without disturbing the live agent: copy the `.sqlite`/`.db` file plus its `-wal` and `-shm` sidecars (when present) into a temporary directory, query the copy in **read-only** mode, then delete the temporary directory.

The system SHALL access SQLite via the host `sqlite3` binary in read-only JSON mode, and WHEN that binary is unavailable (e.g. Windows) SHALL fall back to the built-in `node:sqlite` module — both without any new native dependency. The SQLite read SHALL return a discriminated result distinguishing `ok` / `no-db` / `no-sqlite3` / `query-error` (not a bare empty array), so callers can tell "store absent" from "genuinely empty" from "tooling broken." WHEN neither SQLite engine is available, the read SHALL return `no-sqlite3` and SQLite-backed agents SHALL degrade to their fallback (Codex JSONL) or to zero entries (OpenCode) without raising an error; a `query-error` SHALL be counted as unreadable and surfaced, not silently dropped. The fallback engine SHALL query the temporary copy (never the live store) and SHALL be loaded inside a guard so an unsupported runtime degrades to `no-sqlite3` rather than throwing.

### Requirement: Aggregate and sort sessions

The system SHALL merge entries from all enabled agents into a single list sorted by `modified` descending, each entry tagged with its agent `id`. Each entry id SHALL be namespaced by agent (e.g. `opencode:<sid>`) so ids never collide across agents.

### Requirement: Defensive, non-fatal parsing

The system SHALL skip any individual session entry that fails to parse without aborting the rest of the index, and SHALL report a count of unreadable entries. A missing store directory or file for an agent SHALL yield zero entries for that agent, never an error that breaks the aggregate list.

### Requirement: Metadata-only, bounded title preview, no egress

The system SHALL read session metadata (id, cwd, timestamp, model/flags) plus a single title preview. The title preview is the ONLY transcript-derived value the system touches; because it originates from a user message it MAY contain sensitive content, so it SHALL be truncated to ≤120 characters and newline-stripped at read time, and SHALL NOT be persisted or cached. The system SHALL NOT read message bodies beyond the first preview line, and SHALL NOT send any vault data off the machine.

#### Scenario: Only a bounded preview leaves the reader

- **WHEN** a session file contains full conversation message content
- **THEN** only the listed metadata fields plus one ≤120-char, newline-stripped title preview are extracted; no further message body is stored, cached, or sent over IPC
