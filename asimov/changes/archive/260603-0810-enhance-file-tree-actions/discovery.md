# Discovery: enhance-file-tree-actions

## Workstreams

| Workstream | Source | Status | Notes |
|---|---|---|---|
| Project context | `asimov/project.md`, `bun run asm change list`, `bun run asm spec list` | Complete | VS Code extension with webview/IPC/extension-host architecture; file-tree specs already cover tree widget, RPC, panel, search, watcher sync, and drag-to-terminal behavior. |
| Memory recall | `bun run asm memory search "file tree context menu delete reveal finder copy path"` | Complete | Vault panel has a row context menu precedent; actions are host-side and clipboard is written through `vscode.env.clipboard`. |
| Existing design docs | `docs/DESIGN.md`, `docs/design/message-protocol.md` | Complete | Message protocol is discriminated-union IPC over `postMessage`; host/webview separation should remain strict. |
| Architecture snapshot | `asm-finder` explorer | Complete | File-tree UI is centered in `src/webview/fileTree/FileTreePanel.ts`, `ReadOnlyFileRenderer.ts`, `Tree.ts`, `FileTreeController.ts`; host routing is in `src/providers/fileTreeHost.ts`, `fileTreeRpcHandler.ts`, and provider dispatchers. |
| Internal patterns | `asm-finder` explorer, vault specs/design | Complete | Reuse `VaultContextMenu` behavior and `FileTreePanel.openPositionMenu()` menu semantics; keep confirmation, clipboard, reveal, and deletion on the extension host. |
| External OSS research | `asm-librarian` explorer over the sibling VS Code OSS checkout | Complete | VS Code Explorer orders copy path actions before destructive delete, uses host/native services for reveal and clipboard, and confirms delete before moving to trash/permanent delete. |

## Key Findings

- Current file-tree panel composition lives in `src/webview/fileTree/FileTreePanel.ts`; row rendering is in `src/webview/fileTree/ReadOnlyFileRenderer.ts`; generic selection/activation/keyboard logic is in `src/webview/fileTree/Tree.ts`.
- Extension-host file-tree routing is centralized in `src/providers/fileTreeHost.ts`, with read-directory/search/watch behavior split into `src/providers/fileTreeRpcHandler.ts` and provider dispatch in `TerminalViewProvider.ts` / `TerminalEditorProvider.ts`.
- `src/webview/vault/VaultContextMenu.ts` is the closest local menu precedent: a body-mounted menu, ARIA `menu` / `menuitem`, Escape and outside-click close, and host action messages.
- `FileTreePanel.openPositionMenu()` already implements a high-quality in-webview dropdown pattern, including focus restoration and keyboard navigation.
- Host-side clipboard (`vscode.env.clipboard.writeText`) is already preferred where permission reliability matters.
- Host-side reveal uses `vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(...))`.
- VS Code OSS Explorer contributes Copy Path / Copy Relative Path together, Reveal in OS as a navigation command, and Delete in a modification/destructive group.
- VS Code OSS delete confirms before moving to trash, distinguishes permanent delete, and falls back to permanent delete if trash fails. This change can keep the first version smaller by providing only normal confirmed trash delete.
- Existing specs require preserving single-selection tree semantics, flat-list search mode, transient search state, root-generation handling, watcher invalidation, panel positioning, and click-to-open behavior.

## Gap Analysis

- The current file tree has no context-menu action surface on rows.
- `ReadOnlyFileRenderer` has no hook for context-menu events, but can expose one without changing `Tree<T>` or its public API.
- `src/types/messages.ts` has read/search/watch/open-folder file-tree message types but no write/action messages.
- `FileTreeHost` has no path-action handlers for reveal/copy/delete.
- Deletion introduces the first user-triggered file-system mutation from the file-tree panel; it needs a modal confirmation and strict root-generation/path validation.
- Existing `file-tree-rpc` spec says out-of-workspace paths are rejected, while current implementation intentionally supports absolute browsing through Open Folder. The plan should avoid broadening that mismatch: action handlers should validate against the current file-tree root/base path rather than blindly trusting any webview path.

## Options

| Option | Scope | Pros | Cons |
|---|---|---|---|
| A. Focused v1 actions | Right-click menu for file rows only: Reveal in Finder/File Explorer, Copy Path, Copy Relative Path, Delete with confirmation and trash. | Matches user request, low UI churn, minimal mutation surface, preserves folder tree behavior, easiest to test. | Folder delete/copy is omitted in v1 even though VS Code supports folders. |
| B. VS Code-like file and folder actions | Same menu for files and folders; Delete can recursively trash folders. | Closest to VS Code Explorer behavior; more complete. | Higher data-loss risk, recursive delete confirmation copy and tests required, touches more edge cases around expanded folder cache invalidation. |
| C. Non-mutating actions only | Reveal, Copy Path, Copy Relative Path; no Delete. | Lowest risk; no file-system mutation. | Does not satisfy the requested delete action. |

## Recommendation

Use Option A for this change.

Reasoning:
- The user explicitly requested delete, reveal, copy path, and copy relative path; Option A satisfies that while keeping delete limited to files.
- Limiting delete to file rows avoids recursive folder deletion risk in the first mutation feature.
- The implementation can stay additive: one context-menu helper, one renderer hook, four new IPC messages, and host-side handlers.
- It aligns with local vault context-menu patterns and VS Code's host-side clipboard/reveal/delete approach.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Accidental deletion | User data loss | Show modal confirmation with file basename/path; use `useTrash: true`; limit v1 delete to files only; cancel on any non-affirmative selection. |
| Untrusted webview path action | Acting on an unintended path | Validate path against the current root/base and root generation in the host before delete/copy-relative; host derives relative path with Node `path.relative`. |
| Stale tree after deletion | Deleted file remains visible | After successful delete, post or trigger `fs-changes-invalidated` for the parent directory so the data source refreshes. |
| Context menu on synthetic search rows | Invalid action payloads | Do not open the menu for search overflow/error/empty synthetic rows. |
| Tree widget regression | Broken selection/keyboard/virtualization | Keep `Tree<T>` unchanged; add only an optional renderer-level context-menu callback. |
| Clipboard permission failure | Copy action silently fails in webview | Use `vscode.env.clipboard.writeText` on the extension host. |

## Open Questions

- Should v1 include folder actions, especially Copy Path / Copy Relative Path, or keep the context menu file-only?
- Should Delete always move to trash, or should a future follow-up add a separate Delete Permanently action modeled after VS Code Explorer?
