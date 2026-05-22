# Review summary — add-hover-file-preview

Lifecycle of findings across review rounds.

## Round 1 (2026-05-21)

| ID | Sev | Title | File | Round 2 status |
|----|-----|-------|------|--------|
| B1 | BLOCK | Hover silently previews out-of-workspace files via OSC 7 cwd | previewFileLink.ts | **fixed** |
| W1 | WARN | FilePreviewResultMessage flat-optional shape | messages.ts | **fixed** |
| W2 | WARN | Module-scope `_currentTheme` fragility | markdownRenderer.ts | **fixed** |
| W3 | WARN | IPC validation unbounded path + NUL | TerminalView/EditorProvider.ts | **fixed** |
| W4 | WARN | First-hover plain-text fallback on slow preload | syntaxRenderer.ts | **fixed (introduces W5/F1-FE regression)** |
| W5 | WARN | TOCTOU between stat and readFile | readFileForPreview.ts | **partial — re-raised as round 2 W1** |
| W6 | WARN | Eager CTS dispose breaks token-state contract | TerminalView/EditorProvider.ts | **fixed** |
| W7 | WARN | shiki/markdown-it in `dependencies` inflates vsix | package.json | **fixed** |
| W8 | WARN | (suppressed) requestCloseSplitPane cast | TerminalEditorProvider.ts | (not re-raised) |
| W9 | WARN | (suppressed) Stale terminal.element on detach | HoverPreviewController.ts | (not re-raised) |
| S1 | SUGGEST | (suppressed) findFiles bare filename leakage | previewFileLink.ts | (not re-raised) |
| S2 | SUGGEST | (suppressed) absPath PII leak (subsumed by B1) | previewFileLink.ts | (subsumed) |
| S3 | SUGGEST | (suppressed) PreviewTokenManager extraction | TerminalView/EditorProvider.ts | (not re-raised) |

## Round 2 (2026-05-21)

| ID | Sev | Title | File | Status |
|----|-----|-------|------|--------|
| **B1** | **BLOCK** | **Cmd/Ctrl override fires on any modifier keystroke — bypasses trust policy** | HoverPreviewController.ts | **accepted+fixed** |
| W1 | WARN | TOCTOU memory bound (round-1 W5 post-read check cosmetic) | readFileForPreview.ts | accepted+fixed |
| W2 | WARN | `blockSensitive` workspace-configurable — security as preference | package.json + hoverPreviewSettings.ts | accepted+fixed |
| W3 | WARN | Trust classification fails OPEN with no bases (empty workspace + unknown session) | previewFileLink.ts | accepted+fixed |
| W4 | WARN | Symlink lexical trust — `classifyTrust` on path, not realpath | previewFileLink.ts | accepted+fixed |
| W5 | WARN | Async Shiki re-render destroys active-line + scroll-to-line | TerminalFactory.ts + HoverPreviewPopup.ts | accepted+fixed |
| W6 | WARN | Wrap heuristic false-positive on full-width rows + unbounded walk | FilePathLinkProvider.ts | accepted+fixed |
| W7 | WARN | SENSITIVE_DIR_SEGMENTS misses `.terraform/.npm/.gem/.azure` | previewFileLink.ts | accepted+fixed |
| F1-CO | WARN | (suppressed) `requires-confirmation.absPath?` optional but always set | messages.ts | pending |
| F2-FE | WARN | (suppressed) `role="tooltip"` w/ interactive footer violates ARIA | HoverPreviewPopup.ts | pending |
| F2-CO | WARN | (suppressed) `CLAUDE_LINES_RE` missing left-boundary anchor | filePathParser.ts | pending |
| F2-LG | WARN | (suppressed) `hasAbsPath` return type permits undefined | HoverPreviewPopup.ts | pending |
| O6 | WARN | (suppressed) Link range math not cell-width aware | FilePathLinkProvider.ts | pending |
| F3-DS | SUGGEST | (suppressed) `override:true` bypasses OSC-7 — subsumed by B1 | previewFileLink.ts | pending |
| F4-DS | SUGGEST | (suppressed) `hasTraversal` no URL-decode normalization | pathResolution.ts | pending |
| F5-DS | SUGGEST | (suppressed) trailing-separator load-bearing | previewFileLink.ts | pending |
| F3-FE | SUGGEST | (suppressed) onFilePreviewResult broadcasts to all controllers | main.ts | pending |
| F4-FE | SUGGEST | (suppressed) `.line` query scope too broad | HoverPreviewPopup.ts | pending |
