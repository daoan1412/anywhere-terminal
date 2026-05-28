# Workflow State: add-ai-coding-vault

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
  - [x] **GATE 1: user approved direction** _(skip for trivial)_
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — 4 caps: agent-vault-registry, agent-session-index, vault-session-launch, vault-panel
  - [x] Fill design.md _(escalation-forced: D1-D10 + Interfaces + Risk Map)_
  - [x] Fill tasks.md (11 tasks, dependency-ordered)
- [x] 7. Validation
  - [x] `bun run asm change validate` passes (re-validated after oracle fixes + panel-exclusivity addition)
  - [x] Oracle review — 2 blockers + 5 should-fix, ALL accepted & applied (see Revision Log)
  - [x] **GATE 2: user approved plan** _(user "tiếp tục", 2026-05-28)_

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [x] 2. Execute tasks sequentially in dependency order
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [x] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [x] Type check _(tsc --noEmit clean)_
  - [x] Lint _(biome exit 0; 6 pre-existing warnings in untouched fileTreePanel.css, no errors)_
  - [x] Test _(pnpm test:unit — 1599/1599 pass, 97 files; +88 new vault/manager tests)_
  - [-] E2E _(project.md → E2E: N/A)_
- [x] 5. Review (adaptive — skip for trivial or doc/design-only):
  - [x] Code Review _(4 agents: data-security + contracts clean; logic 3 WARN; frontend 2 WARN + 1 SUGGEST → .reviews/round-1.md)_
- [x] 6. Findings triage: accept/rebut each finding with rationale _(5 WARN accepted+fixed; 1 SUGGEST deferred)_
- [x] 7. Review Fix Loop _(round 1: all 5 accepted WARN fixed; 0 BLOCK → exit. Re-verify: type-check + 1601 tests + lint all pass)_
- [ ] 8. Validation
  - [ ] **Gate: user approved implementation**
  - [ ] Extract knowledge

## Archive

- [ ] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_:
  - [ ] Run deploy command
  - [ ] Run smoke test
- [ ] Apply deltas: `bun run asm change apply`
- [ ] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

**Complexity: standard** — multi-module (PTY-host process scanning + 3rd-party agent session-file parsing + IPC + webview vault UI), novel feature, MEDIUM+ risk, multiple scope options.

**Escalation flags: `unresolved-unknown`, `security-privacy`**
- `unresolved-unknown` → feasibility unverified: reliability of process-table scanning to detect running AI CLI agents; parsing 3rd-party agent transcript/session formats (`~/.claude/**/*.jsonl`, codex SQLite, etc.). Forces Discovery + Design.
- `security-privacy` → reading user AI session transcripts which can contain source code / secrets / PII. Forces full ceremony.
- Required stages = full ceremony (discovery + proposal + specs + design + tasks + validation w/ oracle suggested).

**Prior research (read in Discovery):** `docs/ai-features-warp-cmux.md` (Theme A = Vault, items A1–A9; §6 adoption order; §7 appeal×difficulty matrix) and `docs/PLAN-suggest.md`. "Vault" = cmux's AI-CLI-agent orchestrator. Reference projects under `/Users/huybuidac/Projects/ai-oss/` (cmux, warp, vscode, xterm.js).

**Scope tension to resolve at GATE 1:** full vault (A1–A9) is L+ (>2wk). Need to pick MVP slice (prior research flagged A9→A1→A3→A4 as highest ROI, zero model integration). Gate 1 will present scope options.

