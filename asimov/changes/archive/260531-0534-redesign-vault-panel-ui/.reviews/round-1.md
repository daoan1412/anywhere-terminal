# Review Round 1 — redesign-vault-panel-ui

- **Date:** 2026-05-29T12:27:41Z
- **Diff under review:** commit `a4def9e` (`git diff a4def9e~1..a4def9e`)
- **Reviewable lines:** ~5.4k added across reviewable src files (LARGE — accuracy caveat noted)
- **Agents spawned:** data-security, logic, contracts, frontend, oracle (architecture/extensibility, per user request)
- **Agents skipped:** none
- **Verdict:** WARN — no BLOCK. Change is secure (no SQL injection / path traversal / HTML injection found) and functional; warnings are robustness (unbounded detail read + unvalidated `limit`) and extensibility hardening before the next agent.
- **Counts:** BLOCK 0 · WARN 7 · SUGGEST 1 (+6 SUGGEST-level suppressed)

---

## Findings

### [W1] Detail readers materialize the entire transcript before bounding
- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P2
- **Agent:** data-security + logic (merged)
- **File:** `src/vault/readers/claudeReader.ts:266-294` (`streamClaudeRecords`); `src/vault/readers/codexReader.ts:422-450` (`streamCodexRecords`)
- **Evidence:** Both push every parsed JSON object into a `records[]` array, then hand the full array to the classifier. Only the *output* timeline is bounded (`boundTimeline`); the intermediate fully-materialized record array is not. The Claude reader's own comment notes "a 86MB file is common." (OpenCode's detail path is SQL-`LIMIT` bounded; these two are not.)
- **Impact:** Opening the preview of a very large Claude/Codex transcript parses the whole file into heap at once (an 86MB JSONL → several hundred MB of JS objects) inside the shared extension-host process — can freeze or OOM-crash the host. User-initiated, single-shot, the user's own data → WARN not BLOCK.
- **Suggested fix:** Cap the stream by record count (mirroring OpenCode's `DETAIL_MESSAGE_LIMIT`) or a byte budget, or do a head+tail bounded read (head for `firstPrompt`, tail for `latestMessage`/recent activity), surfacing `truncated: true`.
- **Status:** pending
- **Triage (chair recommendation):** ACCEPT — real robustness risk; fix alongside W2 (shared "bound the detail read" theme).

### [W2] `limit` from IPC is not validated → can disable the timeline bound
- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P2
- **Agent:** contracts
- **File:** `src/providers/TerminalViewProvider.ts:~596` (handler) → `src/vault/VaultService.ts:115-131` (`getDetail`) → `src/types/messages.ts:360-365` (contract)
- **Evidence:** The host forwards `limit` with only `typeof message.limit === "number"`. `boundTimeline(items, Infinity)` → `Math.max(1, Infinity)` = Infinity → returns all items untruncated; `NaN` slips through similarly. A forged/buggy webview message disables the documented bound.
- **Impact:** Violates the "bounded detail" contract; combined with W1, lets a single message turn an on-demand preview into an unbounded transcript load.
- **Suggested fix:** Clamp at the trust boundary (host handler or `getDetail`): require `Number.isFinite`, floor to an int, cap to a max/step policy before invoking readers.
- **Status:** pending
- **Triage (chair recommendation):** ACCEPT — cheap trust-boundary hardening; pairs with W1.

### [W3] Agent identity is scattered across ~6 sites; adding a 4th agent is partly silent
- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P3
- **Agent:** contracts + oracle (merged) — **the user's headline concern (extensibility)**
- **File:** `src/vault/VaultService.ts:36-49,63-67,125-133` (`defaultReaders`, `defaultDetailReaders`, positional `READER_LABELS`, `Promise.allSettled` order, `getDetail` switch); webview duplicates in `src/webview/vault/VaultPanel.ts` (`AGENT_LABELS`), `src/webview/vault/grouping.ts` (`AGENT_DISPLAY`, `ACCENTS`), `src/webview/vault/agentIcons.ts` (`AGENT_ICONS`), `src/webview/vault/vaultPanel.css` (accent classes). `src/vault/registry.ts` is authoritative only for launch/resume.
- **Evidence:** To add (e.g.) Gemini CLI a dev must touch ~13 places. Type-enforced: the reader interfaces + default objects. **Silently forgettable:** `READER_LABELS` positional alignment, `Promise.allSettled` inclusion, `getDetail` switch case, and every webview label/icon/accent/CSS map. Missing the `getDetail` case → list rows resolve but preview returns "Session not found"; missing/reordering `READER_LABELS` → mislabeled "unreadable" reasons.
- **Impact:** At 5-6 agents a missing map/switch produces partial support rather than a compile error.
- **Suggested fix:** One shared agent-definition record keyed by agent id (extend `registry.ts`); derive list readers, detail readers, labels, accents, display names from it. `list()` iterates registered readers; `getDetail` dispatches through the record. Use `satisfies Record<AgentId, …>` / an `AgentId` union for compile-time enforcement.
- **Status:** pending
- **Triage (chair recommendation):** ACCEPT as a *refactor-before-next-agent* (not blocking this change). Sizeable; STOP and let user decide scope/timing.

### [W4] Claude subagent→spawn matching is ambiguous for duplicate descriptions
- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P3
- **Agent:** logic
- **File:** `src/vault/readers/detail.ts:289-309` (consume), `:344-347` (append leftovers), `:369-378` (`matchStub`)
- **Evidence:** Each `Agent`/`Task` call consumes the first stub whose trimmed `description` matches (else first `agentType`). If two subagents share a description, or one description repeats across spawn calls, placement depends on stub array order. An unmatched real child leaves a plain `subagent` step AND is appended later as a `subagentSession` → the same subagent can be double-counted in `subagentCount`.
- **Impact:** Misleading nesting placement and subagent count in ambiguous transcripts. No crash.
- **Suggested fix:** Prefer a stable spawn id when available; for duplicate descriptions disambiguate by timestamp/order; avoid counting both a plain spawn step and an appended stub for the same child.
- **Status:** pending
- **Triage (chair recommendation):** ACCEPT (cheap correctness on counts/placement) — but verify against real data; low real-world frequency.

### [W5] Esc closes the preview even when only the context menu should dismiss
- **Severity:** WARN · **Confidence:** HIGH · **Priority:** P3
- **Agent:** frontend
- **File:** `src/webview/vault/VaultPanel.ts:1277-1283` (`onPreviewDocKeyDown`)
- **Evidence:** With both the context menu and preview open (right-click a row while preview is visible — the row click-target keeps the preview open), one Esc fires both the menu's and the preview's keydown handlers; both close.
- **Impact:** Minor UX regression — two layers dismiss on a single Esc.
- **Suggested fix:** In `onPreviewDocKeyDown`, `if (this.contextMenuEl) return;` so the menu's own handler consumes that Esc first.
- **Status:** pending
- **Triage (chair recommendation):** ACCEPT — trivial, isolated.

### [W6] Session-derived `agent` string becomes a CSS class via a regex fallback
- **Severity:** WARN · **Confidence:** MEDIUM · **Priority:** P3
- **Agent:** frontend
- **File:** `src/webview/vault/VaultPanel.ts:~1039-1041` (`applyPreviewAgentAccent`), `~1694` (`renderRow` dot)
- **Evidence:** `getAgentIcon(agent)?.accent ?? (/^[a-z0-9-]+$/i.test(agent) ? agent : undefined)` lets an unmapped, session-derived `agent` value become a `vault-preview--<agent>` / `vault-row-dot--<agent>` class suffix. Cannot inject HTML (it's `classList.add`), but a crafted agent id colliding with a CSS suffix could apply unexpected styles. Contradicts the codebase's strict "never derive from session data" rule.
- **Impact:** Low practical (no CSS rule matches arbitrary suffixes today), but a hardening gap inconsistent with the security posture.
- **Suggested fix:** Whitelist the three known accents (reuse `ACCENTS` from grouping.ts); drop the regex fallback. A future agent is added to the closed map anyway (see W3).
- **Status:** pending
- **Triage (chair recommendation):** ACCEPT — trivial; aligns with the project's injection rule.

### [W7] OpenCode `messageCount` counts textless / unknown-role rows
- **Severity:** WARN · **Confidence:** MEDIUM · **Priority:** P4
- **Agent:** logic
- **File:** `src/vault/readers/opencodeReader.ts:268-294` (`messageCount++` at :273 before the text check; role defaults to `user` for any non-`assistant`)
- **Evidence:** Any non-synthetic row increments `messageCount` regardless of whether it has visible text or a valid role (a tool-result-only user row, malformed/empty row, or unknown role all count). Claude's classifier counts user messages only when text is present → cross-reader inconsistency.
- **Impact:** `stats.messageCount` slightly inflated / inconsistent across agents. Cosmetic.
- **Suggested fix:** Require `role ∈ {user,assistant}`; count user rows only when visible text exists, assistant rows when text or a visible tool/subtask/reasoning part exists.
- **Status:** pending
- **Triage (chair recommendation):** ACCEPT if cheap, else defer — stat-only, non-blocking.

### [S1] `entryId` is a per-agent string protocol inside a "universal" handle
- **Severity:** SUGGEST · **Priority:** P4
- **Agent:** oracle
- **File:** `src/vault/VaultService.ts:115-122` (first-colon split), `src/vault/readers/claudeReader.ts:309-325` (composite `:subagent:` interpretation)
- **Evidence:** `getDetail` splits on the first colon; Claude then reinterprets a nested `:subagent:` marker inside the remaining session id. Safe today, but nested identity is a per-agent string convention hidden in a supposedly universal handle.
- **Impact:** Grows fragile as more agents invent their own sub-handle syntax.
- **Suggested fix:** Centralize `formatEntryId`/`parseEntryId`; for nested sessions use structured fields or an opaque encoded token. Keep `<agent>:<sessionId>` for top-level rows.
- **Status:** pending
- **Triage (chair recommendation):** ACCEPT as part of the W3 extensibility refactor (do together, before the next agent).

---

## Suppressed (SUGGEST-level, 6 — listed for completeness per user's "careful review" ask)

- **[s2] OpenCode timestamp ties preserve phase order, not source chronology** — `opencodeReader.ts:266-342` builds all message items, then all parts, then children; stable sort tie-break by push-index can place a same-`time_created` tool call after the message. (logic, SUGGEST/MEDIUM)
- **[s3] Codex partial detail renders 1 message but reports `messageCount: 0`** — `codexReader.ts:531-543`. Internal stat/timeline inconsistency. (logic, SUGGEST/HIGH)
- **[s4] Detail response type allows both/neither `detail`+`error`** — `messages.ts:884-889` documents XOR; model as a discriminated union. (contracts, SUGGEST/MEDIUM)
- **[s5] `detail.ts` mixes neutral helpers with Claude-specific classifier code** — split before adding more readers. (oracle, SUGGEST)
- **[s6] Presentation metadata as parallel maps; `applyPreviewAgentAccent` can leave stale unknown classes** — centralize agent UI metadata. (oracle, SUGGEST)
- **[s7] Expanded nested sub-sessions briefly flash "Loading…" on list re-renders** — cosmetic; the frontend agent concluded no data loss. (frontend, SUGGEST)

---

## Clean (verified, no finding)

- SQL injection: every `${sessionId}`/`${parentId}` embed gated by an anchored alphanumeric+`_-` regex; sqlite3 CLI runs via argv (no shell). SAFE.
- Path traversal: `isSafeSessionId`/`isSafeCodexId` + per-candidate `path.relative` containment on every Claude/Codex resolve. Composite `:subagent:` parts each re-validated. SAFE.
- HTML injection: all session-derived text rendered via `textContent`; all 22 `innerHTML` sinks source from static `ICON_*` constants or the closed `AGENT_ICONS` map. SAFE.
- Clipboard: host-side `vscode.env.clipboard`; resume command shell-quoted and only copied, never executed. SAFE.
- Context-menu paths: host re-resolves via `VaultService.list()` find-by-id; webview supplies `entryId` only. SAFE.
- `firstPrompt`/`latestMessage` captured independently of the bounded tail (verified across all three classifiers).

---

## Session IDs (for re-review resume)
- data-security: `review-redesign-vault-panel-ui-data-security` (a49287abaf7d39f70)
- logic: `review-redesign-vault-panel-ui-logic` (a88b37e3771ccac76)
- contracts: `review-redesign-vault-panel-ui-contracts` (abfe1d80289c4b303)
- frontend: `review-redesign-vault-panel-ui-frontend` (ab69c7131e4a552fc)
- oracle: `review-redesign-vault-panel-ui-oracle` (a6bff3d27082fda53)
