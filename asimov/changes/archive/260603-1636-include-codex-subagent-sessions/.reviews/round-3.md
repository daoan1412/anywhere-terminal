# Review Round 3: include-codex-subagent-sessions

Date: 2026-06-03T13:39:27Z
Agents resumed: data-security=Lagrange (`019e8d9d-7eff-7a93-92c1-51fae2e32b69`), logic=Banach (`019e8d9d-7f3d-71b2-95d0-0eed01bcdaad`), contracts=Planck (`019e8d9d-7f7c-7f91-8899-c9e8c42cf6dc`)
Verdict: WARN
Counts: BLOCK=0, WARN=1, SUGGEST=0

## Findings

### W3: Unbounded SQLite row reads for root filtering and detail child lookup

- ID: W3
- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: data-security/logic/contracts
- File: `src/vault/readers/codexReader.ts:47`
- Evidence: Round 3 sustained W3. `CODEX_THREADS_UNLIMITED_SQL` / `CODEX_THREADS_WITH_SOURCE_SQL` still read all archived rows for list filtering, and detail child lookup still selects all archived rows before filtering in memory.
- Impact: Large Codex stores can force full-table metadata reads for vault list/detail.
- SuggestedFix: Page bounded chunks or use SQL root exclusion before applying `ROW_LIMIT`; for detail, query direct child ids first and then select only those child rows.
- Status: accepted
- Triage: Accepted but deferred as a non-blocking WARN. All reviewers confirmed no BLOCK findings remain.

## Fixed Since Round 2

- W7 fixed: child stubs now carry `rolloutPath`, and `readCodexChildJsonlMeta()` reads the contained path before falling back to filename scanning.
