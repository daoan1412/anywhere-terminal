# Review: nest-workflow-team-sessions — Round 2 (re-review of round-1 fixes)

- **Date:** 2026-05-29
- **Agents resumed:** data-security (a70325b47b4ab590c), logic (a92a2f889fd04d84f), contracts (a9cb0e98492628f5d)
- **Verdict:** WARN
- **Counts:** BLOCK 0 · WARN 2 (new) · resolved 5

## Round-1 finding resolution (confirmed by the reviewers)
- **W1** (canonical team-id) — RESOLVED (logic + contracts).
- **W2** (predicate window) — RESOLVED (logic + contracts): shared `recordTeamIdentity`; both paths decide on the first text-bearing non-meta non-sidechain user record. Edge cases (no-text first user, no user record, late identity) confirmed correct by logic.
- **W3** (member self-synthesizes team group) — RESOLVED for the emitted path (`selfIsMember` gate); the residual forged-id case is split out as N1.
- **W4** (unbounded synthetic timeline) — RESOLVED for the payload (`boundTimeline` + `subagentCount`); residual nested-pageability split out as N2.
- **W5** (manifest size cap) — RESOLVED (data-security): `readManifestJson` (`stat` + 2 MB cap + defensive) at both call sites; confirmed no new traversal/unbounded-read/unhandled-rejection.

## New findings (round 2)

### N1 — Forged `:team:` id resolves under a non-owning / non-leader parent
- **severity:** WARN · **confidence:** HIGH · **priority:** P2 · **agent:** contracts
- **file:** src/vault/readers/claudeReader.ts (`readClaudeTeamDetail`)
- **evidence:** Resolved any safe `parentId` then scanned its project dir for `teamName`; did not verify the parent recorded that teamName or isn't itself a member. `claude:<unrelated>:team:<knownTeam>` would synthesize a group under a non-leader.
- **impact:** Drifts from the leader-only contract; the host trusted a webview-supplied id beyond path containment.
- **suggestedFix:** Stream the parent, compute `selfIsMember` + its `teamName`s, return null unless `!selfIsMember && teamNames.has(teamName)`.
- **status:** accepted · **triage:** Real contract/defense-in-depth gap; cheap. **FIXED** — added `teamContextCollector`, `readClaudeTeamDetail` now validates the parent owns the team (rejects unowned + member parents). Tests: N1 ×2 (unowned parent → null; member parent → null).

### N2 — Synthetic-group `truncated` is not pageable in the nested renderer
- **severity:** WARN · **confidence:** HIGH · **priority:** P3 · **agent:** contracts
- **file:** src/vault/readers/detail.ts (`synthesizeGroupDetail`)
- **evidence:** `truncated` is set when children exceed the limit, but the webview's nested renderer (`renderNestedInto`) renders `timeline` directly with no load-more for nested blocks; a >limit group silently shows the retained slice.
- **impact:** A pathological >400-child group would hide children with no nested load-more.
- **status:** rejected (rebutted) · **triage:** REBUT, with the reviewer's own offered alternative ("define synthetic group details as non-pageable + explicit cap/notice"):
  - Adding nested load-more is a **webview change**, which violates **design.md D1** (the entire change is host-only; the webview is deliberately untouched) and is out of scope.
  - The cap is `MAX_TIMELINE_ITEMS` (400); realistic workflows (≤~30 agents) and teams (a handful) never approach it, so truncation does not occur in practice — the bound is purely a payload-safety backstop (the actual W4 concern).
  - The group **node label already states the true total** (`Workflow: … · N agents` / `Team: … · N members`), so even in the pathological case the user sees the real count — this IS the "explicit cap/notice" the reviewer accepted as an alternative.
  - Documented as an intentional non-pageable contract (design.md D8 note + code comment).

## Session IDs
- data-security: a70325b47b4ab590c
- logic: a92a2f889fd04d84f
- contracts: a9cb0e98492628f5d
