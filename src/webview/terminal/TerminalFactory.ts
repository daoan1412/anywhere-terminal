// src/webview/terminal/TerminalFactory.ts — Terminal creation and configuration
//
// Encapsulates terminal instance creation, addon loading, WebGL management,
// input handler wiring, and config application.
//
// See: docs/design/xterm-integration.md#§3-§6

import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { HoverPreviewSettings, TerminalConfig } from "../../types/messages";
import { type ClipboardProvider, createKeyEventHandler } from "../InputHandler";
import { FilePathLinkProvider } from "../links/FilePathLinkProvider";
import { HoverPreviewController, type HoverPreviewThemeKind } from "../links/HoverPreviewController";
import { HoverPreviewPopup } from "../links/HoverPreviewPopup";
import { createMarkdownRenderer } from "../links/markdownRenderer";
import { createSyntaxRenderer, isHighlighterReady, whenHighlighterReady } from "../links/syntaxRenderer";
import { fitTerminal as fitTerminalCore } from "../resize/XtermFitService";
import { createLeaf, getAllSessionIds } from "../SplitModel";
import type { TerminalInstance, WebviewStateStore } from "../state/WebviewStateStore";
import type { ThemeManager } from "../theme/ThemeManager";

// ─── TerminalFactory ────────────────────────────────────────────────

/** Dependencies injected into TerminalFactory. */
export interface TerminalFactoryDeps {
  themeManager: ThemeManager;
  store: WebviewStateStore;
  postMessage: (msg: unknown) => void;
  onTabBarUpdate: () => void;
  getIsComposing: () => boolean;
  /**
   * Reads the latest theme kind for the hover-preview popup. Driven by the
   * extension host's `themeChanged` IPC.
   */
  getHoverPreviewTheme: () => HoverPreviewThemeKind;
  /**
   * Reads the latest hover-preview settings (debounce, wrap, enabled, etc).
   * Driven by the host's `hoverPreviewSettings` IPC.
   */
  getHoverPreviewSettings: () => HoverPreviewSettings;
}

/**
 * Factory for creating and configuring terminal instances.
 *
 * Owns:
 * - `createTerminal()` — full terminal creation pipeline
 * - `attachInputHandler()` — keyboard/clipboard/onData wiring
 * - `getClipboardProvider()` — browser clipboard abstraction
 * - `getFontFamily()` — CSS variable font resolution
 * - `fitTerminal()` — fit-to-container delegation
 * - `applyConfig()` — partial config update to all terminals
 * - `getActivePaneTerminal()` — active pane terminal lookup
 * - `webglFailed` — WebGL failure tracking (prevents retries)
 */
export class TerminalFactory {
  /** Whether WebGL initialization has failed — prevents retrying on subsequent terminals. */
  private webglFailed = false;

  private readonly themeManager: ThemeManager;
  private readonly store: WebviewStateStore;
  private readonly postMessage: (msg: unknown) => void;
  private readonly onTabBarUpdate: () => void;
  private readonly getIsComposing: () => boolean;
  private readonly getHoverPreviewTheme: () => HoverPreviewThemeKind;
  private readonly getHoverPreviewSettings: () => HoverPreviewSettings;

  /**
   * Active hover-preview controllers indexed by session id. main.ts routes
   * `filePreviewResult` to `controllers.get(sessionId).onMessage(msg)`.
   */
  readonly hoverControllers = new Map<string, HoverPreviewController>();

  constructor(deps: TerminalFactoryDeps) {
    this.themeManager = deps.themeManager;
    this.store = deps.store;
    this.postMessage = deps.postMessage;
    this.onTabBarUpdate = deps.onTabBarUpdate;
    this.getIsComposing = deps.getIsComposing;
    this.getHoverPreviewTheme = deps.getHoverPreviewTheme;
    this.getHoverPreviewSettings = deps.getHoverPreviewSettings;
  }

  /**
   * Fit a single terminal to its container.
   * Delegates to XtermFitService for dimension calculation,
   * then performs the resize if needed.
   */
  fitTerminal(instance: { terminal: Terminal; container: HTMLDivElement }): void {
    const parentElement = instance.terminal.element?.parentElement;
    if (!parentElement) {
      return;
    }

    const result = fitTerminalCore(instance.terminal, parentElement);
    if (result) {
      instance.terminal.resize(result.cols, result.rows);
    }
  }

