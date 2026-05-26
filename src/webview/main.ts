// src/webview/main.ts — AnyWhere Terminal WebView Entry Point (Composition Root)
//
// Wires together extracted modules and provides thin orchestration.
// All business logic lives in dedicated modules.
//
// See: docs/design/xterm-integration.md, docs/design/message-protocol.md

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

import type {
  ExtensionToWebViewMessage,
  HoverPreviewSettings,
  HoverPreviewSettingsMessage,
  InitMessage,
  ThemeChangedMessage,
} from "../types/messages";
import { SETI_FONT_CSS } from "../vendor/seti/setiFontCss";
import { DragDropHandler } from "./DragDropHandler";
import { FileTreeController } from "./fileTree/FileTreeController";
import { FlowControl } from "./flow/FlowControl";
import type { HoverPreviewThemeKind } from "./links/HoverPreviewController";
import { preloadSyntaxHighlighter } from "./links/syntaxRenderer";
import { createMessageRouter } from "./messaging/MessageRouter";
import { createScrollbackDumpHandler } from "./messaging/scrollbackDumpHandler";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ResizeCoordinator } from "./resize/ResizeCoordinator";
import { SplitTreeRenderer } from "./split/SplitTreeRenderer";
import { WebviewStateStore } from "./state/WebviewStateStore";
import { buildTabBarData, handleTabKeyboardShortcut, renderTabBar } from "./TabBarUtils";
import { hideRenameOverlay, repositionRenameOverlay, showRenameOverlay } from "./tabRenameOverlay";
import { formatRestoreDivider } from "./terminal/restoreDivider";
import { TerminalFactory } from "./terminal/TerminalFactory";
import { ThemeManager } from "./theme/ThemeManager";
import { showBanner } from "./ui/BannerService";

// Inject the vendored Seti icon-font @font-face rule (with the woff embedded
// as a data URL) into the document. Lives in the webview bundle because
// esbuild's `.woff: dataurl` loader is configured only for webviewConfig;
// inlining at runtime keeps the extension bundle free of the ~50 KB font.
(() => {
  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-source", "seti-icon-font");
  styleEl.textContent = SETI_FONT_CSS;
  document.head.appendChild(styleEl);
})();

// Kick off Shiki highlighter init in the background; first hover will then
// render synchronously. Failures fall back to plain text in the popup.
void preloadSyntaxHighlighter().catch((err) => {
  console.warn("[AnyWhere Terminal] preloadSyntaxHighlighter failed:", err);
});

// Debug helper for diagnosing wrap-aware link detection. Set true from the
// webview devtools console: `window.__AT_DEBUG_WRAP = true`, then hover the
// problematic path to see the rows, isWrapped flags, and parsed matches.
console.log("[AnyWhere Terminal] To debug hover/link wrapping, run in this console: window.__AT_DEBUG_WRAP = true");

// Webview-local store for the latest theme kind from the host. `TerminalFactory`
// reads this via the getter for each render. Default to `dark` (matches the
// host's mock + most VSCode users) until the first `themeChanged` arrives.
const themeStore: { kind: HoverPreviewThemeKind } = { kind: "dark" };

/**
 * Webview-local snapshot of hover-preview settings. The host posts
 * `hoverPreviewSettings` on init + every config change; controllers / popup
 * read via the closures below. Default mirrors `contributes.configuration`.
 */
const hoverPreviewSettingsStore: { settings: HoverPreviewSettings } = {
  settings: { delay: 300, blockSensitive: true },
};

// ─── State & Services ───────────────────────────────────────────────

const vscode = acquireVsCodeApi();
const store = new WebviewStateStore(vscode);
const themeManager = new ThemeManager("sidebar");
let isComposing = false;

const flowControl = new FlowControl((msg) => vscode.postMessage(msg));
const factory = new TerminalFactory({
  themeManager,
  store,
  postMessage: (msg) => vscode.postMessage(msg),
  onTabBarUpdate: () => updateTabBar(),
  getIsComposing: () => isComposing,
  getHoverPreviewTheme: () => themeStore.kind,
  getHoverPreviewSettings: () => hoverPreviewSettingsStore.settings,
});

