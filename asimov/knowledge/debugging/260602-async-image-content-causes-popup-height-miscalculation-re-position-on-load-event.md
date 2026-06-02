---
labels: [webview, popup, async, positioning, image, gotcha]
source: preview-pasted-images
summary: Image blobs load asynchronously; popup measures height before load (image 0×0), so flip-above logic fails. Fix: extract positioning method, re-invoke on image load event, guarded by element identity.
---
# Async image content causes popup height miscalculation — re-position on load event
**Date**: 2026-06-02

## TL;DR
- Popup measures height immediately after mount for an `<img src=blob:>`
- Blob is still decoding (height ≈ 0), so `computePosition` decides there's room below
- No flip-above happens; image loads and overflows downward, clipped off-screen
- Fix: extract `positionPopup(root, anchor)`, re-invoke on `img.load` event, guarded by `this.el === root`

## Context
When adding image-preview hover to the file-link popup, the image placeholder appears as a link. On hover, the popup renders an `<img>` element with a cached object URL (`blob:`). The popup should flip above if there's no room below the anchor point.

## Evidence
### Anchors
- `src/webview/links/HoverPreviewPopup.ts` → `showImage()` (L322-366) — builds image body, mounts via `renderShell` with `afterMount` callback
- `src/webview/links/HoverPreviewPopup.ts` → `renderShell()` (L414-470) — positions popup via `computePosition` at mount time
- `src/webview/links/HoverPreviewPopup.ts` → `positionPopup()` (L486-510) — extracted positioning logic; called on image `load` event

### Why It Matters
Async content is common in web UIs (images, iframes, lazy-loaded content). Height-dependent layout (flip-above) must re-run after content is decoded or styled. This is not a bug in `computePosition` (it works correctly once height is real); it's a sequencing bug in the caller.

## When to apply
- Floating popup/popover contains async-loaded content (image, iframe, lazy chunk)
- Popup layout depends on measured height (viewport flip, max-height clamp)
- First measurement happens before content decodes → layout is wrong
- Symptom: content overflows off-screen even with flip-above logic in place
- Fix: re-measure and re-position after content fires `load`/`complete` event

## Prevention gate
- If adding a popup/overlay that contains an `<img>` or other async content, always re-position after its `load` event
- Guard reposition with element identity check (`this.el === root`) to avoid moving a different popup if one is replaced between load event and handler fire
- Test the async load race: mount popup, verify image initially invisible/clipped, then verify it's visible after load