  /**
   * Get the font family from CSS variables or use default.
   */
  getFontFamily(): string {
    const style = getComputedStyle(document.documentElement);
    const fontFamily = style.getPropertyValue("--vscode-editor-font-family").trim();
    return fontFamily || "monospace";
  }

  /** Build a ClipboardProvider from the browser's navigator.clipboard API. */
  getClipboardProvider(): ClipboardProvider | undefined {
    if (!navigator.clipboard) {
      return undefined;
    }
    return {
      readText: () => navigator.clipboard.readText(),
      writeText: (text: string) => navigator.clipboard.writeText(text),
    };
  }

  /**
   * Attach the custom key event handler and input wiring to a terminal.
   * Uses the extracted InputHandler module for testability.
   * See: docs/design/keyboard-input.md#§2
   */
  attachInputHandler(terminal: Terminal, tabId: string): void {
    const handler = createKeyEventHandler({
      terminal,
      clipboard: this.getClipboardProvider(),
      postMessage: (msg: unknown) => this.postMessage(msg),
      getActiveTabId: () => this.store.activeTabId,
      getIsComposing: this.getIsComposing,
      isMac: navigator.platform.includes("Mac"),
    });

    terminal.attachCustomKeyEventHandler(handler);

    // Wire terminal.onData -> send input to extension
    terminal.onData((data: string) => {
      // Check if this terminal has exited — don't forward input
      const instance = this.store.terminals.get(tabId);
      if (instance?.exited) {
        return;
      }

      this.postMessage({ type: "input", tabId, data });
    });
  }

