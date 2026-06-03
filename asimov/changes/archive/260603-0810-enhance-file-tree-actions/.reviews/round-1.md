# Review: enhance-file-tree-actions (Round 1)

Date: 2026-06-03

Reviewable lines: ~746 changed lines across host, provider routing, message contracts, and webview menu files.

Agents:
- data-security/logic: Mencius (`019e8c7a-d45a-7953-8131-7eb997d04131`)
- contracts: Hypatia (`019e8c7a-d49b-7a31-afda-081a5d68d188`)
- frontend: Faraday (`019e8c7a-d4d5-7a20-b0e0-d28a2c9a33a1`)

Verdict: BLOCK

Counts:
- Blocking: 2
- Warnings: 2
- Suggestions: 0

## Findings

### B1: Active file-tree root can desynchronize from rendered root

- ID: B1
- Severity: BLOCK
- Confidence: HIGH
- Priority: P1
- Agent: Mencius
- File: `src/providers/fileTreeHost.ts:344`
- Status: accepted
- Evidence: `request-open-folder` assigns `activeFileTreeRoot = picked[0].fsPath` before checking `attachPost` / `attachReady`. If the webview is unavailable, the reveal message is not posted, but later `validatePathAction` trusts the unrendered `activeFileTreeRoot`. Cleanup clears `attachPost` / `attachReady` without resetting `activeFileTreeRoot`, while `initPayload()` still sends `workspaceRoot`.
- Impact: A stale or forged current-generation message can act on a folder that is not the rendered file-tree root, including delete of children under that folder.
- Suggested Fix: Update `activeFileTreeRoot` only when the reveal can be delivered, and reset the host-owned active root when attaching a webview whose init payload renders the workspace root.
- Triage: Accepted. This is a real host/rendered-root invariant violation and affects destructive actions.

### B2: Root delete rejection can be bypassed by path casing on Windows

- ID: B2
- Severity: BLOCK
- Confidence: HIGH
- Priority: P1
- Agent: Mencius
- File: `src/providers/fileTreeHost.ts:465`
- Status: accepted
- Evidence: Delete root rejection compares `nodePath.resolve(a) === nodePath.resolve(b)`. On Windows case-insensitive filesystems, containment can treat differently-cased drive/root paths as same-or-inside while exact resolved string equality can reject sameness.
- Impact: A forged delete message for the active root with different casing can pass containment but bypass `rejectRootTarget`.
- Suggested Fix: Make root equality consistent with containment, using relative path sameness rather than exact resolved string equality, and add coverage for case-insensitive path behavior.
- Triage: Accepted. Root deletion is explicitly out of scope, and equality must use the same semantics as containment.

### W1: Reveal and copy action failures are not surfaced

- ID: W1
- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: Mencius
- File: `src/providers/fileTreeHost.ts:379`
- Status: accepted
- Evidence: `handleRevealInOs`, `handleCopyPath`, and `handleCopyRelativePath` await VS Code APIs without `try/catch`, and `handleMessage` dispatches them with `void`.
- Impact: Reveal/copy failures can become silent failures or unhandled promise rejections.
- Suggested Fix: Wrap reveal/copy handlers in `try/catch` and show concise user-visible errors.
- Triage: Accepted. This is cheap to fix and matches the delete handler's user-visible error pattern.

### W2: Context menu can survive tree remount and act on stale row state

- ID: W2
- Severity: WARN
- Confidence: HIGH
- Priority: P2
- Agent: Faraday
- File: `src/webview/fileTree/FileTreePanel.ts:560`
- Status: accepted
- Evidence: `FileTreeContextMenu.open()` appends the menu to the panel host and stores row/node context. `remount()` tears down tree/body state but does not close the context menu; the action handler sends the stale node path with the live `currentRootGeneration`.
- Impact: A visible menu can outlive the row/tree it was opened from and post an action for stale row state.
- Suggested Fix: Close the context menu at the start of tree remount, and capture root generation at menu-open time so missed lifecycle cleanup still sends the original generation.
- Triage: Accepted. The stale menu state is real and the fix is localized.

## Clean Areas

- Contracts/routing: no findings. The new messages carry only `type`, `rootGeneration`, and `path`, are included in the webview-to-extension union, and both terminal providers delegate all four action messages to `FileTreeHost`.
- Support tests: no `.only` / `.skip` found in changed test files.

## Session IDs

- data-security: Mencius (`019e8c7a-d45a-7953-8131-7eb997d04131`)
- logic: Mencius (`019e8c7a-d45a-7953-8131-7eb997d04131`)
- contracts: Hypatia (`019e8c7a-d49b-7a31-afda-081a5d68d188`)
- frontend: Faraday (`019e8c7a-d4d5-7a20-b0e0-d28a2c9a33a1`)
