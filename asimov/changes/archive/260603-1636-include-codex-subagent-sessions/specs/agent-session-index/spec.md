## MODIFIED Requirements

### Requirement: Read Codex sessions

The system SHALL read Codex sessions from the `threads` table of `<codexDir>/state_5.sqlite` (columns `id, rollout_path, cwd, title, model, git_branch, approval_mode, sandbox_policy, reasoning_effort, first_user_message, updated_at_ms`) filtered `WHERE archived = 0` and ordered `updated_at_ms DESC`, where `codexDir` is `$CODEX_HOME` when set else `~/.codex`, and the SQLite file MAY be relocated to `$CODEX_SQLITE_HOME` when set. When the SQLite store is absent or unreadable, the system SHALL fall back to scanning `<codexDir>/sessions/**/*.jsonl` (reading the first line's `session_meta.payload.cwd`).

The system SHALL exclude Codex subagent child threads from the top-level aggregate list. A Codex thread is a child when either `thread_spawn_edges` records it as `child_thread_id`, or its `threads.source` / first-line `session_meta.payload.source` parses as `subagent.thread_spawn` with a non-empty `parent_thread_id`. Excluding a child thread is a normal grouping decision and SHALL NOT increase the unreadable count. The root list limit SHALL be applied after child filtering, so a store with many recent child threads still returns up to the configured number of root sessions. Older Codex stores that lack `thread_spawn_edges`, `threads.source`, or first-line subagent metadata SHALL continue to list sessions using the existing root behavior rather than failing the aggregate list.

When SQLite exists but does not expose usable child metadata, the system MAY scan Codex rollout JSONL first lines to discover child parentage before returning the root list. That DB-present metadata scan SHALL read only first-line `session_meta` records and SHALL be skipped when the SQLite query itself returns `query-error`.

The persisted vault list cache SHALL be invalidated for this behavior change, either by bumping the cache schema version or by rejecting stale Codex `ReaderListCache` values before reuse, so previously cached child threads do not remain visible as root rows.

#### Scenario: Codex child thread is hidden from top-level list

- **WHEN** the Codex store contains a root thread and a child thread linked by `thread_spawn_edges`
- **THEN** the Codex index includes the root thread and omits the child thread without incrementing unreadable entries

#### Scenario: Root limit is applied after child filtering

- **WHEN** more recent Codex rows are child threads and older rows are root threads
- **THEN** the returned root list is filled from eligible root rows up to the configured limit instead of filtering a pre-limited child-heavy result to a short list

#### Scenario: JSONL fallback hides Codex child thread

- **WHEN** SQLite is unavailable and a rollout JSONL first line has `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`
- **THEN** the JSONL fallback omits that child from the top-level Codex list
