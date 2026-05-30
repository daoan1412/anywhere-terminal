# Workflow State: cache-vault-load

> **Source of truth:** Workflow stages/gates → this file · Task completion → `tasks.md`
>
> **Checkbox states:** `[ ]` pending · `[/]` in progress · `[x]` done · `[-]` skipped/N/A

## Plan

- [x] 1. Context + Triage
  - [x] Read `asimov/project.md`, run `bun run asm change list` + `bun run asm spec list`
  - [x] Choose `change-id`, run `bun run asm change new`
  - [x] Classify complexity + escalation flags → record in Notes
- [x] 2. Discovery
  - [x] Execute workstreams (parallel finder/librarian subagents)
  - [x] Fill `discovery.md` — findings, gap analysis, options, risks
  - [x] **GATE 1: user approved direction** _(fastlane — auto-proceed; chose Option C: persisted cache + incremental refresh)_
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — vault-list-cache (ADDED), agent-session-index (MODIFIED), vault-panel (MODIFIED)
  - [x] Fill design.md (D1–D7 + Interfaces + Risk Map)
  - [x] Fill tasks.md (6 tasks across 5 sections, dependency-ordered)
- [x] 7. Validation
  - [x] `bun run asm change validate` passes (0 errors; 1 expected warning = the deliberate D5 privacy contradiction)
  - [x] Oracle review _(plan stage — HIGH confidence, sound; 6 findings all ACCEPTED + folded in)_
  - [x] **GATE 2: user approved plan** _(fastlane — auto-approve, proceed to build)_

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [x] 2. Execute tasks sequentially in dependency order (all 6 tasks done)
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [x] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass**:
  - [x] Type check — `pnpm run check-types` clean
  - [x] Lint — Biome clean on changed files (full `pnpm run lint` OOMs — Biome memory issue, unrelated)
  - [x] Test — `pnpm run test:unit` 1807/1807 pass; 10/10 full-suite runs stable
  - [-] E2E — N/A (no E2E harness; project.md § Commands E2E = N/A)
- [x] 5. Review (adaptive):
  - [x] Code Review — data-security + logic + frontend + oracle (plan + code). See `.reviews/round-1.md`
- [x] 6. Findings triage: accept/rebut each finding with rationale — see `.reviews/round-1.md`
- [x] 7. Review Fix Loop — 1 round: 8 findings accepted+fixed, 1 rebutted; re-verified green
- [ ] 8. Validation
  - [ ] **Gate: user approved implementation**
  - [ ] Extract knowledge

## Archive

- [ ] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_:
  - [ ] Run deploy command
  - [ ] Run smoke test
- [ ] Apply deltas: `bun run asm change apply`
- [ ] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

**Mode:** fastlane (auto-choose all gates, no user questions, full artifact quality). Run full flow plan → build → code review → oracle review.

**Worktree:** `cache-vault-load` branched from local HEAD `3c0c9e8` (local is 15 commits ahead of origin/main — user explicitly required local-main base). Note: `.agents/skills/asimov-*` is gitignored so asm CLI runs via absolute path from main repo: `/Users/huybuidac/Projects/ai-oss/anywhere-terminal/.agents/skills/asimov-core/scripts/asm.ts`.

**User goal (verbatim intent):** Vault panel takes too long to display on every VS Code open. Want to cache vault data so it displays instantly from cache, then only refresh/update new data in the background.

Complexity: **standard** — caching layer + incremental refresh strategy, MEDIUM risk (stale cache showing wrong data / cache invalidation), spans extension-host data load → IPC → webview render.
Escalation flags: none hard (no new dep, no public API contract). Design required by standard tier anyway (cache schema, invalidation, incremental-update decisions).

**⚠ Escalation flag added during Discovery: `security-privacy`.** Caching requires persisting the bounded
session title to disk, which the existing `agent-session-index` spec explicitly forbade ("SHALL NOT be
persisted or cached"). Decision D5 reverses this with mitigation (0o600 owner-only, globalStorage, no
egress) mirroring `SessionStorage`'s established posture. This is the one decision needing explicit human
acceptance — flagged in the Gate-2 handoff and routed to oracle review.

Auto-decisions (fastlane):
- GATE 1 → Option C (persisted cache + incremental refresh). Beats in-memory (dies on restart) and
  full-reread-in-background (violates "only update new data").
- Cache location → `globalStorageUri` (agent stores are machine-global), not workspace storage.
- Change detection → `(mtimeMs, size)`; Claude per-session-file, SQLite per-store-file (db + -wal).
- UI → silent stale-while-revalidate with a no-op render guard (no new affordance), to minimize risk.
- GATE 2 → auto-approve; proceed to build.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-29T18:19:23Z | claude | Stage 1 | Triage: standard, no hard escalation flags. Created change + worktree from local HEAD. | Fastlane plan kickoff |
| 2026-05-29T18:29:59Z | claude | Stage 2-6 | Discovery (2 finders) + batch-wrote discovery/proposal/specs(×3)/design/tasks. Added `security-privacy` flag (D5: persist bounded title at 0o600). | Plan artifacts complete |
| 2026-05-29T18:29:59Z | claude+oracle | Stage 7 | Oracle plan review (HIGH conf). ACCEPTED all 6 findings: (1) D5 same-UID/cwd honesty, (2) readers stay option-first `(options?,prev?)`, (3) `await save()` not `void`, (4) render signature covers canFork/cwd/flags/sessionPath, (5) `-shm` excluded from freshness, (6) test reuse via fake-fs not private spies. Updated design D2/D3/D5/D6 + Interfaces, tasks 2_1/2_2/2_3/3_1/5_1, spec. | Plan hardened pre-build |
| 2026-05-29T23:16:19Z | claude | Build | Implemented tasks 1_1–5_1: new cacheTypes.ts, VaultCacheStore.ts, storeStamp.ts, vaultRenderSignature.ts (+tests); incremental readers; VaultService cache orchestration; provider two-phase; webview render guard. tsc clean, 1807 tests pass. | Feature built |
| 2026-05-29T23:16:19Z | claude+reviewers | Review | Code review (data-security/logic/frontend/oracle). 8 findings accepted+fixed (incl. 1 BLOCKER: SQLite reuse dropped `unreadable`/query-error), 1 rebutted. Fixed full-suite flakiness (VaultPanel.test.ts document-state cleanup). 10/10 stable. See `.reviews/round-1.md`. | Review fix loop complete |
