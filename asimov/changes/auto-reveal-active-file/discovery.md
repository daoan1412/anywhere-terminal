# Discovery: auto-reveal-active-file

## Workstreams executed

| Workstream | Outcome | Source |
|---|---|---|
| Memory Recall | No prior auto-reveal decisions; related: TerminalEditorProvider instance-registry pattern (knowledge note 260522), Click-to-Focus pane pattern | `asimov/knowledge/patterns/260522-terminaleditorprovider-instance-registry...` |
| Architecture Snapshot | All required surfaces exist in webview; only host-side editor listener missing | finder subagent |
| VSCode Source Study | Mapped explorer.autoReveal flow end-to-end | `/Users/huybuidac/Projects/ai-oss/vscode/src/vs/workbench/contrib/files/browser/{explorerService.ts,views/explorerView.ts,files.contribution.ts}` |
| External Research | UX gotchas + setting taxonomy persisted | `docs/research/20260523-explorer-auto-reveal.md` |
| Constraint Check | No new npm dependency required; uses VS Code Extension API already in extension surface | `package.json` |
| Cross-change Coordination | `add-file-tree-search` is in-progress but orthogonal — no shared file conflicts | `asimov/changes/add-file-tree-search/{discovery,proposal}.md` |

## Key findings

### Webview side is already 90 % built

- `Tree<T>` already exposes `revealElement`, `setSelection`, `domFocus`, `expand`, `collapse`, `isExpanded`, `getOrLoadChildren`
  - `src/webview/fileTree/Tree.ts:475-682`
- `FileTreePanel.revealPath()` **already exists** — built for OSC 7 reveal; walks segments, expands ancestors, scrolls — direct reuse target
  - `src/webview/fileTree/FileTreePanel.ts:206-264`
- IPC message `RevealInFileTreeMessage` is already defined and dispatched through `MessageRouter.onRevealInFileTree → FileTreeController.handleReveal → FileTreePanel.revealPath`
  - `src/types/messages.ts:569-573`, `src/webview/messaging/MessageRouter.ts:43-69, 155-157`, `src/webview/fileTree/FileTreeController.ts:157-168`
- File-tree panel visibility tracked via `open: boolean` on `FileTreePanel` (`src/webview/fileTree/FileTreePanel.ts:115, 210-213`); webview readiness via `view?.visible` + `_ready` on provider (`src/providers/TerminalViewProvider.ts:48-96`)

### Extension host needs a NEW listener (the only real surface to add)

- Zero existing usage of `vscode.window.activeTextEditor`, `onDidChangeActiveTextEditor`, or `window.tabGroups` anywhere in the codebase — this is a brand-new dependency on these VS Code APIs
- Entry point for registration: `src/extension.ts:11-150` or inside `FileTreeHost` (`src/providers/fileTreeHost.ts:53-100`) which already manages workspace-folder bridge for the file tree

### Settings plumbing exists but needs a new key

- Settings declared in `package.json#contributes.configuration` and consumed via `src/settings/SettingsReader.ts`
- Need new key(s): `anywhereTerminal.fileTree.autoReveal` (+ optionally `autoRevealExclude`)

### How VSCode does it (the canonical reference)

| Stage | VSCode location | Behavior |
|---|---|---|
| Setting registration | `files.contribution.ts:434-468` | 3-state: `true \| false \| 'focusNoScroll'` (default `true`); `autoRevealExclude` glob (default excludes `node_modules`, `bower_components`) |
| Editor → reveal trigger | `explorerView.ts:318-320, 422-436` | Listens to `editorService.onDidActiveEditorChange` → `selectActiveFile()` → resolve canonical URI → `explorerService.select(uri, reveal)` |
| Reveal coordinator | `explorerService.ts:32-322` | Finds closest workspace root, applies `autoRevealExclude` matcher, calls `view.selectResource(resource, reveal)` |
| Tree reveal algorithm | `explorerView.ts:817-879` + `abstractTree.ts:3073-3088` | Expands every ancestor; if not visible, calls `tree.reveal(item, 0.5)` (center); always sets focus + selection |
| `focusNoScroll` semantics | `explorerView.ts:867-873` | Skips `tree.reveal()`; still sets focus + selection |
| Exclude evaluation | `explorerService.ts:444-464` | Walks item + all parents; any glob match → skip reveal (unless `'force'`) |
| Debouncing | — | **VSCode does NOT debounce** — it relies on event-source coalescing only |

