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
  ReadDirectoryResponseMessage,
  SetFileTreePositionMessage,
  WebViewToExtensionMessage,
  WorkspaceRootChangedMessage,
} from "../types/messages";
import { handleRequestReadDirectory, type RootProvider, readEnabledExcludePatterns } from "./fileTreeRpcHandler";

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
   * Wire the workspace-folder bridge to this provider's webview. Returns a
   * `Disposable` the caller pushes into its cleanup list.
   *
   * `isReady` is a getter (not a snapshot) because providers gate `safePostMessage`
   * on a flag that flips after the webview signals `ready`. We don't want to
   * post `workspace-root-changed` to a webview that hasn't booted yet.
   *
   * `post` is the provider's own `safePostMessage` shim — we don't call
   * `webview.postMessage` directly so providers can keep their retry / error
   * logging in one place.
   */
  attach(deps: { isReady: () => boolean; post: (msg: WorkspaceRootChangedMessage) => void }): vscode.Disposable {
    return vscode.workspace.onDidChangeWorkspaceFolders(() => {
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
    post: (m: ReadDirectoryResponseMessage | SetFileTreePositionMessage) => void,
  ): boolean {
    switch (msg.type) {
      case "request-read-directory":
        void handleRequestReadDirectory(msg, this, post, vscode.workspace.fs, vscode.Uri, readEnabledExcludePatterns());
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
