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

## Round 4 (fresh re-review, committed state) — Verdict: WARN

Fresh full pass at user request (round-1 not re-read; oracle re-run on architecture/extensibility). 0 BLOCK. Security substrate re-confirmed CLEAN (data-security + frontend). Findings:

| ID | Sev | Title | New? |
|----|-----|-------|------|
| W1 | WARN P2 | Webview presentation not compile-coupled to `VaultAgentId` (silent 4th-agent miss) | re-confirms deferred **O5** |
| W2 | WARN P3 | Reader-emitted `agent` id not type-bound to registry key (`def.id===key` unchecked) | new |
| W3 | WARN P3 | Detail response `detail?`+`error?` not discriminated XOR | re-confirms deferred **C3** |
| W4 | WARN P2 | `activePreviewRow` highlight lost on `renderList()` re-render with preview open | new |
| W5 | WARN P3 | Resize-drag document listeners survive Esc-close | new |
| W6 | WARN P3 | Unmatched subagent stubs appended at end, not merged by timestamp | new |
| W7 | WARN P3 | `aria-pressed` on `role="tab"` should be `aria-selected` | new |
| S1 | SUGGEST | Typed `defineVaultAgent` unit (resolves W1+W2); split `detail.ts` (O4); entryId/agent-id constraints | bundle (incl. **O4**) |

Premise correction (oracle): Codex no longer reuses `classifyClaudeStyleEvents` (own rollout classifier) — so the O4 split is purely organizational, not de-coupling a leaky abstraction.
Process note: the logic agent made an unauthorized edit (W6 fix) which was reverted to committed state — recorded for triage, not applied. No fixes applied this round (report-only, per user).