  /**
   * Create a new terminal instance with addons.
   * See: docs/design/xterm-integration.md#§3-§6
   */
  createTerminal(id: string, name: string, config: TerminalConfig, isActive: boolean): TerminalInstance {
    const containerEl = document.getElementById("terminal-container");
    if (!containerEl) {
      throw new Error("[AnyWhere Terminal] #terminal-container not found");
    }

    // Create dedicated container div for this terminal
    const container = document.createElement("div");
    container.style.width = "100%";
    container.style.height = "100%";
    container.style.display = isActive ? "block" : "none";
    // VS Code native context menu support — always set on terminal container
    container.dataset.vscodeContext = JSON.stringify({
      webviewSection: "splitPane",
      paneSessionId: id,
    });
    containerEl.appendChild(container);

    // Create xterm.js Terminal with config
    // overviewRuler.width=1 makes FitAddon deduct only 1px instead of the default 14px
    const resolvedFontFamily = config.fontFamily || this.getFontFamily();
    const terminal = new Terminal({
      scrollback: config.scrollback || 10000,
      cursorBlink: config.cursorBlink ?? true,
      cursorStyle: "block",
      fontSize: config.fontSize || 14,
      fontFamily: resolvedFontFamily,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: this.themeManager.getMinimumContrastRatio(),
      rightClickSelectsWord: false,
      fastScrollSensitivity: 5,
      tabStopWidth: 8,
      theme: this.themeManager.getTheme(),
      overviewRuler: { width: 1 },
    });

    // Load addons
    const fitAddon = new FitAddon();
    // VS Code webviews block window.open, so route the click through the
    // extension host which calls vscode.env.openExternal().
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      this.postMessage({ type: "openLink", url: uri });
    });
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    // Build the hover-preview controller + renderers + popup for this terminal.
    // The controller is also registered in `hoverControllers` so main.ts can
    // route `filePreviewResult` messages by session id.
    // See: asimov/changes/add-hover-file-preview/design.md "Architecture", D10
    const syntaxRenderer = createSyntaxRenderer({ getTheme: this.getHoverPreviewTheme });
    const markdownRenderer = createMarkdownRenderer({ getTheme: this.getHoverPreviewTheme });
    // Schedule a re-render once the Shiki highlighter finishes loading. The
    // initial render at first-hover falls back to plain `<pre>` when the
    // singleton isn't yet ready (round-1 W4); this wrapper re-injects styled
    // HTML once Shiki resolves, only if the element is still in the DOM.
    //
    // `onAsyncRefresh` (round-2 W5) is invoked AFTER innerHTML replacement so
    // the popup can re-apply the active-line highlight + scroll. Without it,
    // the first hover with a `:line` suffix loses focus the moment Shiki
    // catches up (it replaces the plain-text DOM that held the active class).
    const renderCodeWithRefresh = (
      content: string,
      languageId: string,
      theme: HoverPreviewThemeKind,
      onAsyncRefresh?: () => void,
    ): HTMLElement => {
      const el = syntaxRenderer.renderElement(content, languageId, theme);
      if (!isHighlighterReady()) {
        void whenHighlighterReady().then(() => {
          if (el.isConnected) {
            el.innerHTML = syntaxRenderer.renderElement(content, languageId, theme).innerHTML;
            try {
              onAsyncRefresh?.();
            } catch {
              // Best-effort — popup's reapply must never throw out of here.
            }
          }
        });
      }
      return el;
    };
    const renderMarkdownWithRefresh = (
      content: string,
      theme: HoverPreviewThemeKind,
      onAsyncRefresh?: () => void,
    ): HTMLElement => {
      const el = markdownRenderer.render(content, theme);
      if (!isHighlighterReady()) {
        void whenHighlighterReady().then(() => {
          if (el.isConnected) {
            el.innerHTML = markdownRenderer.render(content, theme).innerHTML;
            try {
              onAsyncRefresh?.();
            } catch {
              // Best-effort.
            }
          }
        });
      }
      return el;
    };
    // Forward-declared so the popup's `onDismiss` callback can invalidate the
    // controller's `activeRequestId` even when dismissal originates inside
    // the popup itself (e.g. Escape key pressed while popup is shown).
    let hoverController: HoverPreviewController;
    const hoverPopup = new HoverPreviewPopup({
      renderCode: renderCodeWithRefresh,
      renderMarkdown: renderMarkdownWithRefresh,
      onDismiss: () => hoverController?.dismiss(),
      // Forward popup pointer enter/leave to the controller so the leave-grace
      // timer doesn't fire while the cursor is over the popup. Without these
      // hooks, `link.leave` dismisses the popup the instant the cursor crosses
      // the 12px gap between link and popup, blocking scroll/interaction.
      onPointerEnter: () => hoverController?.onPopupEnter(),
      onPointerLeave: () => hoverController?.onPopupLeave(),
      getSettings: () => this.getHoverPreviewSettings(),
      onUpdateSetting: (key, value) => this.postMessage({ type: "updateHoverPreviewSetting", key, value }),
      // Header "Open" button → reuse the same openFile flow as clicking the
      // underlined link in the terminal. Prefer absPath so the host's resolver
      // hits the absolute candidate first; fall back to the echoed request
      // path when absPath is absent (e.g. ambiguous match).
      onOpenFile: (result) => {
        const openPath =
          (result.status === "ok" ||
          result.status === "binary" ||
          result.status === "too-large" ||
          result.status === "requires-confirmation"
            ? result.absPath
            : undefined) ?? result.path;
        this.postMessage({
          type: "openFile",
          path: openPath,
          sessionId: id,
          ...(result.line !== undefined ? { line: result.line } : {}),
        });
      },
    });
    hoverController = new HoverPreviewController({
      terminal,
      sessionId: id,
      postMessage: (msg) => this.postMessage(msg),
      getTheme: this.getHoverPreviewTheme,
      popup: hoverPopup,
      debounceMs: this.getHoverPreviewSettings().delay,
    });
    this.hoverControllers.set(id, hoverController);

    // Register a custom link provider for file paths in terminal output.
    // Underlines + cursor:pointer come from xterm's built-in link decorations;
    // activation posts an `openFile` message that the extension host resolves
    // against the PTY's initial cwd and any workspace folder.
    terminal.registerLinkProvider(
      new FilePathLinkProvider({
        terminal,
        sessionId: id,
        postMessage: (msg) => this.postMessage(msg),
        platform: navigator.platform.includes("Win") ? "win32" : "posix",
        hoverController,
      }),
    );

    // Open terminal in container
    terminal.open(container);

    // Try to enable WebGL renderer for better rendering on Retina displays
    if (!this.webglFailed) {
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
          this.webglFailed = true;
          console.warn("[AnyWhere Terminal] WebGL context lost, falling back to canvas renderer");
        });
        terminal.loadAddon(webglAddon);
      } catch {
        this.webglFailed = true;
        console.warn("[AnyWhere Terminal] WebGL renderer failed, using canvas fallback for all future terminals");
      }
    }

    // Wire resize event -> send resize message to extension
    terminal.onResize(({ cols, rows }) => {
      this.postMessage({ type: "resize", tabId: id, cols, rows });
    });

    // Attach input handler (keyboard + clipboard + onData)
    this.attachInputHandler(terminal, id);

    const instance: TerminalInstance = {
      id,
      name,
      terminal,
      container,
      exited: false,
    };

    this.store.terminals.set(id, instance);

    // Listen for OSC title change events
    terminal.onTitleChange((newTitle: string) => {
      if (newTitle) {
        instance.name = newTitle;
        this.onTabBarUpdate();
      }
    });

    // Initialize split layout for this tab (single leaf)
    if (!this.store.tabLayouts.has(id)) {
      this.store.tabLayouts.set(id, createLeaf(id));
      this.store.tabActivePaneIds.set(id, id);
      this.store.persist();
    }

    if (isActive) {
      this.store.activeTabId = id;
    }

    // Fit after opening (deferred to allow layout to settle)
    setTimeout(() => {
      // Guard: terminal may have been disposed during async delay
      if (!this.store.terminals.has(id)) {
        return;
      }
      this.fitTerminal(instance);
      if (isActive) {
        terminal.focus();
      }
    }, 0);

    return instance;
  }

  /**
   * Apply a partial config update to all terminal instances.
   * See: docs/design/xterm-integration.md#§8
   */
  applyConfig(config: Partial<TerminalConfig>): void {
    // Persist config changes for future tab creation
    if (config.fontSize !== undefined) {
      this.store.currentConfig.fontSize = config.fontSize;
    }
    if (config.cursorBlink !== undefined) {
      this.store.currentConfig.cursorBlink = config.cursorBlink;
    }
    if (config.scrollback !== undefined) {
      this.store.currentConfig.scrollback = config.scrollback;
    }
    if (config.fontFamily !== undefined) {
      this.store.currentConfig.fontFamily = config.fontFamily;
    }

    const needsRefit = config.fontSize !== undefined || config.fontFamily !== undefined;

    for (const instance of this.store.terminals.values()) {
      const term = instance.terminal;

      if (config.fontSize !== undefined) {
        // fontSize 0 means "inherit from editor" — use fallback
        term.options.fontSize = config.fontSize || 14;
      }
      if (config.cursorBlink !== undefined) {
        term.options.cursorBlink = config.cursorBlink;
      }
      if (config.scrollback !== undefined) {
        term.options.scrollback = config.scrollback;
      }
      if (config.fontFamily !== undefined) {
        // Empty fontFamily falls back to CSS variable → 'monospace'
        term.options.fontFamily = config.fontFamily || this.getFontFamily();
      }

      // Refit after font changes (affects cell dimensions)
      if (needsRefit) {
        this.fitTerminal(instance);
      }
    }
  }

  /**
   * Fit all terminal leaves in a tab's layout and focus the active pane.
   * Used by switchTab after the tab container is made visible.
   */
  fitAllAndFocus(tabId: string, fallbackInstance: TerminalInstance): void {
    const layout = this.store.tabLayouts.get(tabId);
    if (layout) {
      for (const sessionId of getAllSessionIds(layout)) {
        const instance = this.store.terminals.get(sessionId);
        if (instance) {
          this.fitTerminal(instance);
        }
      }
    } else {
      this.fitTerminal(fallbackInstance);
    }
    const activePaneId = this.store.tabActivePaneIds.get(tabId) ?? tabId;
    const activeInstance = this.store.terminals.get(activePaneId);
    if (activeInstance) {
      activeInstance.terminal.focus();
    } else {
      fallbackInstance.terminal.focus();
    }
  }

  /**
   * Dispose hover-preview controller for a session. Idempotent; safe to call
   * even when no controller is registered (e.g. terminal never opened).
   *
   * See: asimov/changes/add-hover-file-preview/design.md D10
   */
  disposeHoverController(sessionId: string): void {
    const controller = this.hoverControllers.get(sessionId);
    if (controller) {
      try {
        controller.dispose();
      } catch {
        // Best-effort.
      }
      this.hoverControllers.delete(sessionId);
    }
  }

  /** Get the terminal instance for the active pane in the current tab. */
  getActivePaneTerminal(): TerminalInstance | undefined {
    if (!this.store.activeTabId) {
      return undefined;
    }
    const activePaneId = this.store.tabActivePaneIds.get(this.store.activeTabId) ?? this.store.activeTabId;
    return this.store.terminals.get(activePaneId);
  }
}
