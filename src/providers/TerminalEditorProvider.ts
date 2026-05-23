import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { SessionManager } from "../session/SessionManager";
import { readTerminalConfig, readTerminalSettings } from "../settings/SettingsReader";
import type { ThemeChangedMessage, WebViewToExtensionMessage } from "../types/messages";
import { FileTreeHost } from "./fileTreeHost";
import { affectsHoverPreview, readHoverPreviewSettings, updateHoverPreviewSetting } from "./hoverPreviewSettings";
import { openExternalLink } from "./openExternalLink";
import { DEFAULT_FIND_FILES_MAX_RESULTS, openFileLink } from "./openFileLink";
import { previewFileLink } from "./previewFileLink";
import { isValidPreviewRequest } from "./previewValidation";
import { readBytesBounded } from "./readBytesBounded";
import { themeKindFor } from "./TerminalViewProvider";
import { getTerminalHtml } from "./webviewHtml";

/**
 * Editor-area terminal provider using WebviewPanel.
 *
 * Unlike TerminalViewProvider (which uses WebviewViewProvider for sidebar/panel),
 * this class creates on-demand WebviewPanels that open as editor tabs.
 * Each call to createPanel() produces an independent terminal with its own PTY.
 * All session operations are delegated to the shared SessionManager.
 *
 * See: docs/design/webview-provider.md#§7
 */
export class TerminalEditorProvider {
  public static readonly viewType = "anywhereTerminal.editor";

  /** Track all active editor panels for config updates. */
  private static readonly _activePanels = new Set<vscode.WebviewPanel>();

  /**
   * Instance registry keyed by the owning WebviewPanel. Populated in
   * `createPanel`, cleared on `panel.onDidDispose`. Lets host-side commands
   * (e.g. rename) resolve "the currently active editor terminal" to a concrete
   * provider whose `getActiveTabId()` can be queried.
   *
   * See add-tab-rename design.md D5.
   */
  private static readonly _instances = new Map<vscode.WebviewPanel, TerminalEditorProvider>();

  /** Get all active editor panels (for pushing config updates). */
  static getActivePanels(): ReadonlySet<vscode.WebviewPanel> {
    return TerminalEditorProvider._activePanels;
  }

  /**
   * Return the editor-area provider whose panel currently holds focus
   * (`panel.active === true`), or undefined. Used by the rename-command
   * resolver (see add-tab-rename design.md D5).
   */
  static getActiveProvider(): TerminalEditorProvider | undefined {
    for (const [panel, provider] of TerminalEditorProvider._instances) {
      if (panel.active) {
        return provider;
      }
    }
    return undefined;
  }

  /**
   * Get the **root tab** id for the active tab in this editor panel — symmetric
   * with `TerminalViewProvider.getActiveTabId()`. Rename always targets the
   * root tab, never a split pane (see add-tab-rename design.md D5).
   */
  getActiveTabId(): string | undefined {
    return this.sessionManager.getTabsForView(this._viewId).find((t) => t.isActive)?.id;
  }

  /** The unique view ID for this editor panel's sessions. */
  private readonly _viewId: string;
  /** Whether the webview has sent the 'ready' message. Gates outbound messages. */
  private _ready = false;
  /** The WebviewPanel managed by this instance. */
  private readonly _panel: vscode.WebviewPanel;
  /**
   * Shared file-tree wiring (rootGeneration, workspaceRoot getter,
   * onDidChangeWorkspaceFolders subscription, message dispatch). Same
   * companion class TerminalViewProvider uses — single point of change
   * keeps the sidebar / panel / editor providers in lockstep.
   * See: providers/fileTreeHost.ts; design.md D10.
   */
  private readonly fileTreeHost = new FileTreeHost();

  /** Public accessor for `extension.ts` ctx command routing. */
  get rootGeneration(): number {
    return this.fileTreeHost.rootGeneration;
  }

  /** Public accessor for `extension.ts` ctx command routing. */
  get workspaceRoot(): string | null {
    return this.fileTreeHost.workspaceRoot;
  }

  /** Public accessor — used by `extension.ts` to route ctx commands. */
  getViewId(): string {
    return this._viewId;
  }

  /** Public accessor — used by `extension.ts` to post messages to this panel. */
  get panel(): vscode.WebviewPanel {
    return this._panel;
  }

  /**
   * Find the editor provider whose `_viewId` matches the given session's
   * `viewId`. Returns undefined when no editor instance owns that session
   * (e.g. it's a sidebar/panel session).
   */
  static findByViewId(viewId: string): TerminalEditorProvider | undefined {
    if (!viewId.startsWith("editor-")) {
      return undefined;
    }
    for (const provider of TerminalEditorProvider._instances.values()) {
      if (provider._viewId === viewId) {
        return provider;
      }
    }
    return undefined;
  }

