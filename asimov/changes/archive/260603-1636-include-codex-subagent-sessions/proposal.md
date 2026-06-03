# Proposal: include-codex-subagent-sessions

## Why

Codex subagent runs are stored as separate threads, so the vault currently treats them like independent root sessions. Users expect Codex to behave like Claude and OpenCode: root sessions stay at the top level, and subagent work appears inside the parent session preview.

## Appetite

M (≤3d)

## Scope

### In scope

- Hide Codex child threads from the top-level vault session index.
- Surface direct Codex child threads as nested `subagentSession` timeline items in the parent `VaultSessionDetail`.
- Use Codex SQLite graph metadata first and JSONL session metadata as the fallback path.
- Keep Codex child detail loading through the standard `codex:<threadId>` detail route.
- Add unit coverage for SQLite and JSONL fallback behavior.

### Out of scope

- Changing Claude or OpenCode behavior.
- Adding a new database dependency or changing SQLite snapshot mechanics.
- Implementing live Codex terminal subagent popup resolution.
- Eagerly loading full recursive Codex subagent trees.
- Changing vault panel layout or nested-preview rendering.

## Capabilities

1. **agent-session-index** — Codex indexing distinguishes root threads from subagent child threads.
2. **vault-session-preview** — Codex parent details include direct child threads as expandable nested sub-sessions.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES
- **E2E required?** NOT REQUIRED
- **Justification**: The change affects the existing vault list and preview data returned by host readers. The webview already renders `subagentSession`; focused unit tests can verify the reader contract without VS Code E2E setup.

## Risk Level

MEDIUM — the change depends on optional Codex store schema that may differ across versions, but it is isolated to the Codex reader and can degrade to current behavior when parentage signals are unavailable.
