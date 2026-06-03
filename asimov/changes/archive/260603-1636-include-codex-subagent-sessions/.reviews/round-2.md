# Review Round 2: include-codex-subagent-sessions

Date: 2026-06-03T13:37:56Z
Agents resumed: data-security=Lagrange (`019e8d9d-7eff-7a93-92c1-51fae2e32b69`), logic=Banach (`019e8d9d-7f3d-71b2-95d0-0eed01bcdaad`), contracts=Planck (`019e8d9d-7f7c-7f91-8899-c9e8c42cf6dc`)
Verdict: WARN
Counts: BLOCK=0, WARN=2, SUGGEST=0

## Findings

### W3: Unbounded SQLite row reads for root filtering and detail child lookup

- ID: W3
- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: data-security/logic/contracts
- File: `src/vault/readers/codexReader.ts:47`
- Evidence: Re-review sustained round-1 W3. `CODEX_THREADS_UNLIMITED_SQL` and the detail child query still read all archived rows before filtering in memory.
- Impact: Large Codex stores can force full-table metadata reads.
- SuggestedFix: Page bounded chunks or use SQL root exclusion before applying `ROW_LIMIT`; for detail, query direct child ids first and then select only those child rows.
- Status: accepted
- Triage: Accepted but deferred. No BLOCK remains; this WARN is not a trivial review-loop fix because it requires a larger optional-schema SQL/page redesign.

### W7: Direct child timestamp enrichment should prefer `rollout_path` before filename scan

- ID: W7
- Severity: WARN
- Confidence: HIGH
- Priority: P3
- Agent: logic
- File: `src/vault/readers/codexReader.ts:1052`
- Evidence: Re-review found direct child JSONL timestamp enrichment used filename scanning per child even when the child SQLite row included `rollout_path`.
- Impact: Parent detail opens could scan the whole rollout tree once per direct child.
- SuggestedFix: Carry `rollout_path` into the child stub and read that contained path first; only fall back to filename scanning when absent or invalid.
- Status: accepted
- Triage: Accepted and fixed in round 2.