const dragDropHandler = new DragDropHandler({
  postMessage: (msg) => vscode.postMessage(msg),
  getActiveSessionId: () => {
    const tabId = store.activeTabId;
    if (!tabId) {
      return null;
    }
    // Resolve to the active pane session ID (not the tab ID) for correct split-pane routing
    return store.tabActivePaneIds.get(tabId) ?? tabId;
  },
  getTerminalExited: () => {
    const tabId = store.activeTabId;
    if (!tabId) {
      return true;
    }
    const paneId = store.tabActivePaneIds.get(tabId) ?? tabId;
    const instance = store.terminals.get(paneId);
    return !instance || instance.exited;
  },
});

const resizeCoordinator = new ResizeCoordinator(
  (instance) => factory.fitTerminal(instance),
  () => ({ activeTabId: store.activeTabId, terminals: store.terminals, tabLayouts: store.tabLayouts }),
);

const splitRenderer = new SplitTreeRenderer({
  store,
  resizeCoordinator,
  flowControl,
  postMessage: (msg) => vscode.postMessage(msg),
  onTabBarUpdate: () => updateTabBar(),
});

// File-tree controller — instantiated lazily on init once we know workspaceRoot +
// rootGeneration from the host. Owns the FileTreePanel + all router handlers
// for the file-tree subsystem. See: webview/fileTree/FileTreeController.ts
// and port-vscode-async-data-tree spec.
let fileTreeController: FileTreeController | null = null;

// ─── Orchestration ──────────────────────────────────────────────────

function updateTabBar(): void {
  const tabBarEl = document.getElementById("tab-bar");
  if (!tabBarEl) {
    return;
  }
  renderTabBar({
    tabBarEl,
    terminals: buildTabBarData(store),
    activeTabId: store.activeTabId,
    onTabClick: (tabId) => switchTab(tabId),
    onTabClose: (tabId) => vscode.postMessage({ type: "closeTab", tabId }),
    onAddClick: () => vscode.postMessage({ type: "createTab" }),
    onTabRename: (tabId, tabEl) => startInlineRename(tabId, tabEl, tabBarEl),
    onAfterRender: () => {
      // If an inline rename is in progress, re-anchor the overlay to the
      // (possibly re-created) tab DOM. See add-tab-rename design.md D4.
      if (store.renameSession) {
        repositionRenameOverlay();
      }
    },
  });
}

function startInlineRename(tabId: string, tabEl: HTMLElement, tabBarEl: HTMLElement): void {
  const tabInfo = buildTabBarData(store).get(tabId);
  if (!tabInfo) {
    return;
  }
  const displayed = tabInfo.customName ?? tabInfo.name;
  // IMPORTANT: showRenameOverlay first, THEN beginRename. If a prior overlay is
  // open, showRenameOverlay commits it — that commit's onCommit closure calls
  // store.endRename() and would clear the new tabId's marker we'd just set.
  // Doing showRenameOverlay first means the prior endRename runs, THEN we set
  // the new beginRename. See `.reviews/round-1.md` W1.
  showRenameOverlay({
    tabBarEl,
    targetTabEl: tabEl,
    initialValue: displayed,
    callbacks: {
      onCommit: (value) => {
        store.endRename();
        vscode.postMessage({ type: "renameTab", tabId, customName: value });
      },
      onCancel: () => {
        store.endRename();
      },
    },
  });
  store.beginRename(tabId, displayed);
}

function switchTab(newTabId: string): void {
  const next = store.terminals.get(newTabId);
  if (!next) {
    return;
  }

  // Hide current tab
  if (store.activeTabId && store.activeTabId !== newTabId) {
    splitRenderer.hideTabContainer(store.activeTabId);
    const current = store.terminals.get(store.activeTabId);
    if (current) {
      current.container.style.display = "none";
    }
  }

  // Show new tab
  store.activeTabId = newTabId;
  splitRenderer.showTabContainer(newTabId);
  next.container.style.display = "block";

  // Fit after display change
  requestAnimationFrame(() => {
    if (!store.terminals.has(newTabId)) {
      return;
    }
    factory.fitAllAndFocus(newTabId, next);
  });

  splitRenderer.updateActivePaneVisual(newTabId);
  updateTabBar();
  vscode.postMessage({ type: "switchTab", tabId: newTabId });
}

