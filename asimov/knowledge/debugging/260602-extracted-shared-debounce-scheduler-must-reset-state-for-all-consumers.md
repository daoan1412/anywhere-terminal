---
labels: [webview, scheduler, state-bleed, security, extraction]
source: preview-pasted-images
summary: When extracting a shared debounce scheduler to serve two consumers (file path + image preview), file-preview security gating state must reset on EVERY hover to prevent stale confirmations/overrides from one path affecting another.
---
# Extracted shared debounce scheduler must reset state for all consumers
**Date**: 2026-06-02

## TL;DR
- Extracted `scheduleHover()` shared by file-path and image-placeholder hovers
- File-preview state: `activeRequestId`, `activePath`, `activeRequiresConfirmation`, `overrideRequested`
- A file-preview request in-flight, then hover an image: stale `activeRequestId` persists
- Late file response matches stale `activeRequestId`, renders popup at image anchor
- User Cmd/Ctrl press over image triggers stale override for the old file path — **security regression**
- Fix: reset gating state in `scheduleHover` (runs for both paths) at L375-385

## Context
The hover-preview controller handles both file-link and image-placeholder hovers. Originally, the file-preview path had inline hover handling with its own debounce. When extracting image support, both paths needed to share the debounce logic to avoid duplicate timers and dismissal orchestration.

However, the file-preview path carries security state (`activeRequiresConfirmation`, `overrideRequested`) that gates the Cmd/Ctrl trust-policy override gesture. This state must not leak across hovers.

## Evidence
### Anchors
- `src/webview/links/HoverPreviewController.ts` → `scheduleHover()` (L349-394) — resets gating state at L375-385 on EVERY hover
  - `this.activeRequestId = null`
  - `this.activePath = null`
  - `this.activeRequiresConfirmation = false`
  - `this.overrideRequested = false`
- `src/webview/links/HoverPreviewController.ts` → `onLinkHover()` (L396-427) — file path, re-populates `activePath`/`activeLine` in `beforeSchedule` callback
- `src/webview/links/HoverPreviewController.ts` → `onImageLinkHover()` (L429-441) — image path, does NOT set these; inherits clean state from `scheduleHover`
- `src/webview/links/HoverPreviewController.ts` → `shouldTriggerOverride()` (L531-545, not shown) — guards override on `activeRequiresConfirmation` AND modifier keys

### Round-1 Code Review
- **B1 BLOCK (High):** `onImageLinkHover` called `scheduleHover` without resetting file-preview state, allowing stale `activeRequestId` to match a late file response and rendering it at the image anchor. Further, stale `activeRequiresConfirmation` + `activePath` allowed a Cmd/Ctrl press over the image popup to fire an override for the old file.
- **Fix:** Moved state reset into `scheduleHover` (runs for both paths) so the file path only re-sets what it cares about (`activePath`/`activeLine`) via `beforeSchedule`.
- **Verification:** Round 2 logic agent confirmed: stale request now dropped by `onMessage`'s requestId check; stale override now gated by `activeRequiresConfirmation` being false. Regression test added + passing.

## When to apply
- Extracting a shared scheduler/dispatcher to serve multiple consumers
- Consumers each have local state (request IDs, flags, confirmation latches)
- New consumer should NOT inherit stale state from the previous consumer
- **Prevention gate**: if `scheduleHover` runs, ALWAYS reset all gating/request state in the shared method; let callers only set the state they own

## Prevention gate
- When extracting a debounce or scheduler shared by multiple paths: reset ALL mutable state in the shared method
- Use `beforeSchedule` callback for path-specific setup only (the path re-sets its own state)
- Never rely on `dismiss()` alone to clean state between hovers — the same consumer may have two hovers in succession, and cross-consumer state bleed is also possible
- Unit test: hover path A (populates stale state X), then hover path B (must NOT see stale X)

