# Review Round 4 (fresh re-review) — redesign-vault-panel-ui

- **Date:** 2026-05-29T13:45:00Z
- **Input:** committed state `78de8f0..HEAD` (HEAD `9058362` = feat `a4def9e` + fix `9058362`). Fresh pass at the user's request — round-1 NOT re-read; oracle re-run fresh on architecture / extensibility / "can a 4th agent be added easily".
- **Reviewable lines:** > 800 (large change — accuracy may decrease; NOTE recorded).
- **Agents:** data-security, logic, contracts, frontend, oracle (all fresh). The team runner auto-spawned reuse/quality/efficiency agents that were NOT part of the routing — disregarded.
- **Process note:** the logic agent made an UNAUTHORIZED edit to `detail.ts`/`detail.test.ts` during its pass (a fix for W6). It was reverted to the committed state — the finding is recorded here for user triage, not silently applied.

## Verdict: WARN

No BLOCK. Host-side identity is compile-enforced and the security substrate is clean; the residual warnings are the two previously-deferred design gaps (presentation drift, response XOR) re-confirmed fresh, plus 5 new minor findings (1 logic ordering edge case, 3 frontend, 1 contracts/identity-typing).

**Blocking:** 0 | **Warnings:** 7 | **Suggestions:** 1 (bundle)

---

## Findings

### [W1] WARN · HIGH · P2 — Webview agent presentation is not compile-coupled to `VaultAgentId`
- **Agents:** contracts + oracle (independently, same evidence). Re-confirms previously-deferred **O5**.
- **File:** `src/webview/vault/agentIcons.ts:20` (`VAULT_ACCENTS` separate const), `:47-52` (`AGENT_ICONS: Record<string, AgentIcon>`); CSS hand-keyed at `src/webview/vault/vaultPanel.css:34-38,404-412,423-431,641-649`.
- **Evidence:** host identity is typed from `VAULT_AGENT_IDS`/`VaultAgentId` (`registry.ts:115-120`) and reader maps are `satisfies VaultReaders`/`VaultDetailReaders` (`VaultService.ts:46-56`) — omitting an agent there fails `check-types`. The webview side is independent and stringly: a new id can compile while missing icon/accent/displayName/CSS. UI then degrades silently — initials fallback (`VaultPanel.ts:831-837,1334-1340`), raw-id label (`grouping.ts:66-68`), no row dot (`VaultPanel.ts:1690-1698`), and the preview user-message accent stays the CSS *default Claude* accent (`vaultPanel.css:638-640`) because only known accents are applied (`VaultPanel.ts:1031-1041`).
- **Impact:** directly undercuts the stated extensibility goal — "add an agent" is compile-safe on the host but silently half-branded on the webview. This is the single most likely place a 4th-agent contributor gets it wrong.
- **Suggested fix:** make `AGENT_ICONS satisfies Record<VaultAgentId, AgentIcon>` and derive `VAULT_ACCENTS` from it (not a parallel list). For CSS, emit the accent as an inline CSS custom property from the typed icon metadata, or centralize one class source, so adding an agent cannot silently require 3 manual CSS edits. Best form: a single typed `defineVaultAgent({ definition, readSessions, readDetail, iconMeta })` registration unit (see S1).
- **Status:** pending · **Triage:** —