function removeTerminal(id: string): void {
  const instance = store.terminals.get(id);
  if (!instance) {
    return;
  }

  // Dispose hover-preview controller BEFORE the terminal goes away so its
  // DOM listeners detach while the terminal's element still exists.
  factory.disposeHoverController(id);

  // Dispose root terminal
  instance.terminal.dispose();
  instance.container.remove();
  store.terminals.delete(id);
  flowControl.delete(id);

  // Delegate split cleanup to renderer
  splitRenderer.removeTab(id);
  store.persist();

  // Switch to next available tab or request new one
  if (store.activeTabId === id) {
    const remaining = Array.from(store.tabLayouts.keys());
    if (remaining.length > 0) {
      switchTab(remaining[remaining.length - 1]);
    } else {
      store.activeTabId = null;
      vscode.postMessage({ type: "createTab" });
    }
  }
  updateTabBar();
}

// ─── Scrollback Dump (export-terminal-session) ───────────────────────

const handleScrollbackDump = createScrollbackDumpHandler({
  getTerminal: (tabId) => store.terminals.get(tabId)?.terminal,
  postMessage: (msg) => vscode.postMessage(msg),
  createSerializeAddon: () => new SerializeAddon(),
});

// ─── Message Router ─────────────────────────────────────────────────

const routeMessage = createMessageRouter({
  onOutput(msg) {
    const dataLen = msg.data.length;
    const instance = store.terminals.get(msg.tabId);
    if (instance) {
      instance.terminal.write(msg.data, () => flowControl.ackChars(dataLen, msg.tabId));
    } else {
      flowControl.ackChars(dataLen, msg.tabId);
    }
  },
  onExit(msg) {
    const instance = store.terminals.get(msg.tabId);
    if (instance) {
      instance.exited = true;
      instance.terminal.write(`\r\n\x1b[90m[Process exited with code ${msg.code}]\x1b[0m\r\n`);
      updateTabBar();
    }
  },
  onTabCreated(msg) {
    factory.createTerminal(msg.tabId, msg.name, store.currentConfig, false, msg.customName);
    switchTab(msg.tabId);
  },
  onTabRemoved(msg) {
    removeTerminal(msg.tabId);
  },
  onTabRenamed(msg) {
    // Mirror the normalized customName into the local instance. If an inline
    // overlay is still mounted for THIS tab (e.g. a parallel rename completed
    // via context menu / F2 while the overlay was open), dismount the overlay
    // so the rendered label updates cleanly.
    const instance = store.terminals.get(msg.tabId);
    if (instance) {
      instance.customName = msg.customName;
    }
    if (store.renameSession?.tabId === msg.tabId) {
      hideRenameOverlay();
      store.endRename();
    }
    updateTabBar();
  },
  onRestore(msg) {
    const instance = store.terminals.get(msg.tabId);
    if (instance) {
      instance.terminal.write(msg.data);
    }
  },
  onConfigUpdate(msg) {
    factory.applyConfig(msg.config);
  },
  onViewShow() {
    resizeCoordinator.onViewShow();
  },
  onSplitPane(msg) {
    if (!store.activeTabId) {
      return;
    }
    const activePaneId = store.tabActivePaneIds.get(store.activeTabId) ?? store.activeTabId;
    vscode.postMessage({
      type: "requestSplitSession",
      direction: msg.direction,
      sourcePaneId: activePaneId,
      rootTabId: store.activeTabId,
    });
  },
  onSplitPaneCreated(msg) {
    splitRenderer.handleSplitPaneCreated(msg, factory);
  },
  onCloseSplitPane() {
    if (!store.activeTabId) {
      return;
    }
    splitRenderer.closeSplitPaneById(store.tabActivePaneIds.get(store.activeTabId) ?? store.activeTabId);
  },
  onCloseSplitPaneById(msg) {
    if (msg.sessionId) {
      splitRenderer.closeSplitPaneById(msg.sessionId);
    }
  },
  onSplitPaneAt(msg) {
    if (store.activeTabId && msg.direction && msg.sourcePaneId) {
      store.tabActivePaneIds.set(store.activeTabId, msg.sourcePaneId);
      splitRenderer.updateActivePaneVisual(store.activeTabId);
      vscode.postMessage({
        type: "requestSplitSession",
        direction: msg.direction,
        sourcePaneId: msg.sourcePaneId,
        rootTabId: store.activeTabId,
      });
    }
  },
  onCtxClear(msg) {
    const instance = msg.sessionId ? store.terminals.get(msg.sessionId) : factory.getActivePaneTerminal();
    if (instance) {
      instance.terminal.clear();
    }
  },
  onError(msg) {
    console.error(`[AnyWhere Terminal] ${msg.severity}: ${msg.message}`);
    const containerEl = document.getElementById("terminal-container");
    if (containerEl) {
      showBanner(containerEl, msg.message, msg.severity);
    }
  },
  onInsertPathEffect() {
    const containerEl = document.getElementById("terminal-container");
    if (!containerEl) {
      return;
    }
    // Remove class first in case animation is still running, then re-add
    containerEl.classList.remove("path-inserted");
    // Force reflow to restart animation
    void containerEl.offsetWidth;
    containerEl.classList.add("path-inserted");
    containerEl.addEventListener("animationend", () => containerEl.classList.remove("path-inserted"), { once: true });
  },
  onFilePreviewResult(msg) {
    // Route by `requestId` is the controller's job — but we look up by session
    // here so a stale message for a since-disposed terminal is silently dropped.
    // The host sends one result per sessionId at most (token-map enforces 1
    // in-flight), so we don't need to fan out across all controllers.
    for (const controller of factory.hoverControllers.values()) {
      controller.onMessage(msg);
    }
  },
  onThemeChanged(msg: ThemeChangedMessage) {
    themeStore.kind = msg.kind;
  },
  onHoverPreviewSettings(msg: HoverPreviewSettingsMessage) {
    hoverPreviewSettingsStore.settings = msg.settings;
    // Push the new debounce into every active controller so the next hover
    // uses it. Existing in-flight timers run to completion under the old delay.
    for (const controller of factory.hoverControllers.values()) {
      controller.setDebounceMs(msg.settings.delay);
    }
  },
  // ── File-tree (port-vscode-async-data-tree) ──
  // All five handlers delegate to FileTreeController, which owns the panel
  // and the lastWorkspaceRoot fallback used by reveal. See
  // webview/fileTree/FileTreeController.ts.
  onReadDirectoryResponse(msg) {
    fileTreeController?.handleReadDirectoryResponse(msg);
  },
  onWorkspaceRootChanged(msg) {
    fileTreeController?.handleWorkspaceRootChanged(msg);
  },
  onToggleFileTree() {
    fileTreeController?.handleToggle();
  },
  onSetFileTreePosition(msg) {
    fileTreeController?.handleSetPosition(msg);
  },
  onRevealInFileTree(msg) {
    if (!fileTreeController) {
      console.warn("[AnyWhere Terminal] reveal-in-file-tree: no file tree controller mounted");
      return;
    }
    fileTreeController.handleReveal(msg);
  },
  onFileTreeSearchResponse(msg) {
    fileTreeController?.handleSearchResponse(msg);
  },
  onGitStatusChanged(msg) {
    fileTreeController?.handleGitStatusChanged(msg);
  },
  onFsChangesInvalidated(msg) {
    fileTreeController?.handleFsChangesInvalidated(msg);
  },
  onFsRehydrate(msg) {
    fileTreeController?.handleFsRehydrate(msg);
  },
  onSetPanelId(msg) {
    // Persist the panel identity so VS Code includes it in the serializer's
    // `state` arg on next reload. See: restore-terminal-sessions design.md D2.
    store.updateState({ panelId: msg.panelId });
    vscode.postMessage({ type: "persistPanelId", panelId: msg.panelId });
  },
  onRequestScrollbackDump(msg) {
    handleScrollbackDump(msg);
  },
  onFlashPane(msg) {
    // Visual confirmation for title-bar export click. Adds `.export-flash`
    // to the matching split-leaf; CSS animation auto-fades. We force a
    // reflow between remove + re-add so a rapid second click restarts the
    // animation (same pattern as onInsertPathEffect above).
    const leaf = document.querySelector<HTMLElement>(`.split-leaf[data-session-id="${CSS.escape(msg.sessionId)}"]`);
    if (!leaf) return;
    leaf.classList.remove("export-flash");
    void leaf.offsetWidth;
    leaf.classList.add("export-flash");
    leaf.addEventListener("animationend", () => leaf.classList.remove("export-flash"), { once: true });
  },
  onRestoreFromSnapshot(msg) {
    // Replay a persisted snapshot into an xterm instance. The typical sequence
    // when triggered cross-restart is: `init` arrives first → factory creates
    // each tab terminal with `open()` called (default). Then this message
    // arrives → we write the buffer and the restore divider; the post-init
    // refit (debouncedFitAllLeaves) owns the live container's true cols/rows.
    // If the instance is missing (defensive — init didn't include this tab),
    // we create one with `deferOpen: true` and finalize the attach here.
    // See: restore-terminal-sessions design.md D8, D9, D13.
    let instance = store.terminals.get(msg.tabId);
    let attachLater = false;
    if (!instance) {
      // Pass isSplitPane through so the factory's `tabLayouts.set(...,
      // createLeaf)` branch is skipped for split-pane children — otherwise
      // a deferOpen revive of a split child would clobber the parent's
      // tabLayouts entry with a bare leaf, collapsing the split tree and
      // persisting the corruption via store.persist(). Defensively default
      // to false (root tab) when the message lacks the field (legacy
      // ext-host wire shape). See .reviews/round-4.md [W4].
      instance = factory.createTerminal(
        msg.tabId,
        msg.tabId,
        store.currentConfig,
        store.activeTabId === msg.tabId,
        null,
        { deferOpen: true, isSplitPane: msg.isSplitPane === true },
      );
      attachLater = true;
    }
    // Resize only for the deferred path — the open-already path's terminal has
    // its REAL container dimensions established by the post-init refit. Writing
    // the snapshot buffer at the persisted (stale) cols/rows and then refit
    // afterwards would mis-wrap any concurrent live PTY output (round-1 W4).
    if (attachLater) {
      try {
        instance.terminal.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
      } catch {
        // resize fails when terminal not yet open — the post-open fit recovers.
      }
    }
    instance.terminal.write(msg.serializedBuffer);
    instance.terminal.write(
      formatRestoreDivider({
        snapshotAt: msg.snapshotAt,
        shellExited: msg.shellExited,
        exitCode: msg.exitCode,
      }),
    );
    if (msg.shellExited) {
      instance.exited = true;
      updateTabBar();
    }
    if (attachLater) {
      factory.attachDeferredTerminal(instance);
      factory.fitTerminal(instance);
    }
  },
});

