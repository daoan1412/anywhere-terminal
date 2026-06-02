## 1. OpenCode detail head+tail retention

- [x] 1_1 Retain head+tail of `message`/`part` rows in `readOpenCodeDetail`
  - **Deps**: none
  - **Refs**: specs/vault-session-preview/spec.md (Bounded detail retains both transcript ends); `src/vault/readers/detail.ts:24-98` (Claude `createBoundedRecordBuffer` head/tail semantics to mirror); docs/research/20260529-agent-session-transcript-schemas.md (OpenCode `session`/`message`/`part` schema, time_created ordering)
  - **Scope**:
    - `src/vault/readers/opencodeReader.ts`
    - `src/vault/readers/opencodeReader.detail.test.ts`
  - **Acceptance**:
    - Outcome: For an OpenCode session whose rows exceed the read window, `readOpenCodeDetail` returns `firstPrompt` = first user message, `latestMessage` = final assistant message text, a timeline containing both the first user and final assistant `message` items, and `truncated: true`. For a session within the window, output is unchanged (no duplicated messages/tokens/timeline items).
    - Verify: unit src/vault/readers/opencodeReader.detail.test.ts
  - **Plan**:
    1. Replace `DETAIL_MESSAGE_LIMIT`/`DETAIL_PART_LIMIT` (lines 28-29) with split budgets: `DETAIL_MESSAGE_HEAD = 100`, `DETAIL_MESSAGE_TAIL = 2000`, `DETAIL_PART_HEAD = 1000`, `DETAIL_PART_TAIL = 4000` (keeps total read cost ~constant); remove the now-unused old constants (manual unused sweep — biome lint OOMs here).
    2. In `readOpenCodeDetail` (lines 485-501) issue, per table, a head query (`ORDER BY time_created ASC LIMIT <HEAD>`) and a tail query (`ORDER BY time_created DESC LIMIT <TAIL>`); add `id` to the `part` SELECT so parts can be de-duplicated. Run all queries (incl. existing `childrenSql`) in one `Promise.all`.
    3. After the head/tail query for each table succeeds, union the raw rows and de-duplicate by `id` into a `Map` (preserves a single row per id); keep `mapOpencodeRows` unchanged — it already sorts ascending and is feed-order agnostic.
    4. Compute `windowTruncated = dedupedMsgs.length >= DETAIL_MESSAGE_HEAD + DETAIL_MESSAGE_TAIL || dedupedParts.length >= DETAIL_PART_HEAD + DETAIL_PART_TAIL` (no overlap ⇒ middle was dropped); after building the detail, set `truncated: true` when `windowTruncated` (OR with the existing `boundTimeline` truncation).
    5. Update the test's `childDetailMock` to keep returning the same rows for both ASC and DESC `FROM message`/`FROM part` queries (existing small-session tests must stay green via de-dup). Add a long-session test whose mock returns the first user message/part only for the ASC (head) queries and the final assistant message/part only for the DESC (tail) queries (disjoint ids sized to fill the head+tail budgets) and asserts firstPrompt, latestMessage = final assistant text, the trailing assistant `message` timeline item, and `truncated: true`. Add a small-session test asserting head/tail overlap produces no duplicate messages/tokens.
    6. Run `pnpm run check-types` and `pnpm run test:unit` until green.
