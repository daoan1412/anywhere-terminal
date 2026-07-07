---
labels: [codex, agent-integration, design-trade-off, data-consistency, append-only]
source: write-vault-rename-to-store
summary: Codex renaming updates SQLite threads.title only (not the append-only session_index.jsonl index). DB-only is safe: prefer_existing_explicit_title preserves user renames; mirroring would repeat the fragile append-to-agent-file pattern deliberately avoided.
---
# Codex session_index.jsonl intentionally not mirrored — DB-only write is safe and correct
**Date**: 2026-07-07

## TL;DR
- Codex stores thread metadata in two places: SQLite `threads.title` and append-only `session_index.jsonl`
- Vault rename writes **only** to SQLite (DB-only, no JSONL update)
- Safe: Codex `prefer_existing_explicit_title()` preserves DB titles on reconcile
- Rationale: JSONL is agent-owned append-only; mirroring would repeat the fragile pattern the hybrid explicitly avoids
- Documented limitation: `session_index.jsonl` index stays stale until Codex rewrites it

## Context
The vault's native-rename feature updates Codex thread titles by calling `UPDATE threads SET title = ? WHERE id = ?`. Codex also maintains a `session_index.jsonl` index file for quick lookups/resume.

A full rename could update both SQLite and the JSONL. But appending a synthetic entry to an agent-owned append-only file is the **exact fragile pattern** the safe-location hybrid deliberately avoids:
- Error-prone (agent format details, envelope structure)
- Risky (corrupting an agent's own resumption index)
- Duplicating agent concerns (Codex owns its own write semantics)

The DB-only approach is safe because:
1. Codex's `prefer_existing_explicit_title()` keeps a title that differs from the first user message
2. A user-supplied rename always differs from the first prompt (invariant)
3. On reconcile, the DB title is preserved and not clobbered

The JSONL index will remain stale until Codex itself rewrites it on next activity (acceptable UX tradeoff: vault shows the new name immediately; Codex's own CLI resume index lags slightly).

Edge case: renaming to a string that exactly equals the first user message is treated by Codex as non-explicit (`distinct_thread_metadata_title → None`). Rare, not handled, same as old overlay behavior.

## Evidence
### Anchors
- `src/vault/readers/codexReader.ts` → `renameCodexThread()` lines ~210-225: executes only `UPDATE threads SET title = ?`, no JSONL append
- Design D3 Risk Map: "Codex `session_index.jsonl` stays stale after a DB-only write" → ACCEPTED limitation with rationale
- Research doc 20260707-vault-native-rename.md §3: Codex reconciliation flow, `prefer_existing_explicit_title()` behavior

## When to apply
- Deciding whether to mirror a multi-source agent data structure when only one source is safe to write
- Symptom: "agent has two authoritative places for X; should we update both?" → first ask if writing one is safe + sufficient
- Decision gate: "Does the agent's own logic preserve what I write to the primary source?" Yes → DB-only is correct
- Prevention gate: "Appending to agent's append-only file" → red flag, avoid unless you own that file format + error recovery
