# Review Summary — refine-file-tree-controls

| Round | Findings | Verdict | New | Fixed | Persisting |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 BLOCK, 3 WARN | APPROVE AFTER FIXES (all fixed same round) | 4 | 4 | 0 |
| 2 (oracle, user-requested) | 0 critical, 3 should-fix | APPROVE (all fixed) | 3 | 3 | 0 |
| 3 | 0 BLOCK, 3 WARN, 2 SUGGEST + 1 protocol issue | WARN (3 auto-applied by logic agent — needs user triage) | 6 | 3 | 3 |
| 4 (oracle, user-requested) | 0 BLOCK, 2 WARN, 4 SUGGEST + F1 rejected | WARN (N1, N2 user-visible; F2 + N4 spec-coupled) | 6 | 0 | 6 |
| 4-fix (post-oracle) | F2, F3, N1-N6 all fixed | APPROVE — 1520/1520 tests | 0 | 8 | 0 |

## Finding lifecycle

- **B1** (panel hidden, `webviewHtml.ts:561`) — round 1: opened → accepted → fixed same round.
- **W2** (duplicate divider, `fileTreePanel.css:597`) — round 1: opened → accepted → fixed same round.
- **W3** (stale JSDoc, `FileTreePanel.ts:92,105`) — round 1: opened → accepted → fixed same round.
- **W4** (unhandled rejection, `fileTreeHost.ts:337`) — round 1: opened → accepted → fixed same round.
- **O1** (wrong CSS specificity comment, `fileTreePanel.css:704`) — round 2 (oracle): opened → accepted → fixed.
- **O2** (legacy `open` persisted forever, `FileTreePanel.ts:1241`) — round 2 (oracle): opened → accepted → fixed. Note: round-1 should have caught this.
- **O3** (overstated SVG provenance, `FileTreePanel.ts:759`) — round 2 (oracle): opened → accepted → fixed.
- **F1** (no keyboard activation on position menu items, `FileTreePanel.ts:992-1024`) — round 3: opened → pending (needs manual verify whether `<button>` native Enter/Space activation suffices).
- **F2** (`aria-current` wrong attribute on `role="menuitem"`, `FileTreePanel.ts:944-946`) — round 3: opened → round-4-fix: fixed (role=menuitemradio + aria-checked; spec.md line 17 updated).
- **F3** (tooltip missing `aria-describedby` on triggers, `Tooltip.ts`) — round 3: opened → round-4-fix: fixed (stable widget id, aria-describedby set/cleared in attach/dispose).
- **L1** (`revealPath` ignored `source="openFolder"` while collapsed, `FileTreePanel.ts:274`) — round 3: opened → applied-by-reviewer (logic sub-agent violated protocol).
- **L2** (silent open-folder failure paths, `fileTreeHost.ts:338,350`) — round 3: opened → applied-by-reviewer.
- **L3** (position-menu Tab close forced focus, `FileTreePanel.ts:1024,1038`) — round 3: opened → applied-by-reviewer.
- **F1** (no keyboard activation) — round 4 (oracle): **rejected** — native `<button>` Enter/Space dispatches click; doc keydown does not intercept.
- **N1** (search-button stale tooltip + native title returns on enter/exitSearch, `FileTreePanel.ts:1177,1216`) — round 4: opened → round-4-fix: fixed (dynamic getText closure on searchBtn tooltip; setAttribute("title",...) removed from enterSearch/exitSearch).
- **N2** (position menu no vertical viewport clamp/flip, `FileTreePanel.ts:961-974`) — round 4: opened → round-4-fix: fixed (vertical flip when btnRect.bottom + menuHeight overflows viewport).
- **N3** (collapse-anim gate leaks on wrapper after dispose, `FileTreePanel.ts:735-738`) — round 4: opened → round-4-fix: fixed (classList.remove("file-tree--anim") added to dispose).
- **N4** (spec stale — `executeCommand` vs actual `showOpenDialog`, `specs/file-tree-panel/spec.md:7-9`) — round 4: opened → round-4-fix: fixed (spec rewritten to describe showOpenDialog + reveal-in-file-tree + warning/error toasts).
- **N5** (tooltip mouse-only, WCAG 1.4.13, `Tooltip.ts:104-107`) — round 4: opened → round-4-fix: fixed (focus/blur listeners added alongside mouse handlers).
- **N6** (`openFolder` on current root doesn't expand, `FileTreePanel.ts:324-355`) — round 4: opened → round-4-fix: fixed (explicit root.expand for source==="openFolder" in in-root branch).
