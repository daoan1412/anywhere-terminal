// src/providers/fileTreeHost.ts — Shared file-tree wiring for the three
// webview-hosting providers (sidebar, panel, editor).
//
// Each provider previously carried near-identical file-tree state:
//   - `rootGeneration` counter
//   - `workspaceRoot` getter
//   - `onDidChangeWorkspaceFolders` subscription that bumps the counter and
//     posts `workspace-root-changed`
//   - `request-read-directory` message handler that delegates to
//     `handleRequestReadDirectory`
//   - `request-set-file-tree-position` handler that shows a QuickPick and
//     posts the response back to THIS provider's webview
//   - `rootGeneration` + `workspaceRoot` fields in the `init` payload
//
// `FileTreeHost` collects those pieces into one composable companion object.
// Providers own a `FileTreeHost` instance, delegate matching message types
// via `handleMessage`, and spread `initPayload()` into their init message.
// The two webview surfaces (`vscode.WebviewView` vs `vscode.WebviewPanel`)
// differ in shape, so we accept a `Webview` directly rather than try to
// abstract over them.
//
// See: review round-1 follow-up — Oracle #3 (extension RPC layer).

import * as vscode from "vscode";
import type {
  FileTreeSearchResponseMessage,
  GitStatusChangedMessage,
  ReadDirectoryResponseMessage,
  RevealInFileTreeMessage,
  SetFileTreePositionMessage,
  WebViewToExtensionMessage,
  WorkspaceRootChangedMessage,
} from "../types/messages";
import { ActiveFileRevealer } from "./ActiveFileRevealer";
import { handleRequestReadDirectory, type RootProvider, readEnabledExcludePatterns } from "./fileTreeRpcHandler";
import { createDefaultSearchVscodeApi, FileTreeSearchHandler } from "./fileTreeSearchHandler";
import type { GitDecorationProvider } from "./gitDecorationProvider";

/**
 * Init-message fields the host contributes. Providers spread this into their
 * `init` payload so the webview's file-tree boots with the right generation
 * and root path.
 */
export interface FileTreeInitPayload {
  rootGeneration: number;
  workspaceRoot: string | null;
}

/**
 * Per-provider file-tree wiring. Owns:
 *  - the monotonic `rootGeneration` counter (design.md D10);
 *  - the `onDidChangeWorkspaceFolders` subscription;
 *  - dispatch for the two webview→extension file-tree messages.
 *
 * Lifetime is tied to the parent provider — providers MUST call `attach`
 * inside their webview-resolve method and push the returned disposable
 * into their cleanup list.
 */
export class FileTreeHost implements RootProvider {
  public rootGeneration = 0;

  /**
   * Stateful search handler — owns at most one in-flight enumeration.
   * Lazily constructed on first `request-file-tree-search`.
   */
  private searchHandler: FileTreeSearchHandler | null = null;

  /**
   * Optional git decoration provider. When provided, the host stamps every
   * `FileEntry` it ships back via `request-read-directory` with the current
   * `gitStatus` + `gitRevision`. When `null` (e.g. in unit tests that don't
   * exercise git decorations), entries omit those fields.
   */
  constructor(private readonly gitDecorationProvider: GitDecorationProvider | null = null) {}

