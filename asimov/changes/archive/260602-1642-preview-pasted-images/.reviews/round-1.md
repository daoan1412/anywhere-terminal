# Review Round 1 — preview-pasted-images

- Date: 2026-06-02
- Reviewable lines: ~571 (8 reviewable source files; 5 test files inline)
- Agents spawned: frontend, logic, data-security
- Agents skipped: contracts (no schema/route/validation/contract surface; interface addition covered by tsc + logic/frontend)
- Verdict: **BLOCK** (1 BLOCK, 1 WARN accepted, findings rebutted/suggested noted)
- Counts: BLOCK 1 · WARN 1 (accepted) · SUGGEST/REBUT 3

## Findings

### B1 — BLOCK — HIGH — P1 — chair+logic
- file: src/webview/links/HoverPreviewController.ts (onImageLinkHover / scheduleHover)
- title: Image hover does not invalidate prior file-preview request/confirmation state
- evidence: `onImageLinkHover` calls `scheduleHover` with no `beforeSchedule`, so `activeRequestId`, `activePath`, `activeLine`, `overrideRequested`, `activeRequiresConfirmation` keep their values from a prior file hover. `scheduleHover` updates `activeAnchor` to the image anchor.
- impact: (1) A file-preview response still in flight matches the stale `activeRequestId` and renders `popup.show()` at the image anchor. (2) A Cmd/Ctrl press while the image popup is visible passes `shouldTriggerOverride` (stale `activeRequiresConfirmation` + `activePath`) and issues an override `requestFilePreview` for the old file — regressing the trust-policy gate the extraction was meant to preserve.
- suggestedFix: Reset the file-preview gating state on every hover. Moved the reset into `scheduleHover` (runs for both paths) so the file path's `beforeSchedule` only sets `activePath`/`activeLine`; image path inherits a clean slate.
- status: accepted
- triage: Real cross-path state bleed; fix in scheduleHover (DRY, prevents recurrence).

### W1 — WARN — HIGH — P2 — frontend
- file: src/webview/links/ImagePlaceholderLinkProvider.ts:56
- title: `link.text` hardcoded to `[Image N]` (no `#`) while placeholder may be `[Image #N]`
- evidence: `text: \`[Image ${match.num}]\`` ignores the `#` form (Claude/Codex primary case). Decoration is range-based (still underlines), but `text` feeds `HoverPreviewController.linkKey` (same-link identity) and the link's accessible label.
- impact: Cosmetic/identity mismatch for the dominant `#` form; no functional break to decoration, but the link key/label is wrong text.
- suggestedFix: Return the raw matched substring from `parseImagePlaceholders` and use it as `link.text`.
- status: accepted
- triage: Cheap correctness fix; removes doubt for the primary use case.

### F1 — SUGGEST (downgraded from WARN) — frontend — REBUTTED
- file: src/webview/links/ImagePlaceholderLinkProvider.ts:54-66
- title: attachImageHover could stack hover wrappers if xterm reused ILink refs
- triage: **rejected** — `provideLinks` returns freshly-constructed `ILink` objects every call (`matches.map`), identical to the established `FilePathLinkProvider` and `SubagentLinkProvider`. xterm does not reuse link refs across calls; no wrapper stacking. Agent itself noted "each link is fresh".
- status: rejected

### F4 — SUGGEST (downgraded from WARN) — frontend — REBUTTED
- file: src/webview/main.ts:1097-1100
- title: paste may route to wrong pane under the tabActivePaneIds focus race
- triage: **rejected** — uses the identical active-pane resolution (`store.tabActivePaneIds.get(tabId) ?? tabId`) the existing document keydown-capture handler uses; the race is pre-existing and not introduced here. Worst case is `resolve()` → null (no popup), never a cross-terminal image leak. Acceptable, consistent with established pattern.
- status: rejected

### F2 — SUGGEST — frontend — won't-fix
- file: src/webview/links/HoverPreviewPopup.ts / webviewHtml.ts CSS
- title: `<img> max-height:100%` resolves against a max-height-only parent
- triage: **won't-fix** — agent confirmed it works in practice; `object-fit: contain` + `max-width:100%` prevent horizontal overflow and the body's `overflow:auto` scrolls/clips tall images. Acceptable.
- status: rejected

## Data-security
Clean. CSP relaxation (`img-src ... blob: data:`) minimal and necessary (`default-src 'none'` + nonce script-src unchanged; `img-src` cannot execute or exfiltrate). Capture is observe-only, bounded (URLs revoked on all teardown paths), per-terminal isolated; `blob.type` is inert (never a DOM/exec sink).

## Session IDs
- frontend: a4efe403a52a9be11
- logic: acadc97c1cbed5ef3
- data-security: a878cf99a195e6136
- contracts: not-spawned
