# Workflow State: write-vault-rename-to-store

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
  - [x] **GATE 1: user approved direction** _(fastlane auto-proceed — hybrid confirmed by user)_
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — vault-session-rename MODIFIED + 3 ADDED requirements
  - [x] Fill design.md (D1-D4 + Risk Map + Architecture sequence + Interfaces)
  - [x] Fill tasks.md (4 tasks, dependency-ordered)
- [x] 7. Validation
  - [x] `bun run asm change validate` passes (re-validated after oracle fixes)
  - [x] Oracle review — SHIP-WITH-FIXES; 6 findings triaged, 5 accepted (2 partial), fixes applied to design/tasks/spec
  - [ ] **GATE 2: user approved plan** _(fastlane auto-approve; user requested oracle gate — satisfied)_

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [x] 2. Execute tasks sequentially in dependency order
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [x] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [x] Type check — `pnpm run check-types` clean (0 errors)
  - [-] Lint — Biome skipped (known OOM; gated via tsc + vitest per project convention)
  - [x] Test — `pnpm run test:unit` 2230 pass / 0 fail (+28 new)
  - [-] E2E — N/A (project.md § Commands → E2E: N/A)
- [x] 5. Review _(manual — user runs `/asimov-review-start`; skip for trivial or doc/design-only)_:
  - [x] Code Review — round 1: WARN, 0 BLOCK, 2 WARN + 3 SUGGEST (.reviews/round-1.md)
- [x] 6. Findings triage: all 5 accepted + fixed (no rebuttals) — .reviews/round-1.md Status/Triage
- [x] 7. Review Fix Loop — round 1: all findings fixed, verify gate re-passed (tsc clean, 2232 tests); 0 BLOCK → exit
- [x] 8. Validation
  - [x] **Gate: user approved implementation** _(fastlane auto — full-auto flow)_
  - [x] Extract knowledge _(asm-knowledge-extract spawned; non-blocking)_

## Archive

- [-] Deploy Gate _(project.md § Commands → Deploy: N/A)_:
  - [-] Run deploy command
  - [-] Run smoke test
- [x] Apply deltas: `bun run asm change apply`
- [x] Archive change: `bun run asm change archive`
- [x] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

