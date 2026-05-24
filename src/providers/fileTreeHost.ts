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
  FsChangesInvalidatedMessage,
  FsRehydrateMessage,
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
import type { WatcherPool } from "./fsWatcherPool";
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
   * Per-host map of subscribed paths → pool Disposable. One entry per
   * `request-subscribe-fs-changes` for THIS host. Disposed on
   * `request-unsubscribe-fs-changes` (per-path), on `attach()`-returned
   * cleanup, and on a re-subscribe to the same path (idempotent — see
   * `handleMessage`).
   */
  private readonly fsSubscriptions = new Map<string, vscode.Disposable>();

  /**
   * Stable per-webview post channel captured from `attach()`. Used for
   * asynchronous host→webview messages (`fs-changes-invalidated`) whose
   * lifecycle is decoupled from any single inbound RPC. Null between
   * construction and the first `attach()` call.
   */
  private attachPost:
    | ((
        msg:
          | WorkspaceRootChangedMessage
          | RevealInFileTreeMessage
          | GitStatusChangedMessage
          | FsChangesInvalidatedMessage
          | FsRehydrateMessage,
      ) => void)
    | null = null;
  private attachReady: (() => boolean) | null = null;

  /**
   * Optional git decoration provider. When provided, the host stamps every
   * `FileEntry` it ships back via `request-read-directory` with the current
   * `gitStatus` + `gitRevision`. When `null` (e.g. in unit tests that don't
   * exercise git decorations), entries omit those fields.
   *
   * `watcherPool` is the shared process-level FS watcher pool from
   * `extension.ts`. When `null` (e.g. legacy unit tests), all subscribe /
   * unsubscribe / rehydrate dispatch is a silent no-op.
   */
  constructor(
    private readonly gitDecorationProvider: GitDecorationProvider | null = null,
    private readonly watcherPool: WatcherPool | null = null,
  ) {}

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
    post: (
      msg:
        | WorkspaceRootChangedMessage
        | RevealInFileTreeMessage
        | GitStatusChangedMessage
        | FsChangesInvalidatedMessage
        | FsRehydrateMessage,
    ) => void;
  }): vscode.Disposable {
    this.attachPost = deps.post;
    this.attachReady = deps.isReady;
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

    // Forward the pool's rising-edge focus rehydrate signal to THIS webview
    // as `fs-rehydrate`. The webview refreshes root + currently-expanded
    // directories (see design.md D7). Gated on `isReady` because the pool
    // may fire before the webview boots (the user could refocus during
    // initial activation).
    const rehydrateSub = this.watcherPool?.onDidRequestRehydrate(() => {
      if (!deps.isReady()) {
        return;
      }
      deps.post({
        type: "fs-rehydrate",
        rootGeneration: this.rootGeneration,
      });
    }) ?? { dispose: () => {} };

    return vscode.Disposable.from(workspaceFolderSub, gitDeltaSub, rehydrateSub, revealer, {
      dispose: () => {
        this.searchHandler?.dispose();
        this.searchHandler = null;
        for (const sub of this.fsSubscriptions.values()) {
          sub.dispose();
        }
        this.fsSubscriptions.clear();
        this.attachPost = null;
        this.attachReady = null;
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
      case "request-subscribe-fs-changes": {
        // Drop messages tagged with a stale rootGeneration — the webview was
        // referring to a now-superseded workspace state. Matches the existing
        // rootGeneration gate on every other RPC.
        if (msg.rootGeneration !== this.rootGeneration) {
          return true;
        }
        if (!this.watcherPool) {
          return true;
        }
        // Idempotent: a re-subscribe to the same path is a silent no-op so
        // the data source can freely re-emit on cache lifecycle without
        // tracking which paths it has already subscribed.
        if (this.fsSubscriptions.has(msg.path)) {
          return true;
        }
        const path = msg.path;
        const sub = this.watcherPool.subscribe(path, () => {
          // The closure deliberately reads `this.rootGeneration` LIVE so
          // events arriving after a workspace folder change carry the
          // CURRENT generation, which the webview then drops via its own
          // gate — preferable to firing under a stale generation that the
          // webview would also drop. Uses the stable per-webview channel
          // captured in `attach()` so async events outlive any single
          // inbound RPC's post-closure.
          if (!this.attachPost || !this.attachReady?.()) {
            return;
          }
          this.attachPost({
            type: "fs-changes-invalidated",
            rootGeneration: this.rootGeneration,
            parent: path,
          });
        });
        this.fsSubscriptions.set(path, sub);
        return true;
      }
      case "request-unsubscribe-fs-changes": {
        // Intentionally bypass the rootGeneration gate (review round-1 W1):
        // a rapid root rotation A→B→C posts the bulk unsubscribe for B's
        // paths under generation B, but the host may already be at C by the
        // time the message arrives — gating would drop the unsubscribe and
        // leak the host-side subscription entry. The map is path-keyed and
        // every entry belongs to THIS webview, so disposing requested paths
        // is always safe regardless of generation.
        for (const p of msg.paths) {
          const sub = this.fsSubscriptions.get(p);
          if (sub) {
            sub.dispose();
            this.fsSubscriptions.delete(p);
          }
        }
        return true;
      }
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
