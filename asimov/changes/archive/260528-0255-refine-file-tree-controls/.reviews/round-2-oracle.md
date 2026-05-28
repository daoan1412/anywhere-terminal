# Oracle Review — refine-file-tree-controls (post round-1 fixes)

- **Date**: 2026-05-27T22:20:00Z
- **Reviewer**: asm-oracle (independent second-opinion, on user request after round-1 review completed)
- **Verdict**: APPROVE (no critical issues; 3 should-fix items all addressed)
- **Confidence**: HIGH

## Findings (all accepted + fixed)

### [O1] CSS specificity comment was wrong (now corrected)

- **File**: `src/webview/fileTree/fileTreePanel.css:704-710`
- **Issue**: The comment claimed "specificity 0,3,1 exceeds this 0,4,1 because :hover doesn't change here" — that's reversed. The bottom idle rule (0,4,1) actually overrides the generic hover (0,3,1); preservation of hover comes from the bottom-prefixed hover/active overrides (0,5,1).
- **Impact**: Documentation drift, no runtime effect.
- **Fix**: Rewrote the comment to correctly describe specificity flow.

### [O2] Legacy `open` field persisted forever via spread

- **File**: `src/webview/fileTree/FileTreePanel.ts:1240-1246`
- **Issue**: `persistCurrentState()` did `{ ...(existing ?? {}), ... }` — preserved every runtime field, including the removed legacy `open: boolean`. Type-vs-runtime divergence: the field doesn't appear in `FileTreeState` but lives forever in serialized state.
- **Impact**: Not a functional bug (no consumer reads `open` anymore) but a real schema drift. Oracle noted: "Round-1 should have caught this because it explicitly reviewed the migration fixture change."
- **Fix**: Replaced the blanket spread with an explicit pick of the only owned-by-other-writer field (`searchMode`). On first persist after upgrade, `open` is dropped.

### [O3] Overstated SVG provenance comment

- **File**: `src/webview/fileTree/FileTreePanel.ts:759-760`
- **Issue**: Comment said "Glyph paths copied verbatim" but the new open-folder path is a custom outline, not a codicon copy.
- **Impact**: Misleading documentation.
- **Fix**: Updated comment to distinguish codicon-derived (search, move) from custom (open-folder).

## All clear

- Constructor → mount → first render flow: clean, no remaining `setOpen`/`file-tree--closed` dependency.
- User collapse + workspace-root-change lifecycle: coherent.
- `request-open-folder` routing complete; rejection handler present.
- B1 fix (panel-hidden) verified in place.

## Verify gate after oracle fixes

- `pnpm run check-types` → clean
- `pnpm run test:unit` → 1500/1500 passing

## Session ID

- oracle: agent `aaefd48a17a3a30dc`
