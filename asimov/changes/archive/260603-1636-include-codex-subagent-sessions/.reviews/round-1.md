# Review Round 1: include-codex-subagent-sessions

Date: 2026-06-03T13:11:52Z
Reviewable lines: 411 production lines changed
Agents spawned: data-security=Lagrange (`019e8d9d-7eff-7a93-92c1-51fae2e32b69`), logic=Banach (`019e8d9d-7f3d-71b2-95d0-0eed01bcdaad`), contracts=Planck (`019e8d9d-7f7c-7f91-8899-c9e8c42cf6dc`)
Agents skipped: frontend
Verdict: WARN
Counts: BLOCK=0, WARN=6, SUGGEST=4

## Findings

### W1: JSONL metadata timestamp is not merged into SQLite child stubs

- ID: W1
- Severity: WARN
- Confidence: HIGH
- Priority: P1
- Agent: contracts/logic
- File: `src/vault/readers/codexReader.ts:1014`
- Evidence: Existing SQLite child stubs are skipped when JSONL parentage metadata is later scanned, so child `session_meta.timestamp` cannot override `created_at_ms` / `updated_at_ms`.
- Impact: Parent previews without a matched spawn event can place Codex children at the wrong fallback timestamp.
- SuggestedFix: Merge JSONL `session_meta.timestamp` into existing child stubs while preserving SQLite title, first message, and agent metadata.
- Status: accepted
- Triage: Accepted. This is directly required by `specs/vault-session-preview/spec.md` timestamp precedence.

### W2: Generic stub title prevents parent spawn prompt fallback

- ID: W2
- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: contracts
- File: `src/vault/readers/codexReader.ts:966`
- Evidence: `codexChildStubFromRow` sets title to `Subagent`; `codexChildTimelineItem` prefers stub title before parent spawn prompt.
- Impact: Edge-linked children without title/first message render as generic `Subagent` even when the parent spawn event contains a useful prompt.
- SuggestedFix: Keep the generic label as the final fallback after child title, first message, and parent spawn prompt.
- Status: accepted
- Triage: Accepted. This is directly required by `specs/vault-session-preview/spec.md` label precedence.

### W3: Unbounded SQLite row reads for root filtering and detail child lookup

- ID: W3
- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: data-security/contracts
- File: `src/vault/readers/codexReader.ts:46`
- Evidence: List and detail helpers query archived threads ordered by updated time without a SQL limit, then filter in JavaScript.
- Impact: Large Codex stores can force full-table reads of thread metadata and first prompts.
- SuggestedFix: Page bounded chunks or use SQL root exclusion before applying `ROW_LIMIT`; detail should query direct child ids first, then select only those child rows.
- Status: accepted
- Triage: Accepted as a performance/privacy improvement. Not fixed in round 1 because the correct SQL/page redesign is larger than a trivial WARN fix and needs careful optional-schema handling.

### W4: JSONL parentage fallback can make cache reuse stale

- ID: W4
- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: logic
- File: `src/vault/readers/codexReader.ts:423`
- Evidence: Cache reuse checks only SQLite/WAL stamps, while a DB-backed read may use JSONL first-line parentage fallback.
- Impact: If JSONL parentage changes while SQLite stamps do not, a cached root list can keep showing stale child/root grouping.
- SuggestedFix: Avoid reusing DB-backed Codex cache unless SQLite exposes parentage, or include a JSONL parentage freshness input when JSONL fallback participates.
- Status: accepted
- Triage: Accepted. A conservative no-reuse path when optional SQLite parentage is unavailable is a bounded fix.

### W5: JSONL fallback is ignored when both SQLite optional parentage surfaces exist but are incomplete