// ─── Init & Bootstrap ───────────────────────────────────────────────

function handleInit(msg: InitMessage): void {
  store.currentConfig = { ...msg.config };
  const validTabIds = new Set(msg.tabs.map((t) => t.id));

  const restoredLayouts = store.restore();
  for (const [tabId, layout] of restoredLayouts) {
    if (validTabIds.has(tabId)) {
      store.tabLayouts.set(tabId, layout);
    }
  }
  for (const tabId of store.tabActivePaneIds.keys()) {
    if (!validTabIds.has(tabId)) {
      store.tabActivePaneIds.delete(tabId);
    }
  }
  // Create xterm instances for every session. For split-pane children we pass
  // `isSplitPane: true` so the factory skips the per-tab side effects (no new
  // `tabLayouts` leaf, never `activeTabId`) — the root tab's layout already
  // references this pane. See restore-terminal-sessions design.md D12.
  for (const tab of msg.tabs) {
    factory.createTerminal(tab.id, tab.name, msg.config, tab.isActive, tab.customName, {
      isSplitPane: tab.isSplitPane,
    });
  }
  // Build the split-tree DOM for every restored multi-pane tab. Without this,
  // a Cmd+R reload (Phase A) or cross-restart (Phase B) loses the split layout
  // because nothing in the existing init flow re-renders it.
  const splitRootIds: string[] = [];
  for (const [tabId, layout] of store.tabLayouts) {
    if (layout.type === "branch") {
      splitRenderer.renderTabSplitTree(tabId);
      splitRootIds.push(tabId);
    }
  }
  // Reveal the active root tab's split container (no-op when the active tab
  // has no branch layout — the per-terminal `display: block` from createTerminal
  // already shows the single-pane case).
  const activeRootTab = msg.tabs.find((t) => t.isActive && !t.isSplitPane);
  if (activeRootTab) {
    const activeLayout = store.tabLayouts.get(activeRootTab.id);
    if (activeLayout && activeLayout.type === "branch") {
      splitRenderer.showTabContainer(activeRootTab.id);
    }
  }
  // Refit every leaf in each restored split layout. Split-pane children were
  // created with `isActive=false` (their containers started `display: none`,
  // so `terminal.open()` measured a 0×0 box) — without refitting after
  // `renderTabSplitTree` reparents them into visible leaves, the xterm
  // renderer keeps the 0×0 canvas and the pane stays visually blank even
  // though its `restore` payload was written. Mirrors the recovery path in
  // `SplitTreeRenderer.handleSplitPaneCreated`.
  if (splitRootIds.length > 0) {
    requestAnimationFrame(() => {
      for (const tabId of splitRootIds) {
        resizeCoordinator.debouncedFitAllLeaves(tabId);
      }
    });
  }
  const containerEl = document.getElementById("terminal-container");
  if (containerEl) {
    resizeCoordinator.setup(containerEl);
    dragDropHandler.setup(containerEl);
  }

  // File-tree controller — mount once per session. Per-location persistence,
  // defaults, seed-vs-restore, and all five router handlers live inside the
  // controller. See: webview/fileTree/FileTreeController.ts.
  const fileTreeHost = document.getElementById("file-tree");
  const layoutWrapper = document.getElementById("webview-layout");
  if (fileTreeHost && layoutWrapper) {
    fileTreeController = FileTreeController.mount({
      fileTreeHost,
      layoutWrapper,
      init: { workspaceRoot: msg.workspaceRoot, rootGeneration: msg.rootGeneration },
      store,
      postMessage: (m) => vscode.postMessage(m),
      getActiveSessionId: () => {
        const tabId = store.activeTabId;
        if (!tabId) {
          return null;
        }
        return store.tabActivePaneIds.get(tabId) ?? tabId;
      },
      onLayoutChange: () => resizeCoordinator.debouncedFit(),
      getInstanceCwd: (sessionId) => store.terminals.get(sessionId)?.cwd ?? null,
    });
  }

  store.persist();
  updateTabBar();
  showDragDropTip();
}

