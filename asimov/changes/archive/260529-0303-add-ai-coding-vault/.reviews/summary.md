# Review summary — add-ai-coding-vault

Finding lifecycle across rounds.

## Round 1 (2026-05-28) — vault core
- [L1] sync reader throw bypasses allSettled — accepted/**fixed**
- [L2] readline early-break leaks fd — accepted/**fixed**
- [L3] restored vault rendered empty — accepted/**fixed** (later superseded by the placement pivot)
- [F1] agent id in CSS class — accepted/**fixed**
- [F2] persisted panel id not validated — accepted/**fixed** (superseded: `auxiliaryPanelActive` removed)
- [F3] rows not arrow-key navigable — rejected/deferred

## Round 2 (2026-05-29) — placement / freshness / folder filter pivot
- [B1] pane-click vault sync race — BLOCK, accepted/**fixed** (logic + oracle, independent)
- [W1] `isWithin` root/trailing-sep under-match — WARN, accepted/**fixed**
- [W2] count badge total vs filtered — WARN, accepted/**fixed**
- [W3] no refresh on viewShow — WARN, accepted/**fixed**
- [L3-rebut] opencode no-sqlite3 hides sessions — rejected (macOS always has sqlite3; intentional degrade)
- [F2-rebut] both-collapsed empty-state hug — rejected (not a regression)
- [F3-defer] row keyboard affordance — deferred (carries round-1 F3)
- [O3-defer] handleVaultLaunch liveness re-check — deferred (mirrors accepted createTab pattern)
