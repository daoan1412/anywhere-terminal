# Workflow State: preview-pasted-images

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
  - [x] **GATE 1: user approved direction** _(fastlane auto-choice: Option B)_
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — scenarios only when they pin acceptance beyond the requirement (default = none)
  - [x] Fill design.md _(standard or escalation-forced — skip if LOW risk + no escalation flags)_
  - [x] Fill tasks.md (deps, refs, done, test, files, approach)
- [x] 7. Validation
  - [x] `bun run asm change validate` passes
  - [-] Oracle review _(available — MEDIUM risk; skipped per fastlane; safety net = existing hover test suites + manual verify gate)_
  - [x] **GATE 2: user approved plan** _(fastlane auto-approve)_

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [/] 2. Execute tasks sequentially in dependency order _(7 code tasks done; 4_1 manual E2E pending — needs user to run Extension Dev Host)_
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [/] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [x] Type check — `pnpm run check-types` pass
  - [/] Lint — full-repo `biome check` OOMs (known env issue); scoped run on all 13 touched files CLEAN
  - [x] Test — `pnpm run test:unit` 2069 pass / 0 fail (121 files; +13 new: PastedImageStore 7, imagePlaceholderParser 4, showImage 2, attachImageHover 3, CSP 1)
  - [-] E2E — not defined in project.md
- [x] 5. Review (adaptive — skip for trivial or doc/design-only):
  - [x] Code Review — asimov-review, 2 rounds → APPROVE (.reviews/round-1.md, round-2.md, summary.md)
- [x] 6. Findings triage: accept/rebut each finding with rationale
- [x] 7. Review Fix Loop — round 1: fixed B1 (BLOCK) + W1 (WARN); rebutted F1/F4 (overruled→sustained), F2 won't-fix; round 2: APPROVE (0 outstanding)
- [x] 8. Validation
  - [x] **Gate: user approved implementation** _("archive thôi" — approved; manual E2E partially done by user)_
  - [/] Extract knowledge

## Archive

- [ ] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_:
  - [ ] Run deploy command
  - [ ] Run smoke test
- [x] Apply deltas: `bun run asm change apply`
- [x] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

**Mode: fastlane** — auto-choose at every gate, no user questions, full artifact quality. Each auto-decision recorded below.

**Complexity: standard** — multiple modules (paste capture in webview, hover/match detection on terminal text, preview overlay UI), MEDIUM risk, multiple options for correlating CLI-emitted `[Image #x]` placeholder with pasted bytes.

**Escalation flags: `unresolved-unknown`** — feasibility of correlating the CLI's own `[Image #x]` placeholder with the user's pasted image bytes is unclear; how the pasted image reaches the CLI (clipboard read vs bracketed-paste stream) must be determined in discovery. Forces Discovery + Design.

**Required stages:** full Discovery + proposal + specs + design + tasks.

**GATE 1 auto-decision (fastlane):** Chose Option B — capture the clipboard image in the webview at paste time (the bytes never traverse the PTY; all three CLIs read the OS clipboard out of band), cache per-terminal as object URLs, detect `[Image #N]`/`[Image N]` via a third link provider, render through the reused hover popup/controller with no IPC. Rejected Option A (read CLIs' on-disk caches) as Claude-only + cross-boundary fs + fragile.

**Key feasibility resolution:** image preview is entirely webview-side — no new IPC messages, no extension-host round-trip. The `unresolved-unknown` (how to correlate the placeholder with bytes) resolves to: capture at paste time + recency-first correlation rule (D3), with multi-image/renumber drift documented as a known limitation.

**Hard constraint found:** webview CSP is `default-src 'none'` with no `img-src` → must add `img-src ... blob: data:` (D6) or previews silently fail.

**KNOWN ISSUE (open at archive, deferred per user "archive thôi"):** resizing the image preview via the SE bottom-right grip reportedly errors in the live webview. NOT reproduced in jsdom — 43 popup tests pass including an image-resize-with-load-race test (`HoverPreviewPopup.test.ts`). The resize gesture (`beginPointerGesture`) is shared with the already-shipped file-preview popup and is fully try/catch-wrapped, so the throw is browser-only. Error text + whether the file-preview popup also errors were not captured. Follow-up: capture the DevTools console error, then fix in a new change (likely in the shared gesture code if file preview errors too, else in the image positioning path).

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-06-02T15:26:22Z | claude (fastlane) | Plan | Discovery + proposal + spec (pasted-image-preview, 6 reqs) + design (D1-D6) + tasks (8) written | Planned image hover-preview; resolved feasibility to webview-side capture |
| 2026-06-02T15:41:28Z | claude (fastlane) | Build | Tasks 1_1–3_3 implemented (CSP+CSS, PastedImageStore, popup showImage via renderShell, controller attachImageHover via scheduleHover, placeholder parser+provider, TerminalFactory wiring, main.ts paste capture) | Image hover-preview feature |
| 2026-06-02T15:41:28Z | claude (fastlane) | Verify | check-types pass; test:unit 2069/0; biome scoped-clean (full OOM, env); E2E N/A | Verify gate |
| 2026-06-02T15:55:00Z | claude (fastlane) | Review | Round 1: 1 BLOCK (B1 stale file-state bleed into image hover) + 1 WARN (W1 link.text) accepted; F1/F4 rebutted, F2 won't-fix. Details: .reviews/round-1.md | Code review |
| 2026-06-02T15:55:00Z | claude (fastlane) | Review-Fix | Fixed B1 (reset gating state in scheduleHover, +regression test) + W1 (link.text=match.raw). Round 2 re-review: B1 sustained-as-fixed, W1 confirmed, F1+F4 overruled→sustained → APPROVE. test:unit 2070/0 | Round 1 fixes + round 2 approval |
| 2026-06-02T16:05:00Z | claude (fastlane) | Build (user feedback) | Task 2_3: image fills popup width (CSS width:100%); popup re-anchors on img load via extracted positionPopup → flips above when no room below (+2 tests, stale-load guarded). Spec/design D7 updated | User feedback: preview cut off below + should fit width |
| 2026-06-02T16:12:00Z | claude (fastlane) | Build (user feedback) | Image popup height auto-recalculates: showImage passes maxPopupHeight:Infinity so popup grows to width-scaled image height (viewport-bounded, not 360 cap); positionPopup reads cap from root.style. D7 updated | User feedback: fit-width only, height auto re-calculation |
