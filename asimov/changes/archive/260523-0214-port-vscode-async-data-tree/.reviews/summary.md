# Review Summary — port-vscode-async-data-tree

## Round 1 (2026-05-23) — BLOCK

| ID | Sev | File | Title | Status |
|---|---|---|---|---|
| B1 | BLOCK | Tree.ts:513,534 | unbounded Map growth on collapse/refresh | pending |
| W1 | WARN  | fileTreePanel.css:149 | header button has no `:focus-visible` ring | pending |
| W2 | WARN  | package.json:259 | `ctx.revealInFileTree` missing palette-hide | pending |
| W3 | WARN  | TerminalFactory.ts:382 | OSC 7 handler stores unsanitized cwd | pending |
| W4 | WARN  | FileSystemDataSource.ts:105 | requestId collision after `setRoot` | pending |
| S1 | SUGG  | gitIgnoreChecker.ts:80 | `--stdin` should use `-z` mode | pending |
| S2 | SUGG  | WebviewState.ts:43 | dual-schema lacks write-side guard | pending |
| S3 | SUGG  | fileTreePanel.css:144 | row `:focus-visible` killed too | pending |

**Counts:** 1 BLOCK · 4 WARN · 3 SUGGEST · 4 suppressed