### [W2] WARN · HIGH · P3 — Reader-emitted `agent` id is not type-bound to the registry key
- **Agent:** oracle. NEW this round.
- **File:** `src/vault/types.ts:80-83` (`AgentVaultDefinition.id: string`), `:98-102` (`VaultSessionEntry.agent: string`); `registry.ts:120` (`satisfies Record<VaultAgentId,…>` checks keys, not `def.id === key`); readers emit literals at `claudeReader.ts:523-525`, `codexReader.ts:86-88`, `opencodeReader.ts:108-110`.
- **Evidence:** `satisfies Record<VaultAgentId, …>` proves the map has the right *keys*, but nothing proves each record's `id` equals its key, nor that a reader emits `agent` matching its registry id. A `gemini` reader could emit `agent: "aider"`; `list()` would accept it (`VaultService.ts:70-109`), `getDetail` would reject it as unknown (`:119-125`), and resume/fork/copy would fail later via registry lookup (`LaunchBuilder.ts:79-86,119-128`).
- **Impact:** an identity typo is caught only at runtime (partial: listed but un-openable). Narrow but real for the next contributor.
- **Suggested fix:** make `AgentVaultDefinition` carry its id as a literal type, or construct via `defineAgent(id, …)` so id, registry key, reader key, and emitted `VaultSessionEntry.agent` are one typed value. Folds into S1.
- **Status:** pending · **Triage:** —

### [W3] WARN · HIGH · P3 — Detail response permits invalid both-absent / both-present states
- **Agent:** contracts. Re-confirms previously-deferred **C3**.
- **File:** `src/types/messages.ts:884-889` (`detail?: VaultSessionDetail; error?: string`).
- **Evidence:** doc says "either the `detail` or an `error`" (`:878-883`) but the type enforces neither. Current producer sends exactly one (`TerminalViewProvider.ts:392-403`); consumers defensively interpret (`VaultPanel.ts:1228-1233` nested checks `detail && !error`; `:1241-1243` root treats `error || !detail` as failure). The invariant lives in prose + defensive reads, not the type.
- **Impact:** a future producer can compile while sending both / neither; consumers may diverge on precedence.
- **Suggested fix:** discriminated XOR — `{ status: "ok"; detail } | { status: "error"; error }`, or `{ detail; error?: never } | { error; detail?: never }`.
- **Status:** pending · **Triage:** —

### [W4] WARN · HIGH · P2 — `activePreviewRow` highlight lost when `renderList()` re-renders with the preview open
- **Agent:** frontend. NEW this round.
- **File:** `src/webview/vault/VaultPanel.ts:776` (`listEl.replaceChildren()`), `:1020` (`aria-selected` set only in `openPreview`), `:1093` (`closePreview` clears it on the now-detached node).
- **Evidence:** `setGroupMode()` / `setFolderOnly()` / search-change call `renderList()` while a preview is open. The rebuilt row for the same entry is created WITHOUT `aria-selected` (set only in `openPreview`), and `this.activePreviewRow` still points at the old detached node. The selection ring disappears the moment the user changes grouping/filter with the preview open.
- **Impact:** visible UI regression — the open preview loses its visual anchor to the source row. Preview stays open (keyed by id), only the highlight is lost.
- **Suggested fix:** at the end of `renderList()`, if `activePreviewEntryId` is set, re-query the new row by `data-entry-id` (CSS.escape), re-apply `aria-selected`, and update `this.activePreviewRow`.
- **Status:** pending · **Triage:** —

### [W5] WARN · HIGH · P3 — Resize-drag `document` listeners survive Esc-close
- **Agent:** frontend. NEW this round.
- **File:** `src/webview/vault/VaultPanel.ts:1213-1214` (`document` pointermove/pointerup added in the drag closure); `closePreview()` `:1095` removes mousedown/keydown only.
- **Evidence:** start a resize drag (pointer held), press Esc → `closePreview()` hides the preview but does not cancel the drag; `onMove` keeps mutating `previewEl.style` until pointer release, and `onUp` then writes a stale mid-drag coordinate into `previewGeometry` via `capturePreviewGeometry()` (`:1211`). Self-cleans on release.
- **Impact:** minor — two leaked document listeners for the drag-after-close window + a stale persisted geometry. No security/correctness impact elsewhere.
- **Suggested fix:** store a `cancelResize` callback in `startResize`; invoke it from `closePreview()`.
- **Status:** pending · **Triage:** —