// ─── Drag-Drop Tip Banner ───────────────────────────────────────────

const DRAG_DROP_TIP_DISMISSED_KEY = "dragDropTipDismissed";

function showDragDropTip(): void {
  // Check if already dismissed
  const state = vscode.getState() as Record<string, unknown> | null;
  if (state?.[DRAG_DROP_TIP_DISMISSED_KEY]) {
    return;
  }

  const tipEl = document.getElementById("drag-drop-tip");
  if (!tipEl) {
    return;
  }

  tipEl.className = "drag-drop-tip";
  tipEl.innerHTML = "";

  const iconSpan = document.createElement("span");
  iconSpan.textContent = "\ud83d\udca1";
  iconSpan.style.fontSize = "13px";
  iconSpan.style.flexShrink = "0";
  tipEl.appendChild(iconSpan);

  const textSpan = document.createElement("span");
  textSpan.className = "drag-drop-tip-text";
  textSpan.textContent =
    'Drag files from Explorer while holding Shift to insert path, or right-click \u2192 "Insert Path in AnyWhere Terminal".';
  tipEl.appendChild(textSpan);

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "drag-drop-tip-dismiss";
  dismissBtn.textContent = "\u00d7";
  dismissBtn.title = "Dismiss";
  dismissBtn.addEventListener("click", () => {
    tipEl.remove();
    // Persist dismissal
    const currentState = (vscode.getState() as Record<string, unknown>) ?? {};
    vscode.setState({ ...currentState, [DRAG_DROP_TIP_DISMISSED_KEY]: true });
    // Refit terminal to reclaim the space freed by the dismissed banner
    resizeCoordinator.debouncedFit();
  });
  tipEl.appendChild(dismissBtn);
}

