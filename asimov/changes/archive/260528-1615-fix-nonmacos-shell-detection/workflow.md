# Workflow State: fix-nonmacos-shell-detection

> **Source of truth:** Workflow stages/gates → this file · Task completion → `tasks.md`
>
> **Checkbox states:** `[ ]` pending · `[/]` in progress · `[x]` done · `[-]` skipped/N/A

## Plan

- [x] 1. Context + Triage
  - [x] Read `asimov/project.md`, run `bun run asm change list` + `bun run asm spec list`
  - [x] Choose `change-id`, run `bun run asm change new`
  - [x] Classify complexity + escalation flags → record in Notes
- [x] 2. Discovery
  - [x] Execute workstreams (research done in-session prior to skill — folded into discovery.md)
  - [x] Fill `discovery.md` — findings, gap analysis, options, risks
  - [x] **GATE 1: fastlane auto-proceed (Option B — layered resolution)**
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — scenarios only when they pin acceptance beyond the requirement (default = none)
  - [x] Fill design.md _(included: 4 concrete decisions builder must follow)_
  - [x] Fill tasks.md (deps, refs, done, test, files, approach)
- [x] 7. Validation
  - [x] `bun run asm change validate` passes
  - [-] Oracle review _(skipped — LOW risk, no new dep, single boundary)_
  - [x] **GATE 2: fastlane auto-approve**

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [x] 2. Execute tasks sequentially in dependency order
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [x] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [x] Type check — `pnpm run check-types` clean
  - [x] Lint — `biome check src/` no errors (6 pre-existing CSS warnings, unrelated)
  - [x] Test — `pnpm run test:unit` 1531 pass / 0 fail (87 files)
  - [-] E2E — not defined in project.md
- [x] 5. Review (adaptive — skip for trivial or doc/design-only):
  - [x] Code Review — round 1: data-security + contracts + logic agents (see .reviews/round-1.md)
- [x] 6. Findings triage: 1 accepted+fixed (F1 README migration note), 1 rebutted (F2 pre-existing), 2 deferred SUGGEST (F3/F4)
- [x] 7. Review Fix Loop — 0 BLOCK after adjudication; exit (no round 2 needed)
- [/] 8. Validation
  - [ ] **Gate: fastlane auto-approve implementation**
  - [ ] Extract knowledge

## Archive

- [ ] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_:
  - [ ] Run deploy command
  - [ ] Run smoke test
- [x] Apply deltas: `bun run asm change apply`
- [x] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

**Mode: fastlane** — auto-choose at every gate, no user questions.

**Complexity: small** — 4 source files (PtyManager, SettingsReader, package.json, README) + tests, one domain (pty/settings), no new runtime dep, LOW risk.

**Escalation flags: none** — no new dependency (reuse `vscode.env.shell` + manual fallback, no `which`/`find-process`), no API contract, no migration, no security/privacy, single boundary.

**design.md included** despite small: 4 concrete decisions (D1 primary source = `vscode.env.shell`; D2 `validateShell` skips exec-bit on win32; D3 per-platform setting keys; D4 per-platform default args) that the builder must follow exactly — avoids architecture decisions at build time.

**Gate 1 auto-decision (fastlane):** Option B — layered resolution (`vscode.env.shell` primary → platform fallback chain), reuses VS Code's own detection + respects remote hosts and `terminal.integrated.defaultProfile`. Rejected Option A (add `which`/git-bash discovery) to avoid new deps; rejected Option C (only fix fallback chain) — wouldn't respect user profile or remote.

**Worktree note:** `.agents/` tooling is untracked and absent from this worktree; run the CLI via `bun run /Users/huybuidac/Projects/ai-oss/anywhere-terminal/.agents/skills/asimov-core/scripts/asm.ts <args>` from the worktree (operates on the worktree's `asimov/` via cwd).

**References (verified, in-session):** VS Code `src/vs/base/node/shell.ts` (`getSystemShellUnixLike`, `getWindowsShell`=`comspec||cmd.exe`), `vscode.env.shell` API (@types/vscode 1.105 — respects `terminal.integrated.defaultProfile`, works on remote), inshellisense `src/utils/shell.ts` + `isterm/pty.ts` (`shellExists = existsSync || which`, git-bash discovery), opencode `shell.ts` (minimal `$SHELL → platform fallback`), vscode-sidebar-terminal `ConfigManager.getShellForPlatform` (per-platform setting → env → default, NO exec-bit check).

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-28T15:29:52Z | claude | Plan | Stages 1-6 complete (fastlane): triage=small, discovery+proposal+specs+design+tasks written | Full asimov fastlane to archive |
| 2026-05-28T15:45:00Z | claude | Build | Task 1_1 — platform-aware detectShell/validateShell/getShellArgs in PtyManager.ts + tests (31 pass). Synced spec/design to `/bin/sh` last-resort + dropped platform arg from getShellArgs. | RED→GREEN; win32/linux branches injectable |
| 2026-05-28T15:50:00Z | claude | Build | Task 2_1 — added shell.windows + shell.linux to package.json (scope: machine) | per-platform setting keys (D3) |
| 2026-05-28T15:55:00Z | claude | Build | Task 2_2 — SettingsReader selects shell key by platform; detectShell(platform) passthrough + tests (69 pass) | D3 wiring |
| 2026-05-28T16:00:00Z | claude | Build | Task 3_1 — README badge/settings/requirements + auto-detect note | docs-only |
| 2026-05-28T16:00:00Z | claude | Build | Verify Gate: check-types clean, lint no errors (6 pre-existing CSS warns), 1531 tests pass, E2E N/A | gate passed |
| 2026-05-28T16:20:00Z | claude | Build | In-session hardening: `firstNonEmpty()` trims/skips whitespace env vars; `getPlatformShellKey` other-POSIX→shell.linux; `getShellArgs` via path.posix.basename; +Git-Bash/whitespace tests | edge-case robustness |
| 2026-05-28T16:25:00Z | claude | Review | Round 1 (logic+contracts+data-security): verdict WARN, 0 BLOCK. Triage: F1 accepted+fixed (README migration note), F2 rebutted (pre-existing), F3/F4 deferred SUGGEST. Details: .reviews/round-1.md | review chair adjudication |
| 2026-05-28T16:25:00Z | claude | Review | Re-verify after F1 fix: tsc clean, 1536 tests pass, lint clean (4 changed files) | gate passed |
