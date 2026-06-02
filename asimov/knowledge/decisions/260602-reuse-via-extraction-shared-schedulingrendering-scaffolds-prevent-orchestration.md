---
labels: [architecture, extraction, reuse, composition, dry]
source: preview-pasted-images
summary: When reusing complex logic (debounce, dismissal, positioning) across two consumers, extract the shared scaffolds and compose them rather than cloning.
---
# Reuse via extraction: shared scheduling/rendering scaffolds prevent orchestration duplication
**Date**: 2026-06-02

## TL;DR
- Two consumers: file-preview hover (IPC-driven popup) and image-preview hover (local blob-driven popup)
- Shared infrastructure: 300ms debounce, leave-grace timer, dismissal on scroll/Escape/blur, positioning
- DO NOT clone the 150 lines of scheduling/positioning for two separate controllers
- DO extract shared scaffolds: scheduleHover in controller; renderShell + positionPopup in popup
- File path: sets its own request state; image path uses clean slate
- Both inherit identical dismissal, timer lifecycle, and positioning — no divergence risk

## Context
The file-hover-preview feature shipped with a controller + popup. When adding image preview, the naive approach was to duplicate the controller/popup. However, the controller/popup are hardened with security-gating state, dismissal on multiple triggers, leave-grace window, window-listener lifecycle, and viewport-clamped positioning.

Duplicating this logic risks divergence, maintenance burden, and testing complexity.

## Evidence
### Anchors
- src/webview/links/HoverPreviewController.ts → scheduleHover (L349-394): generic skeleton shared by file + image hovers
- src/webview/links/HoverPreviewController.ts → onLinkHover (L396-427): file-specific path
- src/webview/links/HoverPreviewController.ts → onImageLinkHover (L429-441): image-specific path  
- src/webview/links/HoverPreviewPopup.ts → renderShell (L414-470): generic mount + position scaffold
- src/webview/links/HoverPreviewPopup.ts → positionPopup (L486-510): extracted positioning, re-invoked on image load

### Rejected Alternative
Standalone ImageHoverPopup + ImageHoverController would duplicate ~150 lines, creating a divergence footgun.

## When to apply
- Two+ components share 20%+ of logic (state machine, dismissal orchestration, positioning)
- The shared logic is complex and carries bugs/security gates
- The divergence cost is high
- Extract the shared scaffolds and compose them with callbacks/injection

## Prevention gate
- Count the lines of duplicated logic
- If over 100 lines, extraction pays for itself
- Favor composition over subclassing or duplication
- Test both consumers against the shared scaffold

