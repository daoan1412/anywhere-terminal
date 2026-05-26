import * as fs from "node:fs";
import * as vscode from "vscode";
import { createWatcherPool } from "./providers/fsWatcherPool";
import { createGitDecorationProvider } from "./providers/gitDecorationProvider";
import { resolveRenameTargetTabId } from "./providers/resolveRenameTarget";
import { TerminalEditorProvider } from "./providers/TerminalEditorProvider";
import { TerminalPanelSerializer } from "./providers/TerminalPanelSerializer";
import { TerminalViewProvider } from "./providers/TerminalViewProvider";
import { loadNodePty } from "./pty/PtyManager";
import { SessionManager } from "./session/SessionManager";
import { SessionStorage } from "./session/SessionStorage";
import {
  affectsSessionRestoreEnabled,
  affectsTerminalConfig,
  readSessionRestoreEnabled,
  readTerminalConfig,
  readTerminalSettings,
} from "./settings/SettingsReader";
import { PtyLoadError } from "./types/errors";
import { escapePathForShell } from "./utils/shellEscape";

export function activate(context: vscode.ExtensionContext) {
  // Validate node-pty availability early — show user-facing error if missing
  try {
    loadNodePty();
  } catch (err) {
    if (err instanceof PtyLoadError) {
      vscode.window.showErrorMessage(
        `AnyWhere Terminal: Failed to load node-pty. Requires VS Code >= 1.109.0. ${err.message}`,
      );
    } else {
      console.error("[AnyWhere Terminal] Unexpected error loading node-pty:", err);
    }
    // Continue activation — individual createSession calls will fail gracefully
  }
  // Cross-restart session-restore wiring. See: restore-terminal-sessions design.md D4–D7, D11.
  //
  // No-workspace windows: `context.storageUri` is undefined when no folder is
  // open. Falling back to `globalStorageUri` would leak snapshots between
  // otherwise-unrelated no-folder windows (next window's hydrate scans the
  // shared global directory). Disable persistence entirely for this window
  // instead — the user can re-enable by opening a folder. See round-1 W7.
  const hasWorkspaceStorage = context.storageUri !== undefined;
  const restoreEnabled = hasWorkspaceStorage && readSessionRestoreEnabled();
  if (!hasWorkspaceStorage && readSessionRestoreEnabled()) {
    console.warn(
      "[AnyWhere Terminal] sessionRestore disabled for this window — no workspace folder open. Open a folder to enable persistence.",
    );
  }
  const restoreStorageUri = context.storageUri ?? context.globalStorageUri;
  const sessionStorage = new SessionStorage(context.workspaceState, restoreStorageUri, fs);

  // Create shared SessionManager (singleton). workspaceState backs the per-workspace
  // custom-tab-name persistence (anywhereTerminal.tabCustomNames); see design.md D3 of add-tab-rename.
  const sessionManager = new SessionManager(context.workspaceState, {
    restoreEnabled,
    storage: sessionStorage,
  });

  // Hydrate restore state BEFORE registering any view provider so the
  // sidebar/panel/editor onReady branches see populated pending snapshots.
  // Live panels MUST hydrate first — the snapshot orphan-recovery fallback
  // uses the live-panels lookup to map an unindexed buffer file back to its
  // owning editor panel rather than defaulting to sidebar. See round-1 W2.
  if (restoreEnabled) {
    sessionManager.hydrateLivePanels(sessionStorage.loadLivePanels());
    sessionManager.hydrateFromSnapshots(sessionStorage.loadIndex());
  } else {
    // Setting disabled — purge any leftover persistence from a prior session.
    void sessionStorage.purge();
  }

  // Allow late deactivate() to find this singleton without re-routing.
  _activeSessionManager = sessionManager;

  // Shared GitDecorationProvider — one singleton, threaded through every
  // FileTreeHost so the three webviews (sidebar / panel / editor) see one
  // consistent revision sequence. See: add-file-tree-git-decorations design.md D8, D10.
  const gitDecorationProvider = createGitDecorationProvider();
  context.subscriptions.push(gitDecorationProvider);

  // Shared FS WatcherPool — singleton, refcounted across every FileTreeHost
  // so we never spawn more than one `vscode.FileSystemWatcher` per directory
  // regardless of how many webviews (sidebar / panel / editor) have it open.
  // See: add-file-tree-fs-watcher design.md D1.
  const fsWatcherPool = createWatcherPool();
  context.subscriptions.push(fsWatcherPool);

  // Sidebar view
  const sidebarProvider = new TerminalViewProvider(
    context.extensionUri,
    sessionManager,
    "sidebar",
    gitDecorationProvider,
    fsWatcherPool,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TerminalViewProvider.sidebarViewType, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Panel view
  const panelProvider = new TerminalViewProvider(
    context.extensionUri,
    sessionManager,
    "panel",
    gitDecorationProvider,
    fsWatcherPool,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TerminalViewProvider.panelViewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Editor terminal command — each invocation creates an independent editor tab terminal
  context.subscriptions.push(
    vscode.commands.registerCommand("anywhereTerminal.newTerminalInEditor", () => {
      const panelDisposable = TerminalEditorProvider.createPanel(
        context,
        sessionManager,
        gitDecorationProvider,
        fsWatcherPool,
      );
      context.subscriptions.push(panelDisposable);
    }),
  );

  // WebviewPanelSerializer — revives editor terminal panels on window reload.
  // Wired AFTER SessionManager construction so consumeSnapshotsForPanel sees the
  // hydrated pending snapshots. See: restore-terminal-sessions design.md D2, D7.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(
      TerminalEditorProvider.viewType,
      new TerminalPanelSerializer(context, sessionManager, gitDecorationProvider, fsWatcherPool),
    ),
  );

  // ─── Provider Lookup ──────────────────────────────────────────

  // Map of view location to provider for direct lookup
  const providers = {
    sidebar: sidebarProvider,
    panel: panelProvider,
  };

  // Track which provider last received user interaction (for keybinding fallback)
  let lastFocusedProvider: TerminalViewProvider = sidebarProvider;

  sidebarProvider.onDidReceiveInteraction = () => {
    lastFocusedProvider = sidebarProvider;
  };
  panelProvider.onDidReceiveInteraction = () => {
    lastFocusedProvider = panelProvider;
  };

  // Helper: get the focused provider for keybinding context (both views may be visible).
  const getFocusedProvider = (): TerminalViewProvider => {
    if (panelProvider.view?.visible && !sidebarProvider.view?.visible) {
      return panelProvider;
    }
    if (sidebarProvider.view?.visible && !panelProvider.view?.visible) {
      return sidebarProvider;
    }
    return lastFocusedProvider;
  };

  // ─── Action Helpers ──────────────────────────────────────────

  const doNewTerminal = (provider: TerminalViewProvider): void => {
    const view = provider.view;
    if (!view) {
      return;
    }
    const viewId = provider.getViewId();
    const settings = readTerminalSettings();
    try {
      const newSessionId = sessionManager.createSession(viewId, view.webview, {
        shell: settings.shell,
        shellArgs: settings.shellArgs,
        cwd: settings.cwd,
      });
      const newSession = sessionManager.getSession(newSessionId);
      if (newSession) {
        safePostMessage(view.webview, {
          type: "tabCreated",
          tabId: newSessionId,
          name: newSession.name,
          customName: newSession.customName,
        });
      }
    } catch (err) {
      console.error("[AnyWhere Terminal] Failed to create terminal:", err);
      safePostMessage(view.webview, {
        type: "error",
        message: err instanceof Error ? err.message : "Failed to create new terminal",
        severity: "error",
      });
    }
  };

  const doKillTerminal = (provider: TerminalViewProvider): void => {
    const activeSessionId = provider.getActiveSessionId();
    if (!activeSessionId) {
      return;
    }
    sessionManager.destroySession(activeSessionId);
    const view = provider.view;
    if (view) {
      safePostMessage(view.webview, {
        type: "tabRemoved",
        tabId: activeSessionId,
      });
    }
  };

  const doClearTerminal = (provider: TerminalViewProvider): void => {
    const activeSessionId = provider.getActiveSessionId();
    if (!activeSessionId) {
      return;
    }
    sessionManager.clearScrollback(activeSessionId);
    const view = provider.view;
    if (view) {
      safePostMessage(view.webview, { type: "clear", tabId: activeSessionId });
    }
  };

  const doSplit = (provider: TerminalViewProvider, direction: "horizontal" | "vertical"): void => {
    const view = provider.view;
    if (!view) {
      return;
    }
    safePostMessage(view.webview, { type: "splitPane", direction });
  };

  const doCloseSplitPane = (provider: TerminalViewProvider): void => {
    const view = provider.view;
    if (!view) {
      return;
    }
    safePostMessage(view.webview, { type: "closeSplitPane" });
  };

  // ─── Generic Commands (for keybindings — use getFocusedProvider) ──────

  context.subscriptions.push(
    vscode.commands.registerCommand("anywhereTerminal.newTerminal", () => doNewTerminal(getFocusedProvider())),
    vscode.commands.registerCommand("anywhereTerminal.killTerminal", () => doKillTerminal(getFocusedProvider())),
    vscode.commands.registerCommand("anywhereTerminal.clearTerminal", () => doClearTerminal(getFocusedProvider())),
    vscode.commands.registerCommand("anywhereTerminal.splitHorizontal", () =>
      doSplit(getFocusedProvider(), "horizontal"),
    ),
    vscode.commands.registerCommand("anywhereTerminal.splitVertical", () => doSplit(getFocusedProvider(), "vertical")),
    vscode.commands.registerCommand("anywhereTerminal.closeSplitPane", () => doCloseSplitPane(getFocusedProvider())),
    // File-tree (port-vscode-async-data-tree) — toggle visibility + move position.
    // Title-bar buttons on both sidebar + panel views invoke these via package.json menus.view/title.
    vscode.commands.registerCommand("anywhereTerminal.toggleFileTree", () => {
      const view = getFocusedProvider().view;
      if (view) {
        void view.webview.postMessage({ type: "toggle-file-tree" });
      }
    }),
    vscode.commands.registerCommand("anywhereTerminal.setFileTreePosition", async () => {
      const view = getFocusedProvider().view;
      if (!view) {
        return;
      }
      const choice = await vscode.window.showQuickPick(["Top", "Bottom", "Left", "Right"], {
        placeHolder: "Move AnyWhere Terminal file tree to…",
      });
      if (!choice) {
        return;
      }
      void view.webview.postMessage({
        type: "set-file-tree-position",
        position: choice.toLowerCase() as "top" | "bottom" | "left" | "right",
      });
    }),
  );

  // ─── View-Specific Commands (for view/title menus — directly target correct provider) ──

  for (const loc of ["sidebar", "panel"] as const) {
    const provider = providers[loc];
    context.subscriptions.push(
      vscode.commands.registerCommand(`anywhereTerminal.newTerminal.${loc}`, () => doNewTerminal(provider)),
      vscode.commands.registerCommand(`anywhereTerminal.killTerminal.${loc}`, () => doKillTerminal(provider)),
      vscode.commands.registerCommand(`anywhereTerminal.splitHorizontal.${loc}`, () => doSplit(provider, "horizontal")),
      vscode.commands.registerCommand(`anywhereTerminal.splitVertical.${loc}`, () => doSplit(provider, "vertical")),
      // Toggle button on the view title bar must target THIS view, not whichever
      // provider currently holds focus — otherwise clicking on the sidebar's
      // button toggles the panel's tree (and vice-versa) when focus is on the
      // other side. Mirrors the per-loc split commands above.
      vscode.commands.registerCommand(`anywhereTerminal.toggleFileTree.${loc}`, () => {
        if (provider.view) {
          void provider.view.webview.postMessage({ type: "toggle-file-tree" });
        }
      }),
    );
  }

  // ─── Webview Context Menu Commands ────────────────────────────────
  // These are triggered from right-click on split panes via webview/context menus.
  // VS Code passes the data-vscode-context values as the command argument.

  /**
   * Find the provider that owns a given session ID.
   * Context menu commands receive paneSessionId from data-vscode-context;
   * use it to target the correct provider instead of getFocusedProvider().
   */
  const getProviderBySessionId = (sessionId: string): TerminalViewProvider | undefined => {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    for (const provider of [sidebarProvider, panelProvider]) {
      if (provider.getViewId() === session.viewId) {
        return provider;
      }
    }
    return undefined;
  };

  /**
   * Resolve the correct provider for a context menu command.
   * Prefers the provider owning the right-clicked session (paneSessionId),
   * falls back to getFocusedProvider() when context is unavailable.
   */
  const getCtxProvider = (ctx?: { paneSessionId?: string }): TerminalViewProvider => {
    if (ctx?.paneSessionId) {
      const provider = getProviderBySessionId(ctx.paneSessionId);
      if (provider) {
        return provider;
      }
    }
    return getFocusedProvider();
  };

  /** Post a message to the correct provider's webview based on context. */
  const postToCtxWebview = (ctx: { paneSessionId?: string } | undefined, message: unknown): void => {
    const provider = getCtxProvider(ctx);
    const view = provider.view;
    if (view) {
      safePostMessage(view.webview, message);
    }
  };

  /**
   * Locate the webview owning a given session — handles all three locations
   * (sidebar, panel, editor). Used by file-tree-aware ctx commands like
   * `revealInFileTree` that must post to the EXACT webview the user
   * right-clicked, not the focused one. Returns undefined when the session
   * has no surfaced webview (e.g. an editor panel disposed mid-click).
   */
  const getWebviewForSession = (sessionId: string): vscode.Webview | undefined => {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    for (const provider of [sidebarProvider, panelProvider]) {
      if (provider.getViewId() === session.viewId) {
        return provider.view?.webview;
      }
    }
    const editor = TerminalEditorProvider.findByViewId(session.viewId);
    return editor?.panel.webview;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("anywhereTerminal.ctx.closePane", (ctx: { paneSessionId?: string }) => {
      if (ctx?.paneSessionId) {
        postToCtxWebview(ctx, { type: "closeSplitPaneById", sessionId: ctx.paneSessionId });
      }
    }),
    vscode.commands.registerCommand("anywhereTerminal.ctx.splitVertical", (ctx: { paneSessionId?: string }) => {
      if (ctx?.paneSessionId) {
        postToCtxWebview(ctx, { type: "splitPaneAt", direction: "vertical", sourcePaneId: ctx.paneSessionId });
      }
    }),
    vscode.commands.registerCommand("anywhereTerminal.ctx.splitHorizontal", (ctx: { paneSessionId?: string }) => {
      if (ctx?.paneSessionId) {
        postToCtxWebview(ctx, { type: "splitPaneAt", direction: "horizontal", sourcePaneId: ctx.paneSessionId });
      }
    }),
    vscode.commands.registerCommand("anywhereTerminal.ctx.clearTerminal", (ctx?: { paneSessionId?: string }) => {
      // Clear scrollback on extension side, then tell webview to clear viewport
      const provider = getCtxProvider(ctx);
      // Use the right-clicked pane's session if available, otherwise fall back to active session
      const sessionId = ctx?.paneSessionId ?? provider.getActiveSessionId();
      if (sessionId) {
        sessionManager.clearScrollback(sessionId);
      }
      const view = provider.view;
      if (view) {
        safePostMessage(view.webview, { type: "ctxClear", sessionId });
      }
    }),
    vscode.commands.registerCommand("anywhereTerminal.ctx.newTerminal", (ctx?: { paneSessionId?: string }) => {
      doNewTerminal(getCtxProvider(ctx));
    }),
    vscode.commands.registerCommand("anywhereTerminal.ctx.killTerminal", (ctx?: { paneSessionId?: string }) => {
      const provider = getCtxProvider(ctx);
      const sessionId = ctx?.paneSessionId ?? provider.getActiveSessionId();
      if (!sessionId) {
        return;
      }
      sessionManager.destroySession(sessionId);
      const view = provider.view;
      if (view) {
        safePostMessage(view.webview, { type: "tabRemoved", tabId: sessionId });
      }
    }),
    // Right-click → "Reveal Working Directory in File Explorer". The extension
    // resolves the pane's live cwd by querying the PTY shell process at the OS
    // level (lsof on macOS, /proc/<pid>/cwd on Linux). This avoids requiring
    // shell integration / OSC 7 emission — it works out of the box on any
    // shell that has cd'd anywhere. Falls back to the parsed-prompt cwd (set
    // by the terminal output parser when available), then the initial cwd
    // recorded at PTY spawn. The webview falls back further to the workspace
    // root when all three are null (e.g. Windows where neither query works).
    vscode.commands.registerCommand(
      "anywhereTerminal.ctx.revealInFileTree",
      async (ctx?: { paneSessionId?: string }) => {
        // For editor sessions, `getCtxProvider` falls back to the focused
        // sidebar/panel provider (it only knows view-typed providers). Routing
        // the message there would deliver it to the WRONG webview. Resolve
        // the webview directly from the session ID so sidebar/panel/editor
        // are all handled identically.
        const sessionId = ctx?.paneSessionId ?? getCtxProvider(ctx).getActiveSessionId();
        if (!sessionId) {
          return;
        }
        const liveCwd = await sessionManager.getLiveCwd(sessionId);
        const cwd =
          liveCwd ?? sessionManager.getCurrentCwd(sessionId) ?? sessionManager.getInitialCwd(sessionId) ?? null;
        // The webview's file tree happily re-roots to any absolute path the
        // RPC handler can read (workspace containment check was dropped on
        // purpose — see fileTreeRpcHandler.ts). So we just relay the cwd
        // regardless of whether it's inside the workspace folder.
        const webview = getWebviewForSession(sessionId);
        if (webview) {
          safePostMessage(webview, { type: "reveal-in-file-tree", sessionId, cwd });
        }
      },
    ),
  );

  // ─── Rename Tab Command ───────────────────────────────────────────
  // See add-tab-rename: specs/tab-rename/spec.md#Rename-Command-and-Entry-Points,
  // design.md D5 (resolution chain — extracted to resolveRenameTarget.ts),
  // D7 (validation), D8 (single command id).
  //
  // Once a tabId is resolved, open an InputBox seeded with the current displayed
  // name. Dismissal (`undefined`) is no-op; any other value (incl. empty string)
  // is passed to `SessionManager.renameSession`, which normalizes per D7.

  context.subscriptions.push(
    vscode.commands.registerCommand("anywhereTerminal.renameTab", async (arg?: { tabId?: string }) => {
      const tabId = resolveRenameTargetTabId(
        arg,
        () => TerminalEditorProvider.getActiveProvider(),
        () => TerminalViewProvider.getLastFocusedProvider(),
      );
      if (!tabId) {
        return;
      }
      const session = sessionManager.getSession(tabId);
      if (!session) {
        return;
      }
      const currentDisplayed = session.customName ?? session.name;
      const input = await vscode.window.showInputBox({
        prompt: "Rename Tab (leave empty to reset to auto-name)",
        value: currentDisplayed,
        placeHolder: session.name,
      });
      if (input === undefined) {
        return; // User dismissed; do nothing
      }
      sessionManager.renameSession(tabId, input);
    }),
  );

  // ─── Configuration Change Listener ────────────────────────────────
  // Push updated config to all active webviews when relevant settings change.
  // See: specs/extension-settings/spec.md#settings-change-listener

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      // sessionRestore.enabled is the only `anywhereTerminal.*` setting that
      // does NOT push a configUpdate to webviews — it owns the restore pipeline
      // lifecycle and is handled here on the extension side.
      if (affectsSessionRestoreEnabled(e)) {
        sessionManager.setRestoreEnabled(readSessionRestoreEnabled());
      }

      if (!affectsTerminalConfig(e)) {
        return;
      }

      const config = readTerminalConfig();
      const configUpdateMessage = { type: "configUpdate" as const, config };

      // Push to sidebar and panel providers
      for (const provider of [sidebarProvider, panelProvider]) {
        const view = provider.view;
        if (view) {
          safePostMessage(view.webview, configUpdateMessage);
        }
      }

      // Push to all editor panels
      for (const panel of TerminalEditorProvider.getActivePanels()) {
        safePostMessage(panel.webview, configUpdateMessage);
      }
    }),
  );

  // ─── Insert Path Command (Explorer context menu) ────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "anywhereTerminal.insertPath",
      (uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined) => {
        // Resolve file URIs: multi-select (uris) or single-select (uri) from Explorer
        const targets = uris && uris.length > 0 ? uris : uri ? [uri] : [];
        if (targets.length === 0) {
          return;
        }

        // Escape each path and join with spaces, append trailing space
        const escaped = targets.map((u) => escapePathForShell(u.fsPath)).join(" ");

        // Route to the focused sidebar/panel provider's active pane session.
        // getActiveSessionId() correctly resolves split panes (via webview state).
        // NOTE: Editor terminals are not targeted by this command — they don't
        // expose an active session ID to the Extension Host. This is a known
        // limitation; the Shift+drag approach covers editor terminals directly.
        const provider = getFocusedProvider();
        const activeSessionId = provider.getActiveSessionId();
        if (!activeSessionId) {
          return;
        }

        sessionManager.writeToSession(activeSessionId, `${escaped} `);

        // Send visual feedback to the webview (brief flash effect)
        const view = provider.view;
        if (view) {
          safePostMessage(view.webview, { type: "insertPathEffect" });
        }
      },
    ),
  );

  // ─── Focus & Move Commands ──────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("anywhereTerminal.focusSidebar", () => {
      void vscode.commands.executeCommand("anywhereTerminal.sidebar.focus");
    }),
    vscode.commands.registerCommand("anywhereTerminal.focusPanel", () => {
      void vscode.commands.executeCommand("anywhereTerminal.panel.focus");
    }),
    vscode.commands.registerCommand("anywhereTerminal.moveToSecondary", async () => {
      await vscode.commands.executeCommand("anywhereTerminal.sidebar.focus");
      await vscode.commands.executeCommand("workbench.action.moveView");
    }),
  );

  // SessionManager is NOT added to context.subscriptions: the deactivate()
  // hook below orchestrates a two-step flush (sync buffers → awaited index)
  // BEFORE dispose, so ordering matters. See: design.md D6.
}