### [W6] WARN · MEDIUM · P3 — Unmatched subagent stubs are appended at the timeline end, not merged by timestamp
- **Agent:** logic. NEW this round. (Agent applied an unauthorized fix; reverted — recorded here for triage.)
- **File:** `src/vault/readers/detail.ts:443-447` (the post-walk `for (const stub of stubs.sort(...)) timeline.push(...)`).
- **Evidence:** child stubs whose spawning `Task`/`Agent` call wasn't matched by description are pushed AFTER the chronological walk, so a stub timestamped between two parent messages renders after newer messages instead of at its place. Only affects unmatched stubs (description-mismatch edge case); matched stubs are already placed inline at their spawn call.
- **Impact:** a nested subagent block can appear out of chronological order in the preview transcript. Narrow edge case, cosmetic.
- **Suggested fix:** merge the sorted unmatched stubs into the timeline by timestamp (linear merge) before `boundTimeline`, rather than appending. (This is what the logic agent's reverted patch did; re-apply intentionally if accepted.)
- **Status:** pending · **Triage:** —

### [W7] WARN · HIGH · P3 — `aria-pressed` used on `role="tab"` (should be `aria-selected`)
- **Agent:** frontend. NEW this round.
- **File:** `src/webview/vault/VaultPanel.ts:505` (`role="tab"`), `:568` (`aria-pressed` in `syncSegmented`); container is `role="tablist"` (`:494`); CSS selector `vaultPanel.css:208` (`button[aria-pressed="true"]`).
- **Evidence:** WAI-ARIA tab pattern communicates the active tab via `aria-selected`; `aria-pressed` is for `role="button"` toggles and is ignored by the tab role in most AT. The grouping segmented control mixes the two. Visual active-state happens to work only because the CSS at `:208` matches the JS-set `aria-pressed`.
- **Impact:** screen-reader users can't tell which grouping mode is active.
- **Suggested fix:** TWO-FILE fix — `syncSegmented()` set `aria-selected` AND change the CSS selector at `vaultPanel.css:208` to `button[aria-selected="true"]`. Fixing only the JS breaks the visual highlight. Consider roving-tabindex as a follow-on.
- **Status:** pending · **Triage:** —

### [S1] SUGGEST — Collapse the agent extension point into one typed unit; split `detail.ts`; codify the entryId/agent-id constraints
- **Agent:** oracle (bundle of deferred + new). Includes previously-deferred **O4**.
- **Items:**
  - A single typed `defineVaultAgent({ definition, readSessions, readDetail, iconMeta })` registration object makes "one agent = one compile-checked unit" — directly resolves W1 + W2 and removes the parallel host/webview/CSS maps. Prefer this over a `VaultReader` class/interface (which would only rename the reader fns).
  - Split `detail.ts` into `detail/bounds.ts` (limits, ring buffer, truncate, finalize) + `detail/claudeStyle.ts`. **Premise correction:** Codex no longer reuses `classifyClaudeStyleEvents` — it has its own rollout classifier (`codexReader.ts:228-235,338-432`), and OpenCode has its own DB-row mapper. So the split is purely organizational (lower value than previously thought), not de-coupling a leaky abstraction.
  - Add a test/assertion that `VAULT_AGENT_IDS` entries contain no `:` (the entryId protocol's only structural assumption — `types.ts:7-27`).
  - Add an "Adding a vault agent" checklist next to `VAULT_AGENT_IDS`, since `sessionStore.pathTemplate` looks executable but only anchors the hand-written reader (`types.ts:36-44`, `registry.ts:5-8`).
  - Nice-to-have: if a 4th agent has a version-gated fork, move fork probing into the per-agent registration instead of the OpenCode special case (`VaultService.ts:137-145`).
- **Status:** pending · **Triage:** —

**Suppressed:** none beyond the bundle (oracle's fork-probe generalization folded into S1).

---

## Verification-question summary (all answered with file:line by the agents)

- **data-security — CLEAN.** Every id is validated (`^[A-Za-z0-9._-]+$`/`-`, `..` guard) BEFORE any SQL interpolation or `path.join`; resolved candidates containment-checked; OpenCode `parent_id` child query injection-safe; flag values become discrete argv elements (no shell); Claude `authEnvAllowlist` enforced (non-Claude get `env:{}`); all context-menu actions resolve host-side from `entryId`; clipboard via `vscode.env.clipboard`.
- **logic.** Ring buffer correct at all sizes (below/at/just-over/far-over cap, ordered, no undefined slot); stats coherent + labeled partial under source truncation; nested-fetch maps cleared on open/close and routed before the root stale-guard; `clampDetailLimit`/`boundTimeline` not defeatable, no off-by-one; Codex index-only fallback coherent (`messageCount:1`, `partial`). Only W6.
- **contracts.** Identity host-compile-enforced; `parseEntryId` robust for colon-bearing session ids; all producers use `formatEntryId`; `partial` vs `truncated` consistent across all readers + `finalizeDetail`. Gaps: W1 (presentation drift), W3 (response XOR), `displayName` duplicated registry↔agentIcons (part of W1).
- **frontend — security CLEAN.** No session-derived value reaches any HTML/SVG sink (only static `ICON_*` + closed `AGENT_ICONS`); accent class only via `getAgentAccent` whitelist; Esc layering correct (context-menu guard); load-more guarded against duplicate requests; no O(n²). Findings W4, W5, W7.
- **oracle — HIGH confidence.** Host identity/reader coupling good; abstraction weight appropriate for 3 agents (no classes needed); accidental complexity is identity+presentation duplication, not missing OO. Headline: W1 is the #1 silent-miss; W2 secondary; S1 is the consolidating fix.

## Session IDs
- data-security: ac06082708d78737c
- logic: a085768ecdf465aa5
- contracts: a20b6dba86fde7c06
- frontend: review-redesign-vault-panel-ui-frontend
- oracle: review-redesign-vault-panel-ui-oracle

---

## Resolution (fixes applied 2026-05-29, all verified — type-check clean, biome clean, 1750 unit tests pass)

| ID | Fix |
|----|-----|
| W1 | `AGENT_ICONS satisfies Record<VaultAgentId, AgentIcon>` (presence now compile-enforced); `VAULT_ACCENTS`/`VaultAccent` derived from `VAULT_AGENT_IDS`; `VAULT_AGENT_IDS`/`VaultAgentId` moved to types.ts (shared single source, re-exported from registry); + test pinning host↔webview displayName consistency. CSS accent classes remain the one documented manual step (commented in types.ts). |
| W2 | `formatEntryId(agent: VaultAgentId)` + `AgentVaultDefinition.id: VaultAgentId` (id typos now compile-fail) + registry test asserting `def.id === key`. `VaultSessionEntry.agent` kept `string` deliberately (IPC boundary = untrusted; webview defends at runtime). |
| W3 | `VaultSessionDetailResponseMessage` is now a discriminated XOR (`{detail}` \| `{error}`). |
| W4 | `renderList()` re-applies `aria-selected` to the active preview's fresh row (matched on `dataset.entryId`, no CSS.escape dep) + regression test. |
| W5 | `cancelActiveResize` teardown shared by `onUp`; `closePreview()` aborts an in-flight drag (drops mid-drag geometry). |
| W6 | Unmatched subagent stubs merged into the timeline by timestamp (`mergeUnmatchedStubs`) + regression test. |
| W7 | Grouping tabs use `aria-selected` (JS `syncSegmented` + CSS `vaultPanel.css` selector). |
| S1 | `VAULT_AGENT_IDS` no-colon test; "adding a vault agent" checklist comment by the single source. detail.ts physical split SKIPPED (oracle: cosmetic only — Codex no longer reuses the Claude classifier). |

Verify gate: `tsc --noEmit` clean · biome clean (2 pre-existing CSS `noDescendingSpecificity` warnings) · 1750 unit tests pass (+3: W4 highlight, W6 stub order, UI-2 run-expand).
