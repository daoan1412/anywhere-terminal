---
labels: [css, reuse, testing, blind-spot]
source: 260602-0408-render-vault-workflow-board
summary: Reusing a CSS class whose display property is gated by an ancestor selector (display: none by default, display: block when ancestor has .is-open) outside that ancestor silently hides content. jsdom cannot catch this regression (no CSS layout computation); manual testing revealed the bug after rounds of code review passed.
---
# CSS ancestor-gated display is a reuse footgun
**Date**: 2026-06-02

## TL;DR
- Reusing a CSS class whose `display` is ancestor-gated outside the ancestor silently hides content
- jsdom cannot catch CSS layout bugs (no layout engine); unit tests pass, manual testing fails
- Fix: give reused-but-relocated containers their own explicit-`display` class

## Context
In the workflow board implementation, the agent detail pane initially reused  (a class from the subagent card) to render the transcript. This class has:

```css
.vault-preview-subagent-body {
  display: none;
}
.vault-preview-subagent.is-open .vault-preview-subagent-body {
  display: block;
}
```

When the board was inlined into the session detail (avoiding an extra wrapper layer), the detail container inherited `.vault-preview-subagent-body` but lived OUTSIDE the `.vault-preview-subagent.is-open` ancestor, so it remained `display: none` — the transcript DOM rendered but was invisible.

This was NOT caught by 3 rounds of code review + 2046 unit tests passing. Only manual end-to-end testing revealed it.

## Evidence
### Anchors
- `src/webview/vault/vaultPanel.css` lines 1579–1582 — explicit fix: `.vault-wfboard-detail-body { display: block; }` with a comment documenting WHY this class cannot inherit the ancestor gating
- `asimov/changes/archive/260602-0408-render-vault-workflow-board/workflow.md` revision log — "Manual-test fix round 3": "Inlining the board removed the .vault-preview-subagent.is-open ancestor that the transcript container's reused .vault-preview-subagent-body class needs for display, so the agent detail rendered but was display:none — invisible (jsdom has no CSS, so tests missed it)."
- Code review round 3 confirmed clean for textContent-only rendering (frontend specialist), but CSS was not explicitly flagged in unit tests

## When to apply
- When reusing a CSS class from one component in a different structural context
- Before removing a parent/ancestor element for any reason — verify that child CSS rules don't depend on ancestor selectors
- After any DOM restructuring: manually test in the real browser, not just jsdom
- Prevention: define explicit `display` on relocated containers; use CSS specificity to prefer explicit values over ancestor-gated ones; add a comment linking the rule to its usage context