/** Safely post a message to a webview, handling both sync throws and async rejections. */
function safePostMessage(webview: vscode.Webview, message: unknown): void {
  try {
    void (webview.postMessage(message) as Thenable<boolean>).then(undefined, () => {});
  } catch {
    // Webview may be disposed
  }
}

/**
 * Singleton reference set in `activate` and consumed in `deactivate`.
 * Lives at module scope so `deactivate` (which has no `context` arg) can
 * orchestrate the two-step persistence flush. See: design.md D6.
 */
let _activeSessionManager: SessionManager | null = null;

export async function deactivate(): Promise<void> {
  const sm = _activeSessionManager;
  if (!sm) {
    return;
  }
  _activeSessionManager = null;
  // Step 1 — synchronously write every active session's buffer to disk so
  // partial-flush windows don't lose the most recent state.
  try {
    sm.flushSnapshotsSync();
  } catch (err) {
    console.error("[AnyWhere Terminal] flushSnapshotsSync failed during deactivate:", err);
  }
  // Step 2 — await the index + live-panels Memento updates.
  try {
    await sm.flushIndexAwaited();
  } catch (err) {
    console.error("[AnyWhere Terminal] flushIndexAwaited failed during deactivate:", err);
  }
  // Step 3 — tear down PTYs (idempotent).
  try {
    sm.dispose();
  } catch (err) {
    console.error("[AnyWhere Terminal] SessionManager.dispose failed during deactivate:", err);
  }
}
