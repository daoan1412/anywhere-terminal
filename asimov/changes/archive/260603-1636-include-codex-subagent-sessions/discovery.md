# Discovery: Include Codex Subagent Sessions

## Workstreams

| Workstream | Source | Findings |
| ---------- | ------ | -------- |
| Memory recall | `bun run asm memory search codex subagent session index` | Prior specs already define Codex as a SQLite-backed session index with JSONL fallback, and Claude/OpenCode already have nested-session behavior. |
| Existing specs and docs | `asimov/specs/agent-session-index/spec.md`, `asimov/specs/terminal-subagent-preview/spec.md`, `asimov/specs/claude-running-session-map/spec.md`, `docs/research/20260529-agent-session-transcript-schemas.md`, `docs/research/20260601-claude-cli-running-detection-and-subagent-linkage.md` | Codex currently has metadata/index behavior; Claude has filesystem child sessions and team-member threading; OpenCode has DB parent-child sessions. |
| Architecture snapshot | `asm-finder` | `src/vault/VaultService.ts` aggregates readers and routes details; `src/vault/readers/codexReader.ts` owns Codex indexing/detail parsing; shared timeline contracts already include `subagentSession`. |
| Codex session semantics | `asm-finder` over the user-provided Codex JSONL sample and user-provided Codex checkout | Codex subagents are separate threads and rollout files. Parentage is represented by `thread_spawn_edges`, child `source.subagent.thread_spawn.parent_thread_id`, and parent rollout `collab_agent_spawn_end.new_thread_id` events. |
| Constraint check | `asimov/project.md`, `package.json` | No new dependency appears necessary. Existing SQLite snapshot/query infrastructure should be reused. |

## Key Findings

- Codex subagent sessions are not inline transcript entries. They are separate thread ids, separate `threads` rows, and separate rollout JSONL files.
- Codex parentage has multiple durable signals:
  - SQLite `thread_spawn_edges(parent_thread_id, child_thread_id, status)`.
  - Child `threads.source` JSON or first-line `session_meta.payload.source` containing `subagent.thread_spawn.parent_thread_id`.
  - Parent rollout events `collab_agent_spawn_begin` and `collab_agent_spawn_end`, with `collab_agent_spawn_end.new_thread_id` linking the parent timeline placement to the child thread.
- Current Codex listing reads all non-archived `threads`, so child threads can appear as top-level root sessions.
- Current Codex detail classification emits no `subagentSession` timeline items and reports `subagentCount: 0`.
- OpenCode is the closer structural precedent: child sessions are separate DB rows and are hidden from the root list, then surfaced inside parent details.
- Claude remains useful as a rendering precedent: nested sessions already use the shared `VaultTimelineItem.subagentSession` contract and existing timeline UI.

## Gap Analysis

| Gap | Current Behavior | Required Direction |
| --- | ---------------- | ------------------ |
| Top-level Codex index | Lists every active `threads` row. | Hide Codex rows that are direct subagent children, without treating them as unreadable parse failures. |
| Codex parent-child discovery | No Codex child lookup contract. | Query `thread_spawn_edges` when available; parse `threads.source` / `session_meta.payload.source` as fallback. |
| Codex parent detail timeline | Rollout classification ignores child sessions. | Emit `subagentSession` items for direct children, placed by parent `collab_agent_spawn_end` events when available. |
| Child detail resolution | Codex detail resolves plain session ids only. | A child `codex:<childThreadId>` should resolve like any other Codex session because it has its own rollout/index row. |
| Statistics | `subagentCount` remains zero. | Count direct child sessions surfaced in the parent detail. |
| Backward compatibility | Older Codex stores may lack new columns/tables. | Preserve current behavior when no parentage signals exist; do not fail the aggregate vault. |

## Options

| Option | Description | Pros | Cons | Recommendation |
| ------ | ----------- | ---- | ---- | -------------- |
| A. SQLite-first graph with JSONL fallback | Use `thread_spawn_edges` and `threads.source` for indexing/detail, then fall back to scanning JSONL session metadata and parent rollout spawn events when SQLite graph data is absent. | Matches Codex storage semantics; hides children from roots; supports parent timeline placement; reuses existing SQLite infrastructure; robust to partial stores. | Requires careful optional-schema handling and additional tests for multiple Codex store versions. | Recommended. |
| B. JSONL-only parentage detection | Ignore SQLite parent graph and scan rollout JSONL files for `session_meta` and `collab_agent_spawn_end`. | Works when SQLite is unavailable; avoids schema drift in SQL queries. | Slower; duplicates indexing logic; weaker for stores with missing rollout paths; misses DB-only metadata. | Not recommended as primary path. |
| C. UI-only grouping | Continue listing all Codex rows and group visually by inferred parent in the vault panel. | Smallest host change. | Leaves wrong API contract; children remain roots in aggregate data; detail previews still lack nested sessions. | Reject. |

## Recommended Direction

Proceed with Option A:

1. Extend Codex indexing to distinguish root threads from subagent child threads.
2. Exclude child threads from the top-level Codex session list without incrementing unreadable counts.
3. Extend Codex detail reading to discover direct children for a parent thread.
4. Emit `subagentSession` timeline items using existing shared timeline rendering contracts.
5. Prefer `collab_agent_spawn_end` events for timeline placement and labels; fall back to child metadata when the parent rollout is unavailable.
6. Keep child detail resolution simple: `codex:<childThreadId>` should open the child’s normal Codex detail.

## Risks

- Codex schema drift: `thread_spawn_edges` or new `threads` metadata columns may be absent in older stores.
- Large JSONL fallback scans can be expensive if used on every refresh.
- Parent event placement can be incomplete when the parent rollout file is missing or unreadable.
- Nested subagents may be multiple levels deep; the immediate requirement should define direct children first, with recursive rendering only if existing detail navigation naturally supports it.

## Open Questions

- Should top-level indexing hide only direct subagents or all descendants? Recommendation: hide any thread with a known parent from the top-level list, regardless of depth.
- Should parent detail show only direct children or all descendants? Recommendation: direct children only; descendants appear inside their own parent detail.
- Should failed/cancelled Codex subagent spawns be shown? Recommendation: show only children with a real child thread id; include status in labels if available.