function bootstrap(): void {
  const locationAttr = document.body.getAttribute("data-terminal-location");
  if (locationAttr === "sidebar" || locationAttr === "panel" || locationAttr === "editor") {
    themeManager.updateLocation(locationAttr);
  }
  themeManager.applyBodyBackground();

  document.addEventListener("compositionstart", () => {
    isComposing = true;
  });
  document.addEventListener("compositionend", () => {
    isComposing = false;
  });
  // Document-level capture handler — runs before xterm so events are
  // intercepted even if the embedding host (or another listener) would
  // otherwise consume them.
  //
  // Handled here:
  // - Shift+Enter → ESC+CR (\x1b\r) so REPLs like Claude Code insert a
  //   newline instead of submitting.
  // - Cmd+Left / Cmd+Right (macOS) → Ctrl+A / Ctrl+E so readline-style
  //   shells jump to start/end of line. xterm.js does not bind these by
  //   default; this matches Terminal.app / iTerm2 / VS Code's terminal.
  // - Option+Left / Option+Right (macOS) → ESC+b / ESC+f for readline
  //   word-jump (backward-word / forward-word). xterm.js's default
  //   behavior with `macOptionIsMeta: false` does not produce these.
  const isMac = navigator.platform.includes("Mac");
  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (isComposing) {
        return;
      }
      const tabId = store.activeTabId;
      const targetId = tabId ? (store.tabActivePaneIds.get(tabId) ?? tabId) : null;
      if (!targetId) {
        return;
      }

      // Shift+Enter → ESC+CR
      if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        vscode.postMessage({ type: "input", tabId: targetId, data: "\x1b\r" });
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // macOS: Cmd+Left → start of line (\x01), Cmd+Right → end of line (\x05),
      // Cmd+Backspace → kill-line (\x15). Handled at document-capture so the
      // shortcut works even when DOM focus is on the file tree or another
      // sibling of the xterm textarea (where xterm's attached keydown handler
      // would otherwise never see the event).
      if (isMac && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (e.key === "ArrowLeft") {
          vscode.postMessage({ type: "input", tabId: targetId, data: "\x01" });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.key === "ArrowRight") {
          vscode.postMessage({ type: "input", tabId: targetId, data: "\x05" });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.key === "Backspace") {
          vscode.postMessage({ type: "input", tabId: targetId, data: "\x15" });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      // Non-mac: Ctrl+Backspace → kill-line (\x15). Same global routing.
      if (!isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === "Backspace") {
        vscode.postMessage({ type: "input", tabId: targetId, data: "\x15" });
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // macOS: Option+Left → backward-word (\x1bb), Option+Right → forward-word (\x1bf)
      if (isMac && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === "ArrowLeft") {
          vscode.postMessage({ type: "input", tabId: targetId, data: "\x1bb" });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.key === "ArrowRight") {
          vscode.postMessage({ type: "input", tabId: targetId, data: "\x1bf" });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    },
    true,
  );
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (handleTabKeyboardShortcut(e, { terminals: store.terminals, activeTabId: store.activeTabId, switchTab })) {
      e.preventDefault();
    }
  });

  // Notify Extension Host when user clicks/focuses the terminal.
  // Sends the resolved active pane session ID so "Insert Path" targets the correct split pane.
  document.addEventListener("focusin", () => {
    const tabId = store.activeTabId;
    const activeSessionId = tabId ? (store.tabActivePaneIds.get(tabId) ?? tabId) : undefined;
    vscode.postMessage({ type: "focus", activeSessionId });
  });
  window.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") {
      return;
    }
    const typed = msg as ExtensionToWebViewMessage;
    if (typed.type === "init") {
      handleInit(typed);
    } else {
      routeMessage(typed);
    }
  });
  window.addEventListener("resize", () => {
    resizeCoordinator.debouncedFit();
  });
  themeManager.startWatching(() => {
    themeManager.applyToAll(store.terminals.values());
  });
  vscode.postMessage({ type: "ready" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
