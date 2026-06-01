---
labels: [refactor, architecture, ui, component-reuse, prevention]
source: preview-subagent-popup
summary: False reuse satisfaction: reusing leaf components (FloatingWindow, scrollNav) while duplicating orchestration + header produces two divergent UIs for the same concept
---
# Extracted shell + header builder prevents UI divergence in reused previews
**Date**: 2026-06-01

## TL;DR
- **False reuse satisfaction**: reusing leaf components (FloatingWindow, scrollNav) while duplicating orchestration + header produces two divergent UIs for the same concept
- **Real fix**: extract ONE shared shell (card assembly + close listeners + geometry) + ONE header builder consumed by both consumers via composition, preventing drift

## Context
When adding the subagent preview popup, the first approach reused existing leaf components (`FloatingWindow`, `PreviewScrollNav`, `renderNestedInto`) but hand-wrote the card assembly, close-listener wiring, and a bespoke header for the popup. Meanwhile, the vault session preview had its own `PreviewController` doing the same thing with slightly different code.

The reviewer flagged "two UIs for one problem" — both are floating transcript previews, but they diverged (different headers, duplicate close-listener binding, separate geometry handling). This is a classic refactoring signal: the components share responsibility, not just code.

The fix extracted:
1. **`FloatingPreviewShell`** — the vault-agnostic chrome: `.vault-preview` card + `FloatingWindow` (resize/move/maximize) + `PreviewScrollNav` FABs + document close-listeners + tooltip disposers + the `show()`/`hide()`/`dispose()` lifecycle
2. **`buildPreviewHeader(model, cb)`** — one stateless header builder where vault-only actions (prev-user, next-user, resume) render only when their callback is supplied; subagent popup omits those callbacks

Both `PreviewController` and `SubagentPreviewPopup` now **compose** the shell, thread their own model and callbacks, and are guaranteed to have identical chrome and header structure.

## Evidence
### Anchors
- `src/webview/vault/FloatingPreviewShell.ts` (new) — extracted shell; implements `render()`, `show()`, `hide()`, `dispose()` with parameterized close behaviors
- `src/webview/vault/previewHeader.ts` — `buildPreviewHeader(model, cb)` one builder; optional `onPrevUser?`, `onNextUser?`, `onResume?` callbacks control which buttons render
- `src/webview/vault/PreviewController.ts` — composes the shell; retains pagination, nested lazy-fetch, vault-specific guards
- `src/webview/links/SubagentPreviewPopup.ts` — composes the shell; provides no Resume/next-user callbacks
- `.reviews/round-2.md` lines 18–23 — verification: "title-row order badge→[chip]→title→actions; actions prev,next,resume,maximize,close; all vault-specific paths preserved, parity confirmed"

### Pattern
1. **Signal**: two code modules implement the same feature (floating preview card) with divergent implementation details
2. **Anti-pattern**: component reuse without responsibility extraction — each module imports the same `FloatingWindow` / `scrollNav` but wires them differently
3. **Detection**: reviewer finds duplicated code (header assembly, close-listener binding) across unrelated modules
4. **Fix**: extract the SHARED RESPONSIBILITY as one composable shell + one builder, injected via constructor/params; consumers call identical APIs
5. **Verification**: both consumers have identical public APIs; internal refactoring is transparent to callers; regression suite confirms no functional change

## When to apply
- When two or more feature implementations reuse the same leaf components but write different orchestration code
- When a code review flags "this looks like [similar feature] but implemented differently"
- When two modules both own event listeners, geometry, or lifecycle state for the same UI concept
- Prefer this over component library extraction when the intent is **shared responsibility**, not **reusable leaf component** — a shell abstracts *how to compose* the pieces, not just the pieces themselves

## Prevention gate
- Design review: ask "how many places implement this feature?" — if >1, plan the extraction upfront
- Code review: spot duplicate wiring (listeners, cleanup, geometry save/restore) and raise "is this intentionally different?" If not → extract to shared shell
- Architecture: establish a single source of truth for UI chrome (header, card, close behavior) per feature area; consuming modules compose, not duplicate
