# Discovery: fix-opencode-preview-last-message

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Architecture Snapshot (claude vs opencode detail readers) | Done | Explore subagent + direct read |
| External Research (OpenCode message/part schema) | Done | Explore subagent over `/Users/huybuidac/Projects/ai-oss/opencode` |
| Memory Recall | Done | `asm memory search` + `docs/research/20260529-agent-session-transcript-schemas.md` |
| Constraint Check | Done | direct read of reader + test files |

## Key Findings

### 1. The preview is fed by per-agent on-demand **detail readers**

The vault session preview renders a `VaultSessionDetail` (`src/vault/types.ts`) produced host-side, per agent. Spec: `asimov/specs/vault-session-preview/spec.md`. `VaultSessionDetail` carries `firstPrompt`, `recentActivity`, `latestMessage {role,text,timestamp}`, `stats`, and `timeline` (kinds: `message`, `thinking`, `tool`, `subagent`, `subagentSession`, `workflowBoard`, …). The webview renders `detail.timeline` directly (`PreviewController.renderPreviewDetail` → `renderTimelineInto`); there is **no separate "Latest message" DOM section** — the trailing assistant reply is a `{ kind: "message", role: "assistant" }` timeline item. So "AI message cuối cùng không hiện" == that trailing `message` item (and `latestMessage`) is absent from the data.

### 2. Root cause — OpenCode loads only the **head** of the transcript; Claude keeps **head + tail**

- **Claude** (`src/vault/readers/detail.ts:52` `createBoundedRecordBuffer`, head=`DETAIL_HEAD_RECORDS=100`, tail=`DETAIL_TAIL_RECORDS=4000`): streams the whole JSONL but retains the **first 100 + last 4000** records. The final assistant message is in the tail, so `latestMessage` and the trailing `message` item are always present. `claudeReader.detail.test.ts` asserts `latestMessage` == the final AI text.
- **OpenCode** (`src/vault/readers/opencodeReader.ts:469` `readOpenCodeDetail`): fetches rows with `ORDER BY time_created **ASC** LIMIT` for **both** tables — `messages` capped at `DETAIL_MESSAGE_LIMIT=2000` (line 485), `parts` capped at `DETAIL_PART_LIMIT=5000` (line 486). ASC keeps the **earliest** rows; once a session exceeds the cap, the **tail is dropped**. `mapOpencodeRows` only pushes a `message` timeline item when the message has loaded text parts (lines 381-396), so a final assistant message whose text parts fell outside the part window produces **no** trailing item and **no** `latestMessage`.
- The **parts** cap is the practical trigger: a real session accrues many parts per turn (text, reasoning, tool, step-start/finish), so 5000 ASC parts are exhausted by early turns long before the message cap matters — which is why the bug shows up well before 2000 messages, yet short sessions (the unit tests) pass.

### 3. OpenCode upstream schema confirms the fix is safe (reference: `/Users/huybuidac/Projects/ai-oss/opencode`)

- `session` / `message` / `part` tables (`packages/opencode/src/session/session.sql.ts`); `message` and `part` both have `time_created` (ms) and `id`; index `(session_id, time_created, id)` — DESC tail queries are cheap.
- Assistant reply text lives in `part.type === "text"` (non-`synthetic`) (`message-v2.ts`). `role` on the message JSON; synthetic/compaction marked by `summary`/`synthetic` — already excluded by `isSyntheticMessage` + the synthetic-text filter in `mapOpencodeRows`.
- `mapOpencodeRows` already **sorts messages and parts ascending internally** (lines 335-336), so it can be fed an unordered head∪tail union with no logic change — provided rows are de-duplicated first.

### 4. Test surface

- `src/vault/readers/opencodeReader.detail.test.ts` — `mapOpencodeRows` (pure) + `readOpenCodeDetail` (mocked `readSqliteFn` that dispatches by `sql.includes("FROM message"|"FROM part"|"parent_id")`). Splitting one query into head+tail means the mock must match **multiple** `FROM message`/`FROM part` queries.
- `src/vault/readers/claudeReader.detail.test.ts` — reference for the long-session / latest-message assertion to mirror.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| OpenCode detail message read | `ASC LIMIT 2000` (head only) | head **and** tail retained | tail (final assistant msg) dropped on long sessions |
| OpenCode detail part read | `ASC LIMIT 5000` (head only) | head **and** tail retained | tail text parts dropped → no `latestMessage`, no trailing `message` item |
| `mapOpencodeRows` input | assumes single ordered window | tolerate head∪tail union (dedupe) | needs de-dup by id (and part `id` in SELECT) |
| Truncation signal | `truncated` only from `boundTimeline` | set when SQL window dropped middle rows | parity nicety with Claude buffer |

## Options

### Option A — Tail-only (flip `ASC` → `DESC`)
Smallest diff: load the latest 2000 messages / 5000 parts. Fixes the last AI message, but **breaks `firstPrompt` for long sessions** (the first user message falls outside a tail-only window) — violates the spec clause "a long session MUST still surface its first prompt". Rejected.

### Option B — Head + tail windows, mirroring Claude's bounded buffer (Recommended)
Replace each single ASC query with a **head (ASC LIMIT h)** ∪ **tail (DESC LIMIT t)** pair per table; union + de-dupe by `id`; feed the result to `mapOpencodeRows` (which already sorts ascending). `firstPrompt`/early context come from the head, `latestMessage`/recent timeline from the tail — exactly Claude's `createBoundedRecordBuffer` semantics. Set `truncated: true` when a window was saturated. Contained to `opencodeReader.ts` + its test. Recommended: faithful parity, satisfies both spec clauses, low blast radius.

### Option C — Bump the part LIMIT
Raise `DETAIL_PART_LIMIT`. Only postpones the bug (ASC still drops the tail past the cap) and inflates the read. Rejected.

## Risks

1. **Mock-dispatch breakage in `opencodeReader.detail.test.ts`** — splitting into two queries per table makes the existing `sql.includes("FROM message")` matcher ambiguous. *Mitigation:* update the mock to return head vs tail by also matching `ASC`/`DESC` (or `time_created DESC`); add an explicit long-session test.
2. **De-dup correctness on small sessions** — for sessions smaller than head+tail, the ASC and DESC windows fully overlap; without de-dup, `messageCount`/`tokenCount` double-count and timeline items duplicate. *Mitigation:* union by `id` (messages already SELECT `id`; add `id` to the parts SELECT).
3. **Head/tail boundary part alignment** — a message at the dropped middle boundary may have only some parts loaded. *Mitigation:* acceptable (that region is intentionally bounded out); the final assistant message sits well inside the tail window and is fully covered. Sizes chosen so tail parts comfortably cover tail messages.
4. **Genuinely tool-only final turn** — if the last assistant turn has no text part, there is legitimately no AI text to show (true for Claude too) — not a parity gap; out of scope.
