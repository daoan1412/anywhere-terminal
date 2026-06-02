---
labels: [jsdom, testing, blind-spot, css, layout]
source: 260602-0408-render-vault-workflow-board
summary: jsdom (Node.js DOM mock) has no CSS layout engine: display:none, scroll position, geometry, and layout-dependent logic are never computed. Bugs invisible to jsdom tests are revealed only by manual browser testing.
---
# jsdom has no CSS layout engine — scroll and display:none bugs are invisible to tests
**Date**: 2026-06-02

## TL;DR
- jsdom has **no CSS engine** — `display:none`, scroll positions, and computed styles are never evaluated
- Logic depending on layout (element visibility, scroll offset, getBoundingClientRect) passes tests but fails in the browser
- Unit test gate: required, but insufficient for layout/CSS-dependent features
- Prevention: manual end-to-end testing for any feature using CSS classes, display rules, or scroll handling

## Context
The workflow board rendering involved:
1. CSS-gated visibility (`display: none` when ancestor lacks `.is-open`)
2. Per-agent detail containers with scroll-to-end behavior (`scrollBoardDetailToEnd`)
3. Selection state (agent highlighting) persisted across re-renders

All three are layout-dependent:
- Visibility requires CSS evaluation to know what's actually visible
- Scroll position requires the browser to compute element geometry
- Highlighting requires knowing the current DOM structure and layout state

jsdom provides a **fully functional DOM API** (querySelector, appendChild, getBoundingClientRect) but with **stub/fake implementations**:
- `element.getBoundingClientRect()` returns `{ top: 0, left: 0, width: 0, height: 0, ... }` (zeroed)
- CSS `display:none` is parsed but not applied (the element exists in the DOM, visibility is invisible to the mock)
- `element.scrollTop` can be read/written but scroll never actually happens (geometry is always 0)

## Evidence
### Anchors
- `asimov/changes/archive/260602-0408-render-vault-workflow-board/workflow.md` — "Manual-test fix round 3" and "round 5" entries describe 3 bugs (display:none, scroll-to-end, selection) that all passed jsdom tests but failed manual testing
- `src/webview/vault/vaultPanel.test.ts` — uses jsdom, passes all 2049 tests, but cannot verify CSS evaluation or scroll behavior
- Project memory `project-webview-jsdom-test-isolation.md` — existing pattern for document-listener cleanup in jsdom tests; document structure leaks across tests within a file when test isolation is per-file, not per-test

### Excerpts
From the workflow:
- Round 3 (manual test): "the agent detail rendered but was display:none — invisible (jsdom has no CSS, so tests missed it)"
- Round 5 (manual test): verified "scrollBoardDetailToEnd at both renderNestedInto sites" and "expanded persistence across rebuild" — all required live browser testing

## When to apply
- After implementing any feature that depends on CSS evaluation (display rules, computed styles, visibility)
- When adding scroll-based interactions (`scrollTop`, `scrollBy`, `scroll-behavior`)
- When testing layout-sensitive code (getBoundingClientRect, offsetWidth, IntersectionObserver)
- For any UI change involving visibility toggling or conditional layout

## Prevention gate
1. **Add manual E2E testing** for all layout/CSS-dependent logic — treat jsdom tests as syntactic checks, not functional validation
2. **Document which features require manual testing** in the test file header (e.g., "scroll behavior, display toggling, selection persistence — require browser verification")
3. **For layout-dependent tests**, use a comment flag like `// jsdom-blind: scroll behavior not testable` so future maintainers know the coverage gap
4. **Run the full suite multiple times** (10x) in manual testing for any feature involving state persistence or scroll position, as these can be racy in real browsers too

