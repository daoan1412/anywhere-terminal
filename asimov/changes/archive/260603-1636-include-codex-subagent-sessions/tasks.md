## 1. Codex Session Graph

- [x] 1_1 Add Codex child-parent metadata helpers
  - **Deps**: none
  - **Refs**: specs/agent-session-index/spec.md; design.md D2; design.md D3; design.md D4; design.md D6; ../../../docs/research/20260529-agent-session-transcript-schemas.md
  - **Scope**: src/vault/readers/codexReader.ts; src/vault/readers/codexReader.test.ts
  - **Acceptance**:
    - Outcome: Codex reader code can identify a child thread from `thread_spawn_edges`, `threads.source` JSON, and first-line `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`, with the documented timestamp fallback order.
    - Verify: unit src/vault/readers/codexReader.test.ts
  - **Plan**:
    1. Add small internal types/functions for parsing Codex source metadata and collecting child ids by parent id.
    2. Add optional SQLite parentage query helpers that return empty results on optional-schema `query-error` and include child metadata fields when available.
    3. Add pure tests for child detection from edge rows, source JSON shapes, and timestamp fallback.

- [x] 1_2 Hide Codex child threads from the top-level index
  - **Deps**: 1_1
  - **Refs**: specs/agent-session-index/spec.md; design.md D2; design.md D3; design.md D6
  - **Scope**: src/vault/readers/codexReader.ts; src/vault/readers/codexReader.test.ts; src/vault/__fixtures__/codex/sessions/2026/05/01/rollout-xyz.jsonl
  - **Acceptance**:
    - Outcome: `readCodexSessions()` lists root Codex sessions only, excludes known child threads without increasing unreadable counts, applies the row limit after root filtering, and supports both SQLite and JSONL metadata paths.
    - Verify: unit src/vault/readers/codexReader.test.ts
  - **Plan**:
    1. Prefer a SQLite root query/filter that excludes child rows before `LIMIT 500` when parentage is available.
    2. Extend JSONL metadata scanning to hide children when SQLite is absent and when SQLite exists but lacks parentage metadata.
    3. Add tests for edge-linked children, source-linked children, missing optional schema, DB-present JSONL fallback, JSONL-only fallback, unreadable counts, and limit-before-filter.

- [x] 1_3 Invalidate stale vault list cache
  - **Deps**: 1_2
  - **Refs**: specs/agent-session-index/spec.md; design.md D7
  - **Scope**: src/vault/cacheTypes.ts; src/vault/readers/codexReader.test.ts; src/vault/VaultCacheStore.test.ts
  - **Acceptance**:
    - Outcome: Previously persisted vault list cache data cannot keep Codex child threads visible as root rows after the new filtering behavior ships.
    - Verify: unit src/vault/readers/codexReader.test.ts
  - **Plan**:
    1. Bump `VAULT_CACHE_VERSION`, or reject stale Codex cache reuse explicitly if that produces a smaller change.
    2. Add or update a focused test proving stale cached Codex entries are not reused in a way that bypasses child filtering.

## 2. Codex Nested Preview

- [x] 2_1 Emit Codex direct children in parent detail timelines
  - **Deps**: 1_1
  - **Refs**: specs/vault-session-preview/spec.md; design.md D1; design.md D3; design.md D4; ../../../docs/research/20260529-agent-session-transcript-schemas.md
  - **Scope**: src/vault/readers/codexReader.ts; src/vault/readers/codexReader.detail.test.ts
  - **Acceptance**:
    - Outcome: `readCodexDetail(parentId)` returns `subagentSession` timeline items for direct Codex child threads, uses `codex:<childThreadId>` entry ids, and increments `stats.subagentCount`.
    - Verify: unit src/vault/readers/codexReader.detail.test.ts
  - **Plan**:
    1. Add a direct-child query/scan helper that hydrates child title, first message, agent, and timestamp metadata.
    2. Extend `classifyCodexRolloutEvents()` to accept child stubs and merge them into the bounded chronological timeline.
    3. Match parent `collab_agent_spawn_end.new_thread_id` events to child stubs for placement and label refinement.
    4. Add tests covering matched spawn placement, timestamp fallback order, fallback child timestamp placement, and `subagentCount`.

- [x] 2_2 Preserve partial detail and child detail behavior
  - **Deps**: 2_1
  - **Refs**: specs/vault-session-preview/spec.md; design.md D1; design.md D5
  - **Scope**: src/vault/readers/codexReader.ts; src/vault/readers/codexReader.detail.test.ts
  - **Acceptance**:
    - Outcome: A Codex parent with no readable rollout still returns a partial detail containing discoverable child stubs, and `readCodexDetail(childId)` opens the child as a normal Codex session.
    - Verify: unit src/vault/readers/codexReader.detail.test.ts
  - **Plan**:
    1. Merge child stubs into the existing index-only partial detail path.
    2. Ensure child ids use the unchanged safe Codex id validation and rollout/index resolution.
    3. Add tests for partial parent detail with children and direct child detail loading.

## 3. Verification

- [x] 3_1 Run focused Codex reader verification
  - **Deps**: 1_3, 2_2
  - **Refs**: specs/agent-session-index/spec.md; specs/vault-session-preview/spec.md
  - **Scope**: src/vault/cacheTypes.ts; src/vault/readers/codexReader.ts; src/vault/readers/codexReader.test.ts; src/vault/readers/codexReader.detail.test.ts; src/vault/VaultCacheStore.test.ts; src/vault/__fixtures__/codex/sessions/2026/05/01/rollout-xyz.jsonl
  - **Acceptance**:
    - Outcome: Focused Codex reader tests pass and cover top-level hiding, cache invalidation, DB-present JSONL fallback, limit-before-filter, nested timeline stubs, partial detail, and child detail resolution.
    - Verify: manual run focused Codex list and detail Vitest files
  - **Plan**:
    1. Run the focused Vitest files for Codex list and detail readers.
    2. Fix failures without changing shared vault contracts unless tasks are re-scoped.
    3. Run project type check if implementation changes exported types.
