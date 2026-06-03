# Design: include-codex-subagent-sessions

## Decisions

### D1: Treat Codex children as normal Codex entries, not synthetic child ids

Codex subagents are separate thread ids with separate rollout files, so the child entry id SHALL be `formatEntryId("codex", childThreadId)`. This matches OpenCode's structural model and keeps `readCodexDetail(childThreadId)` as the only child-detail path. A Claude-style synthetic id is rejected because there is no Codex filesystem child path to encode.

### D2: Apply Codex root filtering before the row limit whenever parentage is known

`readCodexSessions()` SHALL avoid filtering a pre-limited child-heavy result down to a short root list. When parentage can be expressed in SQLite, the list query SHALL exclude child rows before `LIMIT 500`, using `thread_spawn_edges` and/or source metadata. When optional schema is absent, the reader MAY fall back to the existing list query and then use JSONL first-line metadata as a best-effort child filter.

Optional metadata reads MAY query `thread_spawn_edges` and optional `threads` metadata such as `source`, `thread_source`, `agent_path`, `agent_nickname`, `agent_role`, and `created_at_ms`, but a `query-error` from those optional reads SHALL degrade to the next available parentage source, not to an unreadable aggregate result. This avoids breaking older Codex stores where the new table or columns are absent.

### D3: Prefer Codex thread graph parentage, then source metadata

For SQLite-backed list and detail reads, direct parent-child relationships SHALL be discovered in this order:

1. `thread_spawn_edges(parent_thread_id, child_thread_id, status)` when the table exists.
2. Child `threads.source` JSON containing `subagent.thread_spawn.parent_thread_id`.
3. Child summary columns such as `thread_source = "subagent"` only when they can be tied to a concrete parent id.

For JSONL fallback, and for DB-present stores whose SQLite schema does not expose usable parentage, the first line's `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` SHALL provide equivalent parentage. A thread with any known parent is hidden from the top-level list. A parent detail shows only its direct children.

### D4: Place Codex child stubs from parent rollout spawn events when possible

`classifyCodexRolloutEvents()` SHALL accept optional child stubs and merge them into the timeline with messages/tools before bounding. When parent rollout records contain `event_msg` payloads such as `collab_agent_spawn_end`, the classifier SHALL match `payload.new_thread_id` to the child id and use that event timestamp and payload fields for placement/labels. If no matching parent event exists, the reader SHALL merge the child stub at the child metadata timestamp.

The `subagentSession` item SHALL prefer title/first-message text from child index metadata, and MAY use parent event `prompt`, `agent_nickname`, `agent_role`, `model`, or `reasoning_effort` to improve the collapsed label. Failed or cancelled spawn events without a real child thread id SHALL NOT create a child stub. Timestamp precedence is matched parent spawn event, child first-line `session_meta.timestamp`, optional child `threads.created_at_ms`, then child `threads.updated_at_ms`.

### D5: Partial Codex details can include child stubs

When a parent rollout cannot be read but the parent thread row exists, `readCodexDetail()` SHALL continue returning the existing partial detail. If direct children are discoverable from SQLite, that partial detail SHALL include child `subagentSession` timeline items after the indexed first prompt and set `stats.subagentCount` to the child count.

### D6: JSONL fallback scans stay bounded to session metadata for indexing

The fallback list path already walks `sessions/**/*.jsonl`. It SHALL continue reading only the first line for each file and SHALL parse only metadata needed for session id, cwd, timestamp, and parentage. The same bounded metadata scan MAY run when SQLite exists but cannot provide parentage columns/tables. Full rollout parsing remains limited to the on-demand detail path. This preserves the privacy and performance intent of the metadata-only index.

### D7: Invalidate the persisted vault list cache

The implementation SHALL prevent old persisted Codex list data from being reused after child filtering is introduced. Preferred approach: bump `VAULT_CACHE_VERSION` in `src/vault/cacheTypes.ts`, which discards all stale persisted vault list caches through existing cache loading behavior. A Codex-only cache rejection is acceptable if the builder can keep it smaller, but it must cover both the instant merged snapshot and per-agent `ReaderListCache` reuse.

## Architecture

Codex list flow:

1. Resolve Codex DB and sessions directories with `codexDirs()`.
2. Read existing thread rows through `CODEX_THREADS_SQL`.
3. Prefer a root-filtering SQL query that excludes known child rows before applying the row limit.
4. When SQLite cannot expose parentage, use a bounded first-line JSONL metadata scan to build a hidden-child set and skip those ids from the list.
5. If SQLite is absent or unavailable, run JSONL fallback and skip first-line child sessions.

Codex detail flow:

1. Resolve and validate the parent thread id.
2. Read the parent thread row with `queryCodexThread()`.
3. Discover direct child stubs from SQLite; if SQLite is unavailable, scan JSONL first-line metadata.
4. Read and classify the parent rollout when available, passing child stubs into the classifier.
5. If the parent rollout is unavailable, return partial index detail with child stubs when available.

## Interfaces

Internal Codex child stub shape:

```ts
interface CodexChildStub {
  childThreadId: string;
  title: string;
  firstMessage?: string;
  agent?: string;
  timestamp: number;
  spawn?: {
    prompt?: string;
    model?: string;
    reasoningEffort?: string;
    status?: string;
  };
}
```

The exported IPC shape remains unchanged: child stubs become existing `VaultTimelineItem` values with `kind: "subagentSession"`.

## Risk Map

| Component | Risk | Mitigation |
| --- | --- | --- |
| Codex SQLite reads | Optional schema is absent in older stores. | Keep the existing main list query stable and treat optional parentage query errors as missing parentage only. |
| Codex JSONL fallback | Full scans can be expensive. | Read only first-line `session_meta` for index/fallback child detection; reserve full stream parsing for detail reads. |
| Parent timeline placement | Parent rollout lacks a matching `collab_agent_spawn_end`. | Fall back to child metadata timestamp and still expose the child stub. |
| Top-level filtering | A child with known parent is incorrectly counted as unreadable. | Filter child ids before unreadable accounting for otherwise valid rows; test unreadable counts. |
| Detail recursion | Nested Codex subagents could tempt eager recursive loads. | Emit only direct child stubs; rely on existing expand-on-demand detail requests for deeper nesting. |
| Persisted vault cache | Old cache entries keep Codex child threads visible after the change. | Bump `VAULT_CACHE_VERSION` or explicitly reject stale Codex cache state. |
