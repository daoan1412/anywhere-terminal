# Workflow State: enhance-vault-sessions

> **Source of truth:** Workflow stages/gates → this file · Task completion → `tasks.md`
>
> **Checkbox states:** `[ ]` pending · `[/]` in progress · `[x]` done · `[-]` skipped/N/A

## Plan

- [x] 1. Context + Triage
  - [x] Read `asimov/project.md`, run `bun run asm change list` + `bun run asm spec list`
  - [x] Choose `change-id`, run `bun run asm change new`
  - [x] Classify complexity + escalation flags → record in Notes
- [x] 2. Discovery
  - [x] Execute workstreams (parallel finder/librarian subagents)
  - [x] Fill `discovery.md` — findings, gap analysis, options, risks
  - [x] **GATE 1: fastlane auto-proceed** — Sidecar rename (Opt A), re-fetch bounded live-follow (Opt A), per-message meta line + branch chip
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — 4 caps (rename, metadata-display, auto-refresh, live-follow)
  - [x] Fill design.md — D1-D6 + interfaces + mermaid + risk map
  - [x] Fill tasks.md — 14 tasks, 4 sections, dependency-ordered
- [x] 7. Validation
  - [x] `bun run asm change validate` passes
  - [x] Oracle review — 7 findings (3 BLOCKER, 3 SHOULD, 1 NICE), all accepted + applied
  - [x] **GATE 2: fastlane auto-approve after oracle triage**

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [x] 2. Execute tasks sequentially in dependency order
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [x] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [x] Type check
  - [-] Lint — biome OOMs on this repo (documented in project memory); gated via tsc + vitest instead
  - [x] Test
  - [-] E2E — not defined in project.md
- [x] 5. Review _(user-requested full-auto flow)_:
  - [x] Code Review — round-1: asm-review-master, WARN, 0 BLOCK / 8 WARN
- [x] 6. Findings triage: accept/rebut each finding with rationale (.reviews/round-1.md § Triage)
- [x] 7. Review Fix Loop _(round 1 only — 0 BLOCK, exit condition met)_
- [x] 8. Validation
  - [x] **Gate: user approved implementation** _(pre-approved: user requested full-auto plan→build→archive→commit)_
  - [x] Extract knowledge — asm-knowledge-extract: 4 topics stored (3 patterns + 1 debugging)

## Archive

- [-] Deploy Gate _(N/A — asimov/project.md § Commands has no Deploy; E2E N/A)_:
  - [-] Run deploy command
  - [-] Run smoke test
- [x] Apply deltas: `bun run asm change apply`
- [x] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

Complexity: standard — 4 vault capabilities, cross-cutting (FS-watch + multi-agent parsers + webview UI), MEDIUM risk (live-follow perf, rename persistence).
Escalation flags: unresolved-unknown (rename persistence per agent format) — forces Discovery + Design.

Scope (4 tasks):
1. Rename AI vault session (codex/claude/opencode).
2. Show model + context per message; show session branch.
3. Auto-update vault list (no manual refresh click).
4. Live-follow preview: auto-scroll if at bottom, new-message indicator if scrolled up.

Refs: old versions at /Users/huybuidac/Projects/ai-oss; claude bundle at $HOME/.local/share/claude/.

