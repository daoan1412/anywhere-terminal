# Review Summary — redesign-vault-panel-ui

Finding lifecycle across rounds.

## Round 1 (2026-05-29T12:27:41Z) — Verdict: WARN

| ID | Sev | Title | Status |
|----|-----|-------|--------|
| W1 | WARN | Detail readers materialize whole transcript before bounding | pending |
| W2 | WARN | IPC `limit` not validated → can disable timeline bound | pending |
| W3 | WARN | Agent identity scattered ~6 sites; add-agent partly silent | pending |
| W4 | WARN | Claude subagent→spawn match ambiguous on duplicate descriptions | pending |
| W5 | WARN | Esc closes preview even when only context menu should | pending |
| W6 | WARN | Session-derived `agent` becomes CSS class via regex fallback | pending |
| W7 | WARN | OpenCode `messageCount` counts textless/unknown-role rows | pending |
| S1 | SUGGEST | `entryId` is per-agent string protocol in a universal handle | pending |
| s2-s7 | SUGGEST | 6 suppressed (see round-1.md) | mixed (see below) |

No BLOCK findings. Security surfaces (SQL, path, HTML, clipboard, IPC trust) verified clean.

## Round 2 (re-review) + Round 3 (fixes) — Verdict: APPROVE

All round-1 findings re-reviewed and **Sustained-fixed**: W1, W2, W3, W4, W5, W6, W7, S1, s3.

Round-2 re-review surfaced new items, all resolved in round 3 (confirmed by the raisers):
- **P2** (`truncated` conflated pageable vs source truncation) → fixed: `finalizeDetail` routes source-truncation to `partial`/`limitedReason`. **Sustained-fixed** (contracts).
- **W3-exhaustiveness** (`VAULT_AGENT_IDS` not proven to cover the union) → fixed: union derived from the array + registry `satisfies`. **Sustained-fixed** (contracts, oracle).
- **oracle #4** (hardcoded accent-removal list) → fixed: `VAULT_ACCENTS`-driven. **Closed** (oracle).
- **partial doc residual** (P4) → fixed: types.ts comment broadened.

Resolved-by-design: logic's "stats count retained records on a truncated read" (stats are best-effort per D5/D7; the `partial` notice now signals the limited view).

Deferred (SUGGEST, non-blocking, reviewer-agreed — follow-up before the NEXT agent/transcript format):
- **C3** — model the detail response as `detail | error` XOR.
- **O4** — split the Claude-shaped `detail.ts` substrate from neutral helpers.
- **O5** — unify host↔webview presentation metadata; new accent still needs CSS work (not compile-enforced).

Final state: 0 BLOCK across 3 rounds. Verify gate green — type-check clean, biome exit 0 (2 pre-existing CSS warnings), 1744 unit tests pass (+14 review-fix tests).