**Triage (fastlane):** Complexity = **standard**. Escalation flags: `external-store-mutation` (writes agent-owned SQLite DBs — reverses the read-only posture of add-ai-coding-vault + enhance-vault-sessions D1), `unresolved-unknown` (SQLite write mechanism + title-regeneration lifecycle), possible `new-dependency` (if the current read path can't write). → required stages = full discovery + proposal + specs + design + tasks.

**User decision (hybrid, chosen via question):** OpenCode + Codex → native `UPDATE ... title` in SQLite; Claude → keep overlay (VaultCustomNameRegistry) — no field name in Claude JSONL, avoid hacking append-only files.

**Stage-1 signals:** `agent-session-index` spec confirms Codex `threads` table has a real `title` column (id, rollout_path, cwd, title, model, git_branch, ...). No `sqlite`/`better-sqlite3` in package.json → reader uses `node:sqlite` (built-in) or a `sqlite3` CLI — discovery must resolve this (decides write capability + whether a new dep is needed). Prior posture "never write agent files" (add-ai-coding-vault) is what this change deliberately opts out of, for the 2 SQLite agents only.

**Fastlane auto-decisions:**
- GATE 1 → auto-proceed with the **hybrid** direction (user pre-confirmed): opencode/codex native SQLite write, claude overlay. Discovery Options O1-O4 chosen (node:sqlite-only write, keep Claude overlay, native clears overlay, busy_timeout=5000).
- Discovery verified against real source at /Users/huybuidac/Projects/ai-oss: Codex `prefer_existing_explicit_title` (title ≠ first_user_message preserved) + OpenCode `ensureTitle` runs only while title is default → native writes STICK for both. `engines.vscode ^1.105` → host Node 22 → `node:sqlite` write-capable.
- Read path copies DB to temp (sqlite.ts:94) → write needs a NEW live-DB helper (`writeSqlite`), can't reuse read path.

**Escalation flags resolved:** `external-store-mutation` → design D2/D3 + Risk Map (busy_timeout, parameterized, overlay fallback). `unresolved-unknown` (write mechanism + title lifecycle) → resolved in discovery Findings 1-3. `new-dependency` → NOT triggered (built-in node:sqlite, no better-sqlite3).

**Build-time discovery (librarian doc docs/research/20260707-vault-native-rename.md):** Codex keeps an append-only `session_index.jsonl` name index that its OWN rename path mirrors. DECISION: stay Codex DB-only (`threads.title`), do NOT mirror the JSONL index — the vault reads `threads.title` and reconcile preserves it (`prefer_existing_explicit_title`), so display is correct; mirroring the index = appending to an agent-owned append-only file, the fragile pattern the safe-location hybrid avoids. Logged as an ACCEPTED limitation in design Risk Map. Not a pivot (stays within the SQLite-only plan). Confirms node:sqlite/busy_timeout=5000/OpenCode-DB-only are correct.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->
<!-- Author: git user. Get it: git config user.name -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-07-07T00:40:12Z | huybuidac | Plan | Wrote discovery/proposal/specs/design/tasks; validate passed | Fastlane plan for hybrid native rename |
| 2026-07-07T00:40:12Z | huybuidac | Plan | Applied oracle fixes: shared `normalizeVaultCustomName` (F1), `refresh({force})` single-flight bypass (F2), clear-after-native spec scenario (F3), Codex `AND archived=0` (F4), no-checkpoint note (F5), no-create/table-missing→write-error (F6) | Oracle SHIP-WITH-FIXES triage; re-validated |
| 2026-07-07T00:53:00Z | huybuidac | Build | 1_1 writeSqlite (sqlite.ts + 7 tests incl real round-trip) | Live-DB write helper (D2) |
| 2026-07-07T00:53:00Z | huybuidac | Build | 1_2 export normalizeVaultCustomName + CUSTOM_NAME_MAX_LENGTH; registry delegates (+4 tests) | Shared trim/cap for native+overlay (D3, oracle F1) |
| 2026-07-07T00:53:00Z | huybuidac | Build | 2_1 renameOpenCodeSession (session.title), 2_2 renameCodexThread (threads.title AND archived=0) (+7 tests) | Per-agent native writers (D1/D3) |
| 2026-07-07T00:53:00Z | huybuidac | Build | 3_1 VaultService.writeNativeTitle dispatch, 3_2 refresh({force}) in-flight bypass (+5 tests) | Service dispatch + fresh refresh (D1/D4, oracle F2) |
| 2026-07-07T00:53:00Z | huybuidac | Build | 4_1 handleVaultRenameSession routing: normalize→native→overlay fallback (+5 tests) | Handler wiring (D1/D3/D4) |
| 2026-07-07T00:53:00Z | huybuidac | Build | Verify gate: tsc clean, vitest 2230 pass/0 fail; Biome skipped (OOM) | All tasks complete |
| 2026-07-07T01:40:00Z | huybuidac | Review | Round 1: WARN, 0 BLOCK, 2 WARN + 3 SUGGEST | asm-review-master |
| 2026-07-07T01:40:00Z | huybuidac | Triage | Round 1: 5 accepted, 0 rebutted. Details: .reviews/round-1.md | All should-fix, cheap + clearly correct |
| 2026-07-07T01:40:00Z | huybuidac | Fix | W1 force-refresh drain-loop, W2 OpenCode root-scope, S1 writeNativeTitle self-normalize, S2 refresh-catch listCached fallback, S3 busy_timeout 5000→2000; +2 tests; design synced | Round-1 fixes |
| 2026-07-07T01:40:00Z | huybuidac | Fix | Verify gate re-passed: tsc clean, vitest 2232 pass/0 fail | 0 BLOCK remaining → exit fix loop |
| 2026-07-07T01:46:00Z | huybuidac | Archive | Moved "Name normalization and clearing" ADDED→MODIFIED (baseline already had it); folded W2 scope + S3 short-timeout into Native-write-safety req; apply +2~2, archived → 260707-0145 | change apply required MODIFIED for existing req |
| 2026-07-07T01:46:00Z | huybuidac | Archive | Committed 1904883 (no Co-Authored-By); code-review-graph updated | Full-auto flow complete |