### Deferred review follow-ups (round-1 WARN, accepted-deferred — NOT in this change)
- **W1** — Auto-refresh amplification: full cache re-persist + full list push + full DOM `replaceChildren()` per ~300ms burst; Claude reader `stat`s every historical session file. Fix: delta push + single-row patch, decouple persist from push, scroll-anchor on first-visible row id. Bounded today by 300ms debounce + stale-seq coalescing.
- **W2** — Recursive `**/*.jsonl` store watchers uncapped on total-history axis, armed ×2 (sidebar + panel). Fix: recent-activity subtree scoping + share one watcher set across providers. Bounded today (≤8 watchers).
- **W5** — Live-follow rebuilds the whole preview body (≤400 nodes) per append. Fix: incremental tail-append on the follow path. Bounded today (400 cap + fingerprint no-op + bounded getDetail).
- Also suppressed (P4, untriaged): customName not searchable in list query; per-message `model` id format differs (OpenCode `provider/model` vs bare id); scrolled-up shorter-window follow early-return drops tail messages.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->
<!-- Author: git user. Get it: git config user.name -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-07-06T22:47:41Z | huybuidac | Plan | Wrote discovery/proposal/4 specs/design(D1-D6)/14 tasks; validate passed | Standard change, 4 vault capabilities |
| 2026-07-06T22:47:41Z | huybuidac | Plan | Oracle triage: added change-aware watcher (task 1_3), fixed registry wiring→extension.ts, render-signature customName/gitBranch, overlay-clone unit test, live-follow tail-fingerprint, reworded auto-refresh spec | Oracle found 3 BLOCKERs: WatcherPool ignores change events, rename re-render gap, watch targets too shallow |
| 2026-07-06T22:50:00Z | huybuidac | Build | 1_1 types (gitBranch/customName/VaultMessageTokens/message model+tokens); 1_2 VaultCustomNameRegistry + 5 tests green; 1_3 subscribePattern (change-aware) on fsWatcherPool | Foundation. Scope+: added subscribePattern stubs to 2 WatcherPool test doubles in fileTreeHost.test.ts (interface widened) |
| 2026-07-06T23:00:00Z | huybuidac | Build | 2_1 claude branch+per-msg model/tokens; 2_2 codex branch + turn_context model + token_count backfill; 2_3 opencode model/tokens; 2_4 VaultService registry inject + clone-safe overlay + extension.ts wiring | All 349 vault tests green, check-types clean. Codex model via turn_context.payload.model; tokens via token_count.last_token_usage + model_context_window |
| 2026-07-07T06:12:00Z | huybuidac | Build | 3_1 IPC types (done earlier); 3_2 vaultRenameSession handler → setCustomName → overlaid push via _vaultRefreshSeq; 3_3 store watchers (getStoreWatchTargets → subscribePattern → coalesced refresh, armed on resolve, disposed on view dispose); 3_4 live-follow (vaultWatchSession → resolveSessionWatchTargets → debounced getDetail → followUpdate push, at-most-one via _vaultFollowSeq) | check-types clean; 402 vault/provider tests green (+ new VaultService.watchTargets.test.ts). Scope+: exported codexStoreDirs/opencodeStoreDirs from readers + added getStoreWatchTargets/resolveSessionWatchTargets to VaultService (design D4/D5 constraint: reuse reader path helpers, single source of truth) — reader files beyond 3_3 declared scope; watchTargets test file added |
| 2026-07-07T06:30:00Z | huybuidac | Build | 4_1 rename UI (VaultContextMenu "Rename" item + ICON_RENAME + beginInlineRename in vaultListView + VaultPanel.beginRename posting vaultRenameSession + edit-defer guard + customName/gitBranch in render signature); 4_2 branch chip (previewHeader + PreviewController) + per-message model/token meta (renderAtoms.buildMessageMeta + previewTimeline); 4_3 auto-refresh applied with scrollTop preserve (VaultPanel.renderList) + preview left untouched; 4_4 live-follow (PreviewController followUpdate branch + tailFingerprint + atBottom auto-scroll + previewScrollNav "N new messages" pill) | Verify Gate: check-types clean; full suite 2201/2201 green (128 files). Scope+: added icons.ts (ICON_RENAME) + updated VaultPanel.test.ts (menu label list gained "Rename", postMessage mock widened to entryId?: string\|null). Scope correction: vault preview CSS lives in src/webview/vault/vaultPanel.css (bundled via webviewHtml.ts), NOT media/*.css as scoped in 4_2/4_4; FloatingPreviewShell.ts needed no change (pill owned by previewScrollNav via shell.scrollNav) |
| 2026-07-07T06:30:00Z | huybuidac | Build | Verify Gate PASSED (fastlane): tsc --noEmit clean; vitest 2201 pass / 0 fail across 128 files. Biome SKIPPED — known OOM on this repo (documented in project memory: gate with tsc + vitest, sweep unused imports manually). | Build phase complete; next: user-initiated /asimov-review-start |
| 2026-07-07T06:48:00Z | huybuidac | Review | Round 1: asm-review-master → WARN, 0 BLOCK / 8 WARN / 4 suppressed. Report: .reviews/round-1.md | Security posture verified clean; no blockers |
| 2026-07-07T06:50:00Z | huybuidac | Triage | Round 1: 5 accepted+fixed (W3 fingerprint len+suffix, W4 rename-cancel repaint, W6 required token fields, W7 opencode reasoning→output, W8 codex token-reset +regression test), 3 accepted-deferred as follow-ups (W1/W2/W5 perf-scale refactors, bounded today), W8 stale-model sub-point rebutted (turn_context is per-turn). Details: .reviews/round-1.md § Triage | 0 BLOCK → review-loop exits round 1; no re-review |
| 2026-07-07T06:50:00Z | huybuidac | Review | Re-Verify after fixes: tsc clean; vitest 2202 pass / 0 fail (+1 codex regression). Biome skipped (OOM). | Review fix loop complete |