  /** Absolute path of the first workspace folder, or null when no workspace is open. */
  get workspaceRoot(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  initPayload(): FileTreeInitPayload {
    return {
      rootGeneration: this.rootGeneration,
      workspaceRoot: this.workspaceRoot,
    };
  }

  /**
   * Wire the workspace-folder bridge AND the active-file auto-reveal listener
   * to this provider's webview. Returns a `Disposable` the caller pushes into
   * its cleanup list.
   *
   * `isReady` is a getter (not a snapshot) because providers gate `safePostMessage`
   * on a flag that flips after the webview signals `ready`. We don't want to
   * post `workspace-root-changed` to a webview that hasn't booted yet.
   *
   * `post` is the provider's own `safePostMessage` shim — we don't call
   * `webview.postMessage` directly so providers can keep their retry / error
   * logging in one place. The shim's `_ready` gate also handles the
   * `ActiveFileRevealer` postMessage path without extra logic here.
   */
  attach(deps: {
    isReady: () => boolean;
    post: (msg: WorkspaceRootChangedMessage | RevealInFileTreeMessage | GitStatusChangedMessage) => void;
  }): vscode.Disposable {
    const workspaceFolderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // The GitDecorationProvider owns its own workspace-folder reset (O-W3
      // — without this, every FileTreeHost would call reset() once on a
      // folder change, making the fan-out scale with the host count). We
      // just bump the per-host generation and post `workspace-root-changed`.
      // The webview clears its nodeCache + per-path revision watermark on
      // that message, which is what evicts any phantom decorations from
      // the previous workspace state.
      this.rootGeneration += 1;
      if (!deps.isReady()) {
        return;
      }
      deps.post({
        type: "workspace-root-changed",
        rootPath: this.workspaceRoot,
        rootGeneration: this.rootGeneration,
      });
    });

    // Forward each git decoration delta to the webview, stamped with the
    // current rootGeneration. The webview drops mismatched-generation
    // messages via the same gate it uses for read-directory responses.
    const gitDeltaSub = this.gitDecorationProvider?.onDidChange((delta) => {
      if (!deps.isReady()) {
        return;
      }
      deps.post({
        type: "git-status-changed",
        rootGeneration: this.rootGeneration,
        revision: delta.revision,
        changes: delta.changes,
      });
    }) ?? { dispose: () => {} };

    const revealer = new ActiveFileRevealer(
      () => this.workspaceRoot,
      (msg) => deps.post(msg),
    );

    return vscode.Disposable.from(workspaceFolderSub, gitDeltaSub, revealer, {
      dispose: () => {
        this.searchHandler?.dispose();
        this.searchHandler = null;
      },
    });
  }

  /**
   * Try to handle a `WebViewToExtensionMessage`. Returns `true` when the
   * message was a file-tree message (handled by this host); `false` when the
   * caller should keep dispatching to its own switch. Providers wire this
   * inline:
   *
   *     if (this.fileTreeHost.handleMessage(msg, (m) => this.safePostMessage(webview, m))) {
   *       break;
   *     }
   *     // fall through to provider-specific handlers
   */
  handleMessage(
    msg: WebViewToExtensionMessage,
    post: (m: ReadDirectoryResponseMessage | SetFileTreePositionMessage | FileTreeSearchResponseMessage) => void,
  ): boolean {
    switch (msg.type) {
      case "request-read-directory":
        void handleRequestReadDirectory(
          msg,
          this,
          post,
          vscode.workspace.fs,
          vscode.Uri,
          readEnabledExcludePatterns(),
          this.gitDecorationProvider,
        );
        return true;
      case "request-file-tree-search":
        if (!this.searchHandler) {
          this.searchHandler = new FileTreeSearchHandler(this, createDefaultSearchVscodeApi());
        }
        void this.searchHandler.handle(msg).then((response) => {
          // null response = drop (cancelled / stale-post-findFiles).
          if (response) {
            post(response);
          }
        });
        return true;
      case "cancel-file-tree-search":
        // Webview signalled it no longer needs the in-flight enumeration
        // (search bar closed / workspace root changed). Idempotent — the
        // handler is null when nothing's in flight.
        this.searchHandler?.cancelCurrent();
        return true;
      case "request-set-file-tree-position":
        // Drive the QuickPick locally so the response lands on THIS webview
        // (the shared `anywhereTerminal.setFileTreePosition` command routes
        // via `getFocusedProvider()`, which only knows about sidebar/panel —
        // not the editor instance).
        void (async () => {
          const choice = await vscode.window.showQuickPick(["Top", "Bottom", "Left", "Right"], {
            placeHolder: "Move AnyWhere Terminal file tree to…",
          });
          if (!choice) {
            return;
          }
          post({
            type: "set-file-tree-position",
            position: choice.toLowerCase() as "top" | "bottom" | "left" | "right",
          });
        })();
        return true;
      default:
        return false;
    }
  }
}
