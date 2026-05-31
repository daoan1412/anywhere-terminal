# Review Round 2 (re-review) — redesign-vault-panel-ui

- **Date:** 2026-05-29T13:00:00Z
- **Input:** round-1 fixes (uncommitted on top of a4def9e), re-reviewed by the same 5 agents (resumed via SendMessage).
- **Verify before re-review:** type-check clean · biome exit 0 (2 pre-existing CSS warnings) · 1740 unit tests pass (+10).

## Round-1 findings — re-review verdicts

| ID | Round-1 sev | Verdict | Reviewer |
|----|------|---------|----------|
| W1 | WARN | **Sustained-fixed** — bounded head+tail ring buffer; verified ring math + firstPrompt survival | data-security, logic |
| W2 | WARN | **Sustained-fixed** — `clampDetailLimit` in getDetail (Infinity/NaN/≤0→undefined, cap 5000) | data-security, contracts |
| W3 | WARN | **Partially fixed → completed in round 3** — host resolution paths compile-enforced; exhaustiveness gap closed in R3 | contracts, oracle |
| W4 | WARN | **Sustained-fixed** — `subagentCount = max(spawnCalls, totalStubs)`; no double-count | logic |
| W5 | WARN | **Sustained-fixed** — Esc guard `!this.contextMenuEl`; listener order correct | frontend |
| W6 | WARN | **Sustained-fixed** — `getAgentAccent` whitelist; no session string reaches classList | frontend |
| W7 | WARN | **Sustained-fixed** — valid-role + user-text-only counting | logic |
| S1 | SUGGEST | **Sustained-fixed** — `formatEntryId`/`parseEntryId` centralize the handle | contracts, oracle |
| s3 | SUGGEST | **Sustained-fixed** — Codex partial `messageCount:1` + latestMessage | logic |

## New findings raised during round-2 re-review

### [P2-r2] `truncated` conflated pageable vs source truncation — FIXED (round 3)
- **Severity:** WARN · **Confidence:** HIGH · **Agent:** contracts
- **Evidence:** the W1 fix OR-ed the reader's source-truncation (head+tail dropped the middle, irreversible) into `VaultSessionDetail.truncated`, whose contract means "older timeline items dropped to stay within the requested bound" (i.e. recoverable by load-more). A load-more client would keep requesting larger limits with no recoverable middle.
- **Status:** accepted → **fixed round 3**: new `finalizeDetail` routes source truncation to `partial` + `limitedReason` (SOURCE_TRUNCATED_REASON); `truncated` stays pageable-only. Both readers use it.

### [logic-r2] Stats count retained records on a truncated read
- **Severity:** WARN · **Confidence:** — · **Priority:** P3 (conditional) · **Agent:** logic
- **Evidence:** on a >4100-record (source-truncated) read, `messageCount`/`toolCount`/`subagentCount` count retained records, not full-session totals.
- **Status:** **Accepted-by-design.** Stats are declared best-effort/approximate (design D5/D7); the alternative reintroduces the W1 OOM (reading the whole file). The new `partial` + `limitedReason` notice (P2-r2 fix) now also signals to the user that this is a limited view, mitigating the concern. Affects only pathological huge sessions.

### [W3-exhaustiveness-r2] `satisfies readonly VaultAgentId[]` doesn't prove the array covers all union members — FIXED (round 3)
- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P3 · **Agent:** contracts (+ oracle #2)
- **Status:** accepted → **fixed round 3**: union now DERIVED from the array (`type VaultAgentId = (typeof VAULT_AGENT_IDS)[number]`), moved to registry.ts, registry literal `satisfies Record<VaultAgentId, AgentVaultDefinition>`. Adding an id is one edit; omitting reader/registry entry fails to compile.

### [oracle #4-r2] `applyPreviewAgentAccent` hardcodes the 3 removal classes — FIXED (round 3)
- **Severity:** SUGGEST · **Agent:** oracle
- **Status:** accepted → **fixed round 3**: derived from `VAULT_ACCENTS` (which also derives `VaultAccent`).

### [C3] response `detail|error` not modeled as XOR — DEFERRED
- **Severity:** SUGGEST · contracts confirmed deferral is acceptable, non-blocking (producers send exactly one). Left for a follow-up.

### [oracle O4 / O5] split detail.ts; further presentation centralization — DEFERRED
- **Severity:** SUGGEST · oracle confirmed deferral is reasonable — do before the NEXT transcript format / agent, not this merge.

## Round-3 confirmation (2026-05-29T13:30:00Z)

Round-3 fixes (finalizeDetail truncated/partial split; VaultAgentId derived-from-array + registry coupling; VAULT_ACCENTS-driven accent cleanup) re-confirmed by the raisers:

- **contracts:** P2 **Sustained-fixed**; W3-exhaustiveness **Sustained-fixed**. One trivial residual (WARN/P4): the `partial` field doc comment still said "index only" → **fixed** (types.ts comment broadened to cover source-truncation too). C3 still deferred (acceptable).
- **oracle:** #2 (registry/VaultAgentId coupling) **closed**; #4 (accent cleanup) **closed**. Nothing merge-blocking. O4/O5 correctly deferred to before the next agent/transcript format. One acknowledged risk: a future 4th agent still needs coordinated UI icon/accent/CSS work that is NOT host-compile-enforced — accepted as presentation debt (does not affect list/detail resolution).

## Net
No BLOCK at any point across 3 rounds. All round-1 findings Sustained-fixed; all round-2-surfaced WARNs fixed in round 3 (except the stats-on-truncated note, accepted by design); the `partial` doc residual fixed. Deferred (SUGGEST, non-blocking, by reviewer consensus): C3 (response XOR type), O4 (split Claude-shaped detail.ts), O5 (host↔webview presentation-metadata unification + CSS-accent debt).

**Final verdict: APPROVE.** Verify gate green — type-check clean, biome exit 0 (2 pre-existing CSS warnings), 1744 unit tests pass (+14 from review fixes).