### UX gotchas worth respecting (from research)

1. autoReveal can steal focus when user is exploring elsewhere → mitigated by `focusNoScroll` variant
2. Reveal disrupts right-click / context-menu interactions → may need brief suppression after user tree interaction
3. Files outside the workspace cannot be revealed — skip silently
4. Untitled / preview / custom-editor URIs need special handling (some have no usable `fsPath`)
5. Real-world debounce range when used: ~75-500 ms — VSCode itself does not debounce, but smaller systems often add 100 ms to absorb tab-cycling churn

### Cross-change overlap with `add-file-tree-search`

- Search will add `setFilter(predicate, matchData)` to `Tree<T>` and a match-highlight renderer
- Auto-reveal does **not** need those — relies only on existing `expand`/`reveal`/`select` surface
- **No file conflicts; can be implemented in parallel.** If search lands first and tree is filtered, auto-reveal must respect the filter (TBD in design)

## Gap analysis (what's missing)

| # | Gap | Effort |
|---|---|---|
| G1 | Host-side listener for `onDidChangeActiveTextEditor` (or `tabGroups.onDidChangeActiveTab`) | small |
| G2 | Resolve active editor URI → workspace-relative path → check inside any root | small |
| G3 | Send reveal message to webview (reuse existing `RevealInFileTreeMessage`) | trivial — wiring only |
| G4 | New setting `anywhereTerminal.fileTree.autoReveal` + reader + live-reload listener | small |
| G5 | (Optional) `focusNoScroll` semantics in `FileTreePanel.revealPath` | small — needs new arg |
| G6 | (Optional) `autoRevealExclude` glob matching on host | medium |
| G7 | Skip reveal when panel hidden, OR deliver pending reveal when panel opens | small — design choice |
| G8 | Debounce / coalescing for rapid editor switches | trivial |

## Options

| ID | Approach | Setting surface | Effort | Risk | Notes |
|---|---|---|---|---|---|
| **O1** | **VSCode-parity (Recommended)** — match the canonical behavior users already know | `autoReveal: true \| false \| 'focusNoScroll'` + `autoRevealExclude: glob-object` | M (~2-3 d) | LOW-MED | Reuses existing reveal path; adds settings + listener + glob matcher + focusNoScroll arg. Skip-when-hidden default. ~100 ms debounce. |
| O2 | Minimal — ship the smallest useful slice; iterate later | `autoReveal: boolean` only | S (~1 d) | LOW | No focusNoScroll, no exclude. Easy to extend later because Tree/IPC are unchanged. |
| O3 | Custom — push beyond VSCode (e.g. "smart-sticky": pause auto-reveal for N seconds after user touches tree) | boolean + `userInteractionPauseMs` | M-L (~3-4 d) | MED | Better UX but novel; users may not expect it. Skips established VSCode mental model. |

### Recommendation

**O1 (VSCode-parity)** — the existing webview surface is already capable; the marginal effort to ship the full 3-state setting + exclude glob is small and gives users the exact mental model they already have from VSCode. `focusNoScroll` directly addresses the #1 UX gotcha (auto-reveal stealing context) and is cheap because it's a flag on the existing reveal path.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Editor change fires rapidly during tab cycling → IPC flood | MED | LOW | 100 ms debounce on host before posting message |
| Reveal during user's active tree scrolling feels jarring | MED | MED | Default `focusNoScroll` opt-in; future "pause after interaction" enhancement |
| Active editor URI is non-`file:` (custom editor, untitled, vscode-remote) | HIGH | LOW | Skip silently — match VSCode behavior |
| File outside workspace root | HIGH | LOW | Skip silently — match VSCode |
| Conflict with future search filter (add-file-tree-search) when row is filtered out | LOW | MED | Defer to design.md; for v1 reveal can no-op when target is filtered out |
| Listener leak if not disposed on extension deactivate | LOW | LOW | Standard disposable registration via `context.subscriptions.push(…)` |

## Open questions (for GATE 1)

1. **Scope**: ship VSCode-parity (O1) or minimal first (O2)?
2. **Trigger event**: `window.onDidChangeActiveTextEditor` (text only) or `window.tabGroups.onDidChangeActiveTab` (covers custom editors, images)?
3. **Default value** when setting is absent: `true` (always reveal) like VSCode, or `false` (opt-in) to avoid surprising existing users?
4. **Panel-hidden behavior**: drop the reveal, or queue it so the file is in view the next time the user opens the panel?