**GATE 1 DECISIONS (user, 2026-05-28):**
- **Scope = Vault core (A9 registry + A4 index + A5 fork), agents = Claude + OpenCode + Codex.** NO live detection (A1), NO notifications (A3), NO transcript rendering (A6), NO model. User asked "can we add more agents from cmux later?" → YES: registry-driven; indexable agents in cmux = Claude/Codex/OpenCode/Grok/Pi/RovoDev/Hermes/Antigravity (others are detect-running-only, no history reader). MVP ships 3; registry makes the rest cheap follow-ups.
- **UI = dedicated webview panel modeled on `src/webview/fileTree/FileTreePanel.ts`** (not Quick Pick, not native TreeView). Own search box in-panel.
- **SQLite access (Codex + OpenCode both SQLite) → design decision:** recommend shelling to system `sqlite3 -readonly -json` after WAL copy-to-temp = ZERO new dependency (avoids `better-sqlite3` native rebuild). macOS ships sqlite3; AT is macOS-only. Graceful degrade if absent. (Keeps us OFF the new-dependency flag; confirm at Gate 2.)
- **Appetite: L (~1.5–2 wk)** — 3 agents (2 SQLite + 1 JSONL) + webview panel + IPC + resume/fork wiring.
- Privacy: metadata-only reads, no transcript bodies persisted/shown, no network egress.
- OpenCode specifics being extracted from cmux by librarian (afa8429555372408f, background) → fills the last design gap before tasks.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-28T06:57:05Z | claude | Stage 1 | Triage: standard + flags unresolved-unknown, security-privacy. Created change. | Vault = novel multi-module AI-CLI orchestrator; reads 3rd-party transcripts. |
| 2026-05-28T06:57:05Z | claude | Stage 2 | Discovery done (finder=AT plug-in points, librarian=cmux mechanism→docs/research). Gate 1 approved. | Findings ground the design; user picked scope+UI. |
| 2026-05-28T06:57:05Z | claude | Gate 1 | Scope=Claude+OpenCode+Codex browse/resume/fork; UI=webview panel like file-tree; SQLite via sqlite3 CLI (no new dep). | User answers; appetite L. |
| 2026-05-28T06:57:05Z | claude | Stage 3-6 | Batch-wrote proposal + 4 specs + design (D1-D10) + tasks (11). Validate passed. OpenCode mechanism extracted (research §7-8). | Full ceremony per escalation flags. |
| 2026-05-28T06:57:05Z | claude | Stage 7 | Oracle review: verified 2 blockers vs real code (createSession has no env param; resume must post tabCreated). ALL 7 findings accepted. Applied: +task 1_2 (createSession env), D3 readSqlite status contract, D4 bounded-preview privacy, D5 launch via shell/shellArgs+tabCreated, D6 best-effort+error surfacing, D1 reading-is-per-agent, appetite L+ note. Re-validated. | Independent review; both blockers real. |
| 2026-05-28T06:57:05Z | claude | Gate 2 (refine) | User add: opening vault must hide file-tree + generalize to future panels. Finder mapped webview panel wiring (#webview-layout, .file-tree-hidden, WebviewState). Added D11 + vault-panel exclusivity req + task 4_3 AuxiliaryPanelManager (renumbered open-cmd→4_4). Re-validated. | User requirement during plan review. |
| 2026-05-28T06:57:05Z | claude | Gate 2 | Plan APPROVED by user ("tiếp tục"). Planning phase complete; 13 tasks ready for build. | User approval. |
| 2026-05-28T10:20:51Z | claude | Build 1_1 | types.ts + registry.ts (claude/codex/opencode) + registry.test.ts (8 tests pass). Synced design.md Interfaces: added FlagFragment.valueTemplate (codex `-c model_reasoning_effort=`), sessionStore.pathTemplate + sessionIdSource (satisfy registry spec's required fields). check-types+lint pass. | Build start; spec required path-template/sessionIdSource that design snippet had simplified. |
| 2026-05-28T10:20:51Z | claude | Build 1_2 | createSession options gains optional `env` merged over base/shell-integration env before spawn; +2 tests (98 SessionManager tests pass). check-types+lint pass. | D5 per-session CLAUDE_CONFIG_DIR override. |
| 2026-05-28T10:26:00Z | claude | Build 2_1 | sqlite.ts readSqlite (WAL-safe temp copy + sqlite3 -readonly -json, discriminated {rows,status,error?}, memoized :memory: probe, never throws) + sqlite.test.ts (11 tests). Verified host sqlite3 3.51.0 -json works. check-types+lint pass. | D3 SQLite access. |
| 2026-05-28T10:26:00Z | claude | Build 2_2 | claudeReader.ts (streaming jsonl, early-break after title+model, defensive skip+count) + preview.ts shared D4 bound + tests (10) + 2 fixtures. SCOPE ADD: src/vault/preview.ts(+test) added to task 2_2 to avoid duplicating the privacy bound across 3 readers. check-types+lint pass. | D4/D7/D8 Claude reader. |
| 2026-05-28T10:30:00Z | claude | Build 2_3 | codexReader.ts (threads SQL via readSqlite DI; JSONL fallback on no-db/no-sqlite3; query-error→unreadable, no fallback; row-level skip+count) + test (8) + jsonl fixture. check-types+lint pass. | D3/D8 Codex reader. |
| 2026-05-28T10:30:00Z | claude | Build 2_4 | opencodeReader.ts (session+latest-assistant subquery via readSqlite DI; provider/model+agent from assistant JSON; malformed JSON→entry still listed; no fallback) + test (6). check-types+lint pass. | D3/D8 OpenCode reader. |
| 2026-05-28T10:32:00Z | claude | Build 2_5 | VaultService.list (Promise.allSettled over 3 readers; rejected reader→+1 unreadable; sort modified desc; canFork resolution) + forkSupport.ts (memoized opencode --version semver probe) + test (12). forkSupport unit tests live in VaultService.test.ts per task scope. Full vault suite: 55 tests green. check-types+lint pass. | D2/D8 aggregation + fork gate. |
| 2026-05-28T10:35:00Z | claude | Build 3_1 | LaunchBuilder.build → argv {file,args,cwd,env}; flag fragments emit [flag,value] only when present; codex `-c model_reasoning_effort=` via valueTemplate; claude auth allowlist + captured configDir; VaultLaunchError typed. Injection covered (hostile id stays one inert arg). test (11). check-types+lint pass. | D5/D6/D9 launch synthesis. |
| 2026-05-28T10:35:00Z | claude | Build 3_2 | VaultLauncher.resolve(entryId,mode) → {shell,shellArgs,cwd,env?}; fork guarded on canFork (throws fork-unsupported); unknown id throws unknown-entry (added that code to shared VaultLaunchError in LaunchBuilder.ts — additive). Does NOT spawn. test (5). check-types+lint pass. | D5/D9 entry→createSession mapping. |
| 2026-05-28T10:40:00Z | claude | Build 4_1 | messages.ts: 4 vault IPC interfaces added to both unions (imports VaultListResult type from vault/types). TerminalViewProvider: optional vaultService/vaultLauncher ctor params + requestVaultSessions/vaultResume/vaultFork handlers (resume/fork mirror createTab: createSession+env → tabCreated; catch→error). MessageRouter: optional onVaultSessionsResponse + dispatch case (optional so main.ts compiles pre-4_2). extension.ts: construct VaultService+VaultLauncher, pass to sidebar+panel. Verify=manual (deferred). check-types + 26 provider tests + lint pass. | D5/D6 IPC + host wiring. |
| 2026-05-28T10:42:00Z | claude | Build 4_2 | VaultPanel.ts flat list (badge/title/cwd/relative-time/resume+conditional-fork, client-side search, empty + N-unreadable states; textContent only — untrusted titles, no XSS). vaultPanel.css (theme vars; `.vault-panel.vault-hidden` specificity-based hide, no !important). webviewHtml.ts: #vault-panel hidden sibling + inline VAULT_CSS. main.ts: mount hidden + onVaultSessionsResponse→render. Verify=manual. check-types + esbuild bundle + lint pass. | D10 panel. |
| 2026-05-28T10:48:00Z | claude | Build 4_3 | AuxiliaryPanelManager (register/activate/getActive; structural ClassListLike so testable without DOM) + test (6). WebviewState.auxiliaryPanelActive field. vaultPanel.css: per-position layout slot rules. main.ts: register file-tree+vault, restore persisted active (persist:false). `.vault-hidden`/`.file-tree-hidden` reused (already present). check-types+lint+tests pass. | D11 exclusivity. |
| 2026-05-28T10:50:00Z | claude | Build 4_4 | openVault command (palette + per-view openVault.sidebar/.panel) → focus sidebar + post `openVault`; webview onOpenVault → manager.activate("vault") + panel.requestRefresh. package.json: 3 commands + 2 view/title nav buttons + 2 commandPalette hides. SCOPE ADD: messages.ts (OpenVaultMessage) + MessageRouter (onOpenVault) added to task 4_4 — the host command needs a host→webview message to reach the manager (avoided touching TerminalViewProvider by posting via view.webview directly, like setFileTreePosition). Verify=manual. check-types+lint+package.json valid. | D11 open command. |
| 2026-05-28T11:00:00Z | claude | Verify Gate | All tasks complete. tsc clean; pnpm test:unit 1601/1601 pass (97 files, +88 vault/manager tests); biome exit 0 (6 pre-existing fileTreePanel.css warnings only); E2E N/A. Staged 37 files for review diff. | Gate before review. |
| 2026-05-28T11:00:00Z | claude | Review R1 | 4 specialist agents. data-security + contracts: clean (injection-safe argv verified to execvp; WAL-safe read-only sqlite; metadata-only privacy; IPC/registry/createSession contracts sound). logic: 3 WARN (allSettled sync-throw guard, readline stream.destroy, restore-vault refresh) — accepted+fixed. frontend: 2 WARN (badge className guard, persisted-id coercion) accepted+fixed, 1 SUGGEST (arrow-key row nav) deferred — Tab access already works. 0 BLOCK. Re-verify green. Details: .reviews/round-1.md. NOTE: asm-review-logic agent edited production code during review (VaultService/claudeReader/codexReader/main.ts) — changes verified correct by build agent. | Adaptive review (standard, MEDIUM risk). |
| 2026-05-28T17:01:39Z | claude | Post-build pivot | UX redesign per user: vault is no longer an exclusive panel that replaces the file tree — it is now a persistent **collapsible section stacked directly above the file tree** inside a new `#aux-region` wrapper (both visible). Rewrote D11 + replaced vault-panel "exclusivity" spec req with "stacked collapsible section". DELETED AuxiliaryPanelManager(+test); `auxiliaryPanelActive` → `vaultCollapsed` (default collapsed, persisted). Sash moved to the region; file-tree left/right minimize is now a horizontal header strip (vertical activity-bar strip CSS removed). Added VaultPanel collapse API + header chevron/count + file-tree-header vault toggle button. Tests: +VaultPanel.test.ts (7) +2 FileTreePanel; −AuxiliaryPanelManager.test. Verify: tsc clean, biome exit 0 (3 pre-existing warns), vitest 1604/1604. | User: "vault sai vị trí — cần luôn ở đó, ngay trên file tree, ẩn hiện y như file tree + nút ở header". |
| 2026-05-28T17:30:31Z | claude | Post-build follow-up | Vault freshness + context. (1) Fix empty-list bug: expanding via header/toolbar never fetched — `setCollapsed` now refreshes on the collapsed→expanded transition (matches "refresh on open"). (2) Re-read + re-scope on pane-select / tab-switch via new `SplitTreeRenderer.onActivePaneChange` + `switchTab` → `syncVaultToActivePane`. (3) New "This folder only" toggle (search row) filters client-side to the active pane's cwd subtree; persisted `vaultFolderOnly` (default off); cwd from OSC7 `instance.cwd`. Spec +"Active-folder scope filter" req; D11 extended. Tests +6 (VaultPanel). Verify: tsc clean, biome exit 0, vitest 1610/1610, esbuild OK. Note: live cd-follow deferred. | User: "vault rỗng" + "reload theo đường dẫn của focus pane" + chọn "This folder only" → apply focused pane. |
| 2026-05-29T06:35:00Z | claude | Post-review UX fixes | Two user-reported issues. (1) "This folder only" was a no-op: `contextCwd` was push-only (set at mount/pane-change) and null before OSC7 fired, so `matchesFolder` fell through to show-all. Fix: new `getContextCwd` dep pulled LIVE in `renderList` (→ `getActivePaneCwd`), so toggling scopes immediately once OSC7 has a cwd. (2) Restore left/right activity-bar UX: `#aux-region` now lays out as a ROW for left/right (column for top/bottom), so a collapsed section becomes a thin vertical strip with a rotated `writing-mode: vertical-rl` header, independently per section; `row-reverse` on the right keeps the vault on the window's outer edge. D11 updated. Tests +1 (live-pull). Verify: tsc clean, biome 3 pre-existing warns, vitest 1614/1614, esbuild OK. Can't render UI here — user F5-verifies. | User: "only this folder vô dụng" + "trái/phải đóng lại phải xoay dọc header (giữ UX cũ)". |
| 2026-05-29T06:10:00Z | claude | Review R2 | Full review of the post-pivot placement/freshness/folder work (4 specialists + asm-oracle). data-security + contracts: clean (re-verified launch handler shell-free, static SQL, allowlist scope, IPC/registry/state contracts). **1 BLOCK** (logic + oracle, independent): pane-click vault sync suppressed by the focusin/mousedown race — `focusin` advances `tabActivePaneIds` before the leaf handler's same-pane early-return, so `onActivePaneChange` never fired on a plain pane click → fixed by syncing in the focusin branch. 3 WARN accepted+fixed: `isWithin` root/trailing-sep under-match (W1), count badge total-vs-filtered (W2), no refresh on viewShow (W3). 4 deferred/rebutted: opencode no-sqlite3 (macOS always has sqlite3), both-collapsed empty-state (not a regression), row keyboard nav (round-1 F3), handleVaultLaunch liveness (mirrors accepted createTab). Tests +3 (VaultPanel). Re-verify: tsc clean, biome exit 0, vitest 1613/1613, esbuild OK. Details: .reviews/round-2.md. | User: "review toàn bộ + gọi oracle, tự fix bug nên fix rồi commit". |