- ID: W5
- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: logic
- File: `src/vault/readers/codexReader.ts:455`
- Evidence: JSONL parentage is only consulted when `!edges.available || !threadRead.hasSource`.
- Impact: A child row with missing SQLite parentage but first-line JSONL parentage could remain visible as a root.
- SuggestedFix: Merge JSONL as an additional source whenever available.
- Status: rejected
- Triage: Rejected. `specs/agent-session-index/spec.md` says DB-present JSONL metadata scan MAY run when SQLite does not expose usable child metadata; it does not require scanning every JSONL when SQLite parentage surfaces are usable, and `design.md` D6 preserves the bounded metadata-only fallback intent.

### W6: JSONL fallback scans run even when one SQLite parentage source is available

- ID: W6
- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: data-security
- File: `src/vault/readers/codexReader.ts:1014`
- Evidence: Detail lookup scans JSONL whenever the thread read is not a query error, even when `thread_spawn_edges` or `threads.source` parentage is available.
- Impact: Detail opens can touch all Codex JSONL files unnecessarily.
- SuggestedFix: Run JSONL parentage fallback only when SQLite parentage is unavailable for that read.
- Status: accepted
- Triage: Accepted. The spec explicitly bounds DB-present JSONL fallback to unavailable SQLite parentage.

### S1: Child ids should be filtered before creating lazy stubs

- ID: S1
- Severity: SUGGEST
- Confidence: MEDIUM
- Priority: P4
- Agent: data-security
- File: `src/vault/readers/codexReader.ts:1039`
- Evidence: Child ids from edges/source/JSONL are formatted into `codex:<childThreadId>` stubs without `isSafeCodexId`; later detail resolution rejects unsafe ids.
- Impact: Malformed child ids can create dead lazy blocks.
- SuggestedFix: Filter child ids with `isSafeCodexId` during parentage collection and before creating stubs.
- Status: accepted
- Triage: Accepted as a small fail-safe improvement.

### S2: Whole-timeline sorting can reorder existing transcript items

- ID: S2
- Severity: SUGGEST
- Confidence: MEDIUM
- Priority: P4
- Agent: logic
- File: `src/vault/readers/codexReader.ts:841`
- Evidence: `orderCodexTimeline` sorts all timeline items by timestamp where present; shared `mergeTimestampedItems` already exists for inserting timestamped extras without reordering the base transcript.
- Impact: Existing timestamped transcript ordering can shift more than necessary.
- SuggestedFix: Keep matched spawn stubs in stream position and merge only unmatched child stubs with `mergeTimestampedItems`.
- Status: accepted
- Triage: Accepted as a small helper reuse and ordering improvement.

### S3: `recentActivity` omits unmatched/partial child stubs

- ID: S3
- Severity: SUGGEST
- Confidence: MEDIUM
- Priority: P4
- Agent: logic
- File: `src/vault/readers/codexReader.ts:835`
- Evidence: Unmatched and partial child stubs increment `stats.subagentCount` and appear in `timeline`, but are not represented in `recentActivity`.
- Impact: Summary activity can omit child sessions shown elsewhere.
- SuggestedFix: Add bounded subagent activity entries for unmatched/partial child stubs, or document and test transcript-only activity behavior.
- Status: rejected
- Triage: Rejected for this change. `specs/vault-session-preview/spec.md` requires `timeline` stubs and `stats.subagentCount`; it does not require recentActivity entries for fallback metadata stubs, and adding them may duplicate non-transcript metadata as activity.

### S4: Cache invalidation coverage does not explicitly test stale version 1

- ID: S4
- Severity: SUGGEST
- Confidence: HIGH
- Priority: P4
- Agent: contracts
- File: `src/vault/VaultCacheStore.test.ts:131`
- Evidence: Tests assert `VAULT_CACHE_VERSION === 2` and reject a future version, but do not explicitly write a stale version 1 Codex cache.
- Impact: Coverage is weaker for the exact regression even though the implementation invalidates it.
- SuggestedFix: Add a focused stale version 1 cache test with Codex entries.
- Status: accepted
- Triage: Accepted as a small coverage improvement.