  /** In-flight hover-preview cancellation tokens, keyed by `sessionId`. See: design.md D9, D10 */
  private readonly _previewTokens = new Map<string, vscode.CancellationTokenSource>();

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    panel: vscode.WebviewPanel,
  ) {
    this._panel = panel;
    this._viewId = `editor-${crypto.randomUUID()}`;
    this.setupPanel();
  }

  /**
   * Create a new terminal panel in the editor area.
   *
   * Each invocation creates an independent terminal with its own PTY.
   * The returned Disposable kills the PTY and disposes the panel on cleanup.
   */
  static createPanel(context: vscode.ExtensionContext, sessionManager: SessionManager): vscode.Disposable {
    const panel = vscode.window.createWebviewPanel(
      TerminalEditorProvider.viewType,
      "Terminal",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );

    const provider = new TerminalEditorProvider(context.extensionUri, sessionManager, panel);

    // Track this panel for config updates + the provider instance for host-side
    // commands (rename). Disposal happens in `setupPanel`'s onDidDispose.
    TerminalEditorProvider._activePanels.add(panel);
    TerminalEditorProvider._instances.set(panel, provider);

    // Return a disposable that cleans up via panel dispose (which triggers onDidDispose → destroyAllForView)
    return {
      dispose: () => {
        panel.dispose();
      },
    };
  }

  /**
   * Set up the panel: HTML content, message handler, dispose handler.
   */
  private setupPanel(): void {
    // 1. Set HTML content using shared utility
    this._panel.webview.html = getTerminalHtml(this._panel.webview, this.extensionUri, "editor");

    // 2. Wire message handler
    const disposables: vscode.Disposable[] = [];

    disposables.push(
      this._panel.webview.onDidReceiveMessage((msg: unknown) => {
        this.handleMessage(msg);
      }),
    );

    // 3a. Wire theme-change bridge for hover-preview popup theming.
    // See: asimov/changes/add-hover-file-preview/design.md D8
    disposables.push(
      vscode.window.onDidChangeActiveColorTheme((theme) => {
        if (!this._ready) {
          return;
        }
        this.safePostMessage({
          type: "themeChanged",
          kind: themeKindFor(theme.kind),
        } satisfies ThemeChangedMessage);
      }),
    );

    // 3a-bis. Wire hover-preview settings bridge. See: design.md D17
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!affectsHoverPreview(event) || !this._ready) {
          return;
        }
        this.safePostMessage({
          type: "hoverPreviewSettings",
          settings: readHoverPreviewSettings(),
        });
      }),
    );

    // 3b. Wire visibility handler (for deferred resize on tab switch)
    disposables.push(
      this._panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible && this._ready) {
          this.safePostMessage({ type: "viewShow" });
        }
      }),
    );

    // 3c. Workspace-folder bridge — delegated to fileTreeHost so all three
    // providers (sidebar/panel/editor) stay in lockstep on file-tree state.
    disposables.push(
      this.fileTreeHost.attach({
        isReady: () => this._ready,
        post: (msg) => this.safePostMessage(msg),
      }),
    );

    // 4. Wire dispose handler — clean up all subscriptions and sessions
    this._panel.onDidDispose(() => {
      for (const d of disposables) {
        d.dispose();
      }
      // Cancel + dispose any in-flight preview tokens (D10).
      this.cancelAllPreviewTokens();
      TerminalEditorProvider._activePanels.delete(this._panel);
      TerminalEditorProvider._instances.delete(this._panel);
      this.sessionManager.destroyAllForView(this._viewId);
    });
  }

  /**
   * Cancel the in-flight preview token for `sessionId` and remove it from the
   * map. Does NOT dispose — disposal is owned by the handler's finally block
   * so in-flight `isCancellationRequested` checks remain safe. See round-1 W6.
   */
  private cancelPreviewToken(sessionId: string): void {
    const prior = this._previewTokens.get(sessionId);
    if (prior) {
      try {
        prior.cancel();
      } catch {
        // Best-effort.
      }
      this._previewTokens.delete(sessionId);
    }
  }

  /** Cancel + dispose ALL in-flight preview tokens. */
  private cancelAllPreviewTokens(): void {
    for (const sessionId of [...this._previewTokens.keys()]) {
      this.cancelPreviewToken(sessionId);
    }
  }

  /** Handle a hover-preview request. See: design.md D9 */
  private async handleRequestFilePreview(
    message: Extract<WebViewToExtensionMessage, { type: "requestFilePreview" }>,
  ): Promise<void> {
    // Reject unknown sessionId BEFORE resolution work — see TerminalViewProvider
    // counterpart + round-2 W3.
    if (!this.sessionManager.getSession(message.sessionId)) {
      return;
    }
    this.cancelPreviewToken(message.sessionId);
    const source = new vscode.CancellationTokenSource();
    this._previewTokens.set(message.sessionId, source);
    try {
      const allSettings = readHoverPreviewSettings();
      const result = await previewFileLink(
        message,
        {
          getInitialCwd: (id) => this.sessionManager.getInitialCwd(id),
          getCurrentCwd: (id) => this.sessionManager.getCurrentCwd(id),
          getLiveCwd: (id) => this.sessionManager.getLiveCwd(id),
          workspaceFolders: vscode.workspace.workspaceFolders,
          fs: {
            stat: (uri) => vscode.workspace.fs.stat(uri),
            readFile: (uri) => vscode.workspace.fs.readFile(uri),
            readBytes: (uri, maxBytes) => readBytesBounded(uri, maxBytes),
          },
          findFiles: (include, exclude, maxResults, token) =>
            vscode.workspace.findFiles(include, exclude, maxResults, token),
          uriFactory: { file: vscode.Uri.file },
          createCancellationTokenSource: () => new vscode.CancellationTokenSource(),
          directoryFileType: vscode.FileType.Directory,
          symbolicLinkFileType: vscode.FileType.SymbolicLink,
          relativePatternFactory: (base, glob) => new vscode.RelativePattern(base, glob),
          settings: { blockSensitive: allSettings.blockSensitive },
        },
        source.token,
      );
      if (result && !source.token.isCancellationRequested) {
        this.safePostMessage(result);
      }
    } catch (err) {
      console.warn("[AnyWhere Terminal] requestFilePreview failed (editor):", err);
    } finally {
      if (this._previewTokens.get(message.sessionId) === source) {
        this._previewTokens.delete(message.sessionId);
      }
      // Always dispose our own source — review round-1 W6.
      try {
        source.dispose();
      } catch {
        // Best-effort.
      }
    }
  }

  /**
   * Route incoming webview messages to appropriate handlers.
   *
   * See: docs/design/webview-provider.md#§8, docs/design/message-protocol.md#§10
   */
  private handleMessage(msg: unknown): void {
    // Basic shape validation
    if (!msg || typeof msg !== "object" || !("type" in msg) || typeof (msg as { type: unknown }).type !== "string") {
      console.warn("[AnyWhere Terminal] Invalid message from editor webview:", msg);
      return;
    }

    const message = msg as WebViewToExtensionMessage;

    try {
      switch (message.type) {
        case "ready":
          this.onReady();
          break;

        case "input":
          if (typeof message.tabId === "string" && typeof message.data === "string") {
            this.sessionManager.writeToSession(message.tabId, message.data);
          }
          break;

        case "resize":
          if (
            typeof message.tabId === "string" &&
            typeof message.cols === "number" &&
            typeof message.rows === "number" &&
            Number.isFinite(message.cols) &&
            Number.isFinite(message.rows)
          ) {
            this.sessionManager.resizeSession(message.tabId, message.cols, message.rows);
          }
          break;

        case "ack":
          if (typeof message.charCount === "number" && typeof message.tabId === "string") {
            this.sessionManager.handleAck(message.tabId, message.charCount);
          }
          break;

        case "createTab": {
          const createSettings = readTerminalSettings();
          const newSessionId = this.sessionManager.createSession(this._viewId, this._panel.webview, {
            shell: createSettings.shell,
            shellArgs: createSettings.shellArgs,
            cwd: createSettings.cwd,
          });
          const newSession = this.sessionManager.getSession(newSessionId);
          if (newSession) {
            this.safePostMessage({
              type: "tabCreated",
              tabId: newSessionId,
              name: newSession.name,
              customName: newSession.customName,
            });
          }
          break;
        }

        case "switchTab":
          if (typeof message.tabId === "string") {
            this.sessionManager.switchActiveSession(this._viewId, message.tabId);
          }
          break;

        case "closeTab":
          if (typeof message.tabId === "string") {
            this.cancelPreviewToken(message.tabId);
            this.sessionManager.destroySession(message.tabId);
            this.safePostMessage({
              type: "tabRemoved",
              tabId: message.tabId,
            });
          }
          break;

        case "renameTab":
          if (typeof message.tabId === "string") {
            this.sessionManager.renameSession(message.tabId, message.customName ?? null);
          }
          break;

        case "requestCloseSplitPane": {
          // Mirrors TerminalViewProvider — cancel the in-flight hover preview
          // for the pane being closed BEFORE destroying its session.
          if (typeof (message as { sessionId?: unknown }).sessionId === "string") {
            const closeMsg = message as { sessionId: string };
            this.cancelPreviewToken(closeMsg.sessionId);
            this.sessionManager.destroySession(closeMsg.sessionId);
          }
          break;
        }

        case "clear":
          if (typeof message.tabId === "string") {
            this.sessionManager.clearScrollback(message.tabId);
          }
          break;

        case "request-read-directory":
        case "request-set-file-tree-position":
          // Both file-tree messages are dispatched by FileTreeHost so the
          // sidebar / panel / editor providers share one wiring. See
          // providers/fileTreeHost.ts.
          this.fileTreeHost.handleMessage(message, (response) => this.safePostMessage(response));
          break;

        case "openLink":
          if (typeof message.url === "string") {
            void openExternalLink(message.url);
          }
          break;

        case "openFile":
          if (typeof message.path === "string" && typeof message.sessionId === "string") {
            void openFileLink(message, {
              getInitialCwd: (id) => this.sessionManager.getInitialCwd(id),
              getCurrentCwd: (id) => this.sessionManager.getCurrentCwd(id),
              getLiveCwd: (id) => this.sessionManager.getLiveCwd(id),
              workspaceFolders: vscode.workspace.workspaceFolders,
              stat: (uri) => vscode.workspace.fs.stat(uri),
              findFiles: (include, exclude, maxResults, token) =>
                vscode.workspace.findFiles(include, exclude, maxResults, token),
              showWarning: vscode.window.showWarningMessage,
              showError: vscode.window.showErrorMessage,
              showTextDocument: vscode.window.showTextDocument,
              showQuickPick: vscode.window.showQuickPick,
              getFileSearchMaxResults: () =>
                vscode.workspace
                  .getConfiguration("anywhereTerminal.fileSearch")
                  .get<number>("maxResults", DEFAULT_FIND_FILES_MAX_RESULTS),
            });
          }
          break;

        case "requestFilePreview":
          if (isValidPreviewRequest(message)) {
            void this.handleRequestFilePreview(message);
          }
          break;

        case "updateHoverPreviewSetting":
          // Mirrors TerminalViewProvider — webview-driven setting update.
          if (
            typeof (message as { key?: unknown }).key === "string" &&
            (typeof (message as { value?: unknown }).value === "boolean" ||
              typeof (message as { value?: unknown }).value === "number")
          ) {
            void updateHoverPreviewSetting(
              (message as { key: string }).key as Parameters<typeof updateHoverPreviewSetting>[0],
              (message as { value: boolean | number }).value,
            ).catch((err) => {
              console.warn("[AnyWhere Terminal] updateHoverPreviewSetting failed (editor):", err);
            });
          }
          break;

        default:
          break;
      }
    } catch (err) {
      console.error(`[AnyWhere Terminal] Error handling editor message ${message.type}:`, err);
    }
  }

  /**
   * Handle the 'ready' message from the webview.
   * Creates a session via SessionManager and sends 'init' to the webview.
   */
  private onReady(): void {
    this._ready = true;

    // Post the initial theme so the popup renderer can pick the right Shiki
    // theme before the first hover.
    this.safePostMessage({
      type: "themeChanged",
      kind: themeKindFor(vscode.window.activeColorTheme.kind),
    } satisfies ThemeChangedMessage);

    // Post initial hover-preview settings — see design.md D17.
    this.safePostMessage({
      type: "hoverPreviewSettings",
      settings: readHoverPreviewSettings(),
    });

    try {
      // Create initial session via SessionManager with resolved settings
      const settings = readTerminalSettings();
      this.sessionManager.createSession(this._viewId, this._panel.webview, {
        shell: settings.shell,
        shellArgs: settings.shellArgs,
        cwd: settings.cwd,
      });

      // Get tabs for the init message
      const tabs = this.sessionManager.getTabsForView(this._viewId);

      this.safePostMessage({
        type: "init",
        tabs,
        config: readTerminalConfig(),
        ...this.fileTreeHost.initPayload(),
      });
    } catch (err) {
      console.error("[AnyWhere Terminal] Failed to initialize editor terminal:", err);

      this.safePostMessage({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to initialize terminal",
        severity: "error",
      });
    }
  }

  /**
   * Safely post a message to the webview, handling both sync throws and async rejections.
   */
  private safePostMessage(message: unknown): void {
    try {
      void (this._panel.webview.postMessage(message) as Thenable<boolean>).then(undefined, () => {
        // Async rejection — webview may be disposed
      });
    } catch {
      // Sync throw — webview may be disposed
    }
  }
}
