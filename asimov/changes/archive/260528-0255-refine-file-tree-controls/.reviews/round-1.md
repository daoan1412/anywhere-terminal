# Review: refine-file-tree-controls (Round 1)

- **Date**: 2026-05-27T21:54:00Z
- **Reviewable lines**: ~215 (66 insertions + 149 deletions across 18 files; 4 test files reviewed inline)
- **Agents spawned**: frontend, logic, contracts. (contracts agent timed out twice — chair completed via grep evidence from its mid-flight investigation.)
- **Agents skipped**: data-security (no auth / DB / network changes)
- **Verdict**: WARN → APPROVE AFTER FIXES (all findings addressed in same round)
- **Counts**: 1 BLOCK, 3 WARN — all fixed

## Findings

### [B1] Panel permanently hidden — `file-tree--closed` left in static HTML

- **Severity**: BLOCK · **Confidence**: HIGH · **Priority**: P1 · **Agent**: frontend
- **File**: `src/providers/webviewHtml.ts:561` (+ `src/webview/fileTree/fileTreePanel.css:706` dead rule, `src/webview/fileTree/FileTreePanel.ts:1195` stale comment)
- **Evidence**: Static HTML hardcodes `class="webview-layout file-tree--bottom file-tree--closed"`. Only `setOpen()` ever removed the class via `wrapper.classList.toggle("file-tree--closed", !open)`. `setOpen()` was deleted in this change; no replacement removes it. CSS rule at line 706 (`.file-tree--closed .file-tree-panel { display: none }`) then keeps the panel invisible forever.
- **Impact**: Guaranteed runtime regression — file tree panel invisible on every load with no user-facing affordance to show it. Manual verify would have caught this; unit tests don't exercise the static-HTML→runtime-class interaction.
- **Fix**: Removed `file-tree--closed` from the static template; updated comment to point at root-collapse as the new minimize affordance; deleted the now-dead CSS rule; updated a stale inline comment in `FileTreePanel.ts`.
- **Status**: accepted
- **Triage**: Fixed in this round.

### [W2] Duplicate divider in bottom position — sash `::before` overlaps the new `border-top`

- **Severity**: WARN · **Confidence**: HIGH · **Priority**: P2 · **Agent**: frontend
- **File**: `src/webview/fileTree/fileTreePanel.css:597`
- **Evidence**: New `border-top` paints a 1px line at the panel's top edge. Existing sash `::before` (line 673) also paints a 1px line in the same physical position with `var(--vscode-panel-border, ...)`. In themes where `--vscode-panel-border` is non-transparent (Dark+, Light+, most community themes), the user sees two overlapping 1px lines in idle state, then a sash-hover highlight that also overlaps the static border on drag.
- **Impact**: Visual artifact in default and most third-party themes — bold double-line where a single divider is intended.
- **Fix**: Added a `bottom`-position-only override that paints `transparent` on the sash `::before` in idle state. Re-stated the `:hover` and `.sash-active` overrides with matching specificity so the hover/drag highlight is preserved.
- **Status**: accepted
- **Triage**: Fixed in this round. Trade-off acknowledged — preserves the user's Gate-1 choice (B2: separate static border) while eliminating the duplicate visual.

### [W3] Stale JSDoc in `FileTreePanelDeps` references deleted `setOpen`

- **Severity**: WARN · **Confidence**: HIGH · **Priority**: P3 · **Agent**: frontend
- **File**: `src/webview/fileTree/FileTreePanel.ts:92, 105`
- **Evidence**: `onLayoutChange` and `persistState` doc comments still list `setOpen(true)` / `setOpen(false)` as triggers. Those methods no longer exist.
- **Impact**: Documentation drift; misleads future maintainers.
- **Fix**: Removed `setOpen` references from both doc blocks.
- **Status**: accepted
- **Triage**: Fixed in this round.

### [W4] Fire-and-forget `vscode.openFolder` can produce unhandled rejection

- **Severity**: WARN · **Confidence**: HIGH · **Priority**: P3 · **Agent**: logic
- **File**: `src/providers/fileTreeHost.ts:337`
- **Evidence**: `void vscode.commands.executeCommand("vscode.openFolder")` discards the returned Thenable. A rejection (e.g. command unavailable in Web mode, host transition failure) surfaces as an unhandled rejection rather than getting logged.
- **Impact**: Silent failure on the rare reject path. Probability low, but easy to mitigate.
- **Fix**: Replaced `void executeCommand(...)` with `executeCommand(...).then(undefined, err => console.error(...))`. Preserves the no-reply contract; unit test still passes (mock returns `Promise.resolve()`).
- **Status**: accepted
- **Triage**: Fixed in this round.

## Cross-cutting (chair observations)

- **Contracts coverage**: agent timed out twice. Investigation it completed before timeout confirmed: no `ToggleFileTreeMessage` references remain in `src/`; no `toggleFileTree` references in `src/` or `package.json`; spec deltas align with the diff. No additional contracts findings.
- **Removed keybinding-breakage**: explicitly accepted as scope in `proposal.md` and `discovery.md` R2. No tests or migration code requires the deleted commands to remain.
- **Test files passed inline checks**: 1 new test in `fileTreeHost.test.ts` (asserts `executeCommand` called once with `"vscode.openFolder"` and no reply posted). Fixture updates in `WebviewStateStore.test.ts` + `WebviewStateStore.searchMode.test.ts` use `as unknown` casts to verify legacy-state migration tolerance.

## Verify gate after fixes

- `pnpm run check-types` → clean
- `pnpm run test:unit` → 1500/1500 passing
- `biome check src/` → 6 pre-existing warnings (same count as baseline `main`; none introduced)

## Session IDs

- frontend: `review-refine-file-tree-controls-frontend` (agent `af5533f6220702d0b`)
- logic: `review-refine-file-tree-controls-logic` (agent `a68eb59bf4628d44a`)
- contracts: `review-refine-file-tree-controls-contracts` (agent `a163ede3f399ac69d` — timed out)
- data-security: not-spawned
