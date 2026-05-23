// src/webview/messaging/MessageRouter.ts — Typed message dispatch
//
// Replaces the monolithic switch statement with a typed dispatch table.
// Each message type maps to a named handler from the MessageHandlers interface.
//
// See: docs/design/message-protocol.md

import type {
  CloseSplitPaneByIdMessage,
  ConfigUpdateMessage,
  CtxClearMessage,
  ErrorMessage,
  ExitMessage,
  ExtensionToWebViewMessage,
  FilePreviewResultMessage,
  HoverPreviewSettingsMessage,
  InsertPathEffectMessage,
  OutputMessage,
  ReadDirectoryResponseMessage,
  RestoreMessage,
  RevealInFileTreeMessage,
  SetFileTreePositionMessage,
  SplitPaneAtMessage,
  SplitPaneCreatedMessage,
  SplitPaneMessage,
  TabCreatedMessage,
  TabRemovedMessage,
  TabRenamedMessage,
  ThemeChangedMessage,
  ToggleFileTreeMessage,
  WorkspaceRootChangedMessage,
} from "../../types/messages";

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Handler interface for non-init message types.
 * Each handler receives the typed message payload.
 * Handlers with no payload take no arguments.
 *
 * `init` is excluded — it's bootstrap orchestration handled directly by main.ts.
 */
export interface MessageHandlers {
  onOutput(msg: OutputMessage): void;
  onExit(msg: ExitMessage): void;
  onTabCreated(msg: TabCreatedMessage): void;
  onTabRemoved(msg: TabRemovedMessage): void;
  onTabRenamed(msg: TabRenamedMessage): void;
  onRestore(msg: RestoreMessage): void;
  onConfigUpdate(msg: ConfigUpdateMessage): void;
  onViewShow(): void;
  onSplitPane(msg: SplitPaneMessage): void;
  onSplitPaneCreated(msg: SplitPaneCreatedMessage): void;
  onCloseSplitPane(): void;
  onCloseSplitPaneById(msg: CloseSplitPaneByIdMessage): void;
  onSplitPaneAt(msg: SplitPaneAtMessage): void;
  onCtxClear(msg: CtxClearMessage): void;
  onError(msg: ErrorMessage): void;
  onInsertPathEffect(msg: InsertPathEffectMessage): void;
  onFilePreviewResult(msg: FilePreviewResultMessage): void;
  onThemeChanged(msg: ThemeChangedMessage): void;
  onHoverPreviewSettings(msg: HoverPreviewSettingsMessage): void;
  // ── File-tree (port-vscode-async-data-tree) ──
  onReadDirectoryResponse(msg: ReadDirectoryResponseMessage): void;
  onWorkspaceRootChanged(msg: WorkspaceRootChangedMessage): void;
  onToggleFileTree(msg: ToggleFileTreeMessage): void;
  onSetFileTreePosition(msg: SetFileTreePositionMessage): void;
  onRevealInFileTree(msg: RevealInFileTreeMessage): void;
}

// ─── Factory ────────────────────────────────────────────────────────

/**
 * Create a message router function that dispatches to typed handlers.
 *
 * The `init` message type is NOT routed — it must be handled separately
 * by the caller (main.ts bootstrap). Unknown message types are silently
 * ignored (matches current behavior).
 *
 * @param handlers - Object implementing the MessageHandlers interface
 * @returns A dispatch function that routes ExtensionToWebViewMessage to the correct handler
 */
export function createMessageRouter(handlers: MessageHandlers): (msg: ExtensionToWebViewMessage) => void {
  return (msg: ExtensionToWebViewMessage): void => {
    switch (msg.type) {
      case "output":
        handlers.onOutput(msg);
        break;
      case "exit":
        handlers.onExit(msg);
        break;
      case "tabCreated":
        handlers.onTabCreated(msg);
        break;
      case "tabRemoved":
        handlers.onTabRemoved(msg);
        break;
      case "tabRenamed":
        handlers.onTabRenamed(msg);
        break;
      case "restore":
        handlers.onRestore(msg);
        break;
      case "configUpdate":
        handlers.onConfigUpdate(msg);
        break;
      case "viewShow":
        handlers.onViewShow();
        break;
      case "splitPane":
        handlers.onSplitPane(msg);
        break;
      case "splitPaneCreated":
        handlers.onSplitPaneCreated(msg);
        break;
      case "closeSplitPane":
        handlers.onCloseSplitPane();
        break;
      case "closeSplitPaneById":
        handlers.onCloseSplitPaneById(msg);
        break;
      case "splitPaneAt":
        handlers.onSplitPaneAt(msg);
        break;
      case "ctxClear":
        handlers.onCtxClear(msg);
        break;
      case "error":
        handlers.onError(msg);
        break;
      case "insertPathEffect":
        handlers.onInsertPathEffect(msg);
        break;
      case "filePreviewResult":
        handlers.onFilePreviewResult(msg);
        break;
      case "themeChanged":
        handlers.onThemeChanged(msg);
        break;
      case "hoverPreviewSettings":
        handlers.onHoverPreviewSettings(msg);
        break;
      case "read-directory-response":
        handlers.onReadDirectoryResponse(msg);
        break;
      case "workspace-root-changed":
        handlers.onWorkspaceRootChanged(msg);
        break;
      case "toggle-file-tree":
        handlers.onToggleFileTree(msg);
        break;
      case "set-file-tree-position":
        handlers.onSetFileTreePosition(msg);
        break;
      case "reveal-in-file-tree":
        handlers.onRevealInFileTree(msg);
        break;
      case "init":
        // init is handled directly by main.ts — not routed
        break;
      default:
        // Silently ignore unknown message types
        break;
    }
  };
}
