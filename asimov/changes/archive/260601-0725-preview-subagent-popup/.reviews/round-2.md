# Review round 2 — preview-subagent-popup (de-dup refactor)

- **Date**: 2026-06-01
- **Scope**: de-dup refactor only — extract shared `FloatingPreviewShell` + genericize `buildPreviewHeader(model, cb)`, compose `PreviewController` + `SubagentPreviewPopup` onto them.
- **Reviewable files**: src/webview/vault/FloatingPreviewShell.ts (new), src/webview/vault/previewHeader.ts (rewritten), src/webview/vault/PreviewController.ts (rewired), src/webview/links/SubagentPreviewPopup.ts (rewired). ~500 reviewable lines (<800).
- **Agents spawned**: frontend, logic, contracts. Skipped: data-security (no data/IPC/auth surface changed — message types unchanged, host resolution untouched).
- **Verdict**: **APPROVE** (clean review)
- **Counts**: BLOCK 0 | WARN 0 | SUGGEST 0 (actionable)

## Session IDs (for re-review)
- frontend: review-preview-subagent-popup-frontend (agentId ab91125f01b629afb)
- logic: review-preview-subagent-popup-logic (agentId ab1dfec422cac389f)
- contracts: review-preview-subagent-popup-contracts (agentId adb6bdf113699466b)
- data-security: not-spawned

## Verification (chair + agents)
- **tsc + vitest**: logic agent independently ran `tsc --noEmit` + `vitest run` on the four files + `VaultPanel.test.ts` → all pass. Chair ran full suite: 2024 pass / 0 fail, 10× full-run isolation OK.
- **Close path** (frontend+logic, HIGH): single-routed `onRequestClose → consumer close → shell.hide()`; `hide()` never calls `onRequestClose` → no recursion. `closePreview()` idempotent.
- **Listener lifecycle** (frontend, HIGH): `attach`/`detach` use the SAME `captureCloseListeners` flag on add+remove; `attach` detaches first → no double-register on vault shell reuse / no leak.
- **Vault regression** (logic, HIGH): pagination + `previewLoadingMore` debounce, nested `pendingNested`/`nestedDetails` routing, root-only `expandedRuns` clear on load-more, scroll-to-first walk termination, initial/load-more/scroll-top branches, accent add/remove, Esc context-menu guard, `.vault-row` outside-exclude — all preserved. `VaultPanel.test.ts` (100) green.
- **DOM/class parity** (frontend, HIGH): title-row order badge→[chip]→title→actions; actions prev,next,resume,maximize,close; `.vault-preview-title-actions`/`.vault-preview-maximize`/`.vault-preview-meta` preserved (FloatingWindow startMove/maximize + scrollNav body re-query unaffected).
- **Geometry** (logic, HIGH): survives direct row-switch and close→reopen (FloatingWindow geometry only mutated by gestures). Popup in-memory `rememberedGeometry` survives `dispose()` (stored on the popup, not the shell).
- **Contract/abstraction** (contracts, HIGH): `FloatingPreviewShellDeps` optionals map 1:1 to real divergence (anchor/Esc-guard/outside-exclude/capture/role/classNames); no vault/subagent concern leaks into the shell; composition clean; `PreviewController` public API unchanged; design.md D6 + Interfaces match implementation.

## Findings
None at BLOCK/WARN/SUGGEST.

## Out-of-scope observation (NOT a finding — pre-existing, not introduced here)
- `previewHeader.ts` resume button sets native `.title="Resume session"` alongside `attachTooltip(resumeBtn)` (a custom tooltip), unlike the maximize button which deliberately omits `.title`. The frontend agent confirmed the pre-refactor code did the same — **not a regression from this diff**, and resume renders on the vault path only. Could be cleaned in a future vault-preview pass; out of scope for this de-dup change.
