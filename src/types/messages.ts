// src/types/messages.ts — Shared message type definitions for AnyWhere Terminal
// Used by both Extension Host and WebView code.
// See: docs/design/message-protocol.md

// ─── Shared Types ───────────────────────────────────────────────────

/** Terminal configuration (maps to anywhereTerminal.* settings). */
export interface TerminalConfig {
  /** Font size in pixels (0 = inherit from VS Code editor) */
  fontSize: number;
  /** Whether the cursor should blink */
  cursorBlink: boolean;
  /** Maximum number of lines in the scrollback buffer */
  scrollback: number;
  /** Font family (empty string = inherit from VS Code) */
  fontFamily: string;
}

// ─── WebView → Extension Messages ───────────────────────────────────

/** Sent once when the WebView DOM is fully loaded and xterm.js is initialized. */
export interface ReadyMessage {
  type: "ready";
}

/** Raw terminal input from the user (keystrokes, paste data, IME output). */
export interface InputMessage {
  type: "input";
  /** Target terminal session ID */
  tabId: string;
  /** Raw input data (may contain ANSI escape sequences) */
  data: string;
}

/** Terminal viewport resized (e.g., sidebar dragged, window resized). */
export interface ResizeMessage {
  type: "resize";
  /** Target terminal session ID */
  tabId: string;
  /** New column count */
  cols: number;
  /** New row count */
  rows: number;
}

/** User requested creation of a new terminal tab. */
export interface CreateTabMessage {
  type: "createTab";
}

/** User switched to a different terminal tab. */
export interface SwitchTabMessage {
  type: "switchTab";
  /** Tab to activate */
  tabId: string;
}

/** User requested closing a terminal tab. */
export interface CloseTabMessage {
  type: "closeTab";
  /** Tab to close */
  tabId: string;
}

/**
 * Inline-edit dblclick path for tab rename. Host normalizes (trim / empty→null /
 * truncate to 80 chars) and persists via `SessionManager.renameSession`. The host-
 * side triggers (right-click, command palette, F2) invoke `renameSession` directly
 * — they do NOT send this message.
 */
export interface RenameTabMessage {
  type: "renameTab";
  /** Target tab (root tab) session id */
  tabId: string;
  /**
   * Raw input from the inline `<input>`. Null/empty/whitespace-only resets the
   * tab to its auto-derived name. Host normalizes before storing.
   */
  customName: string | null;
}

/** User requested a new PTY session for a split pane. */
export interface RequestSplitSessionMessage {
  type: "requestSplitSession";
  /** Direction of the split */
  direction: "horizontal" | "vertical";
  /** Session ID of the pane being split */
  sourcePaneId: string;
}

/** User requested destruction of a split pane's session. */
export interface RequestCloseSplitPaneMessage {
  type: "requestCloseSplitPane";
  /** Session ID of the pane to close */
  sessionId: string;
}

/** User requested terminal clear (scrollback + viewport). */
export interface ClearMessage {
  type: "clear";
  /** Target terminal session ID */
  tabId: string;
}

/** Acknowledgment that the WebView has processed terminal output data. */
export interface AckMessage {
  type: "ack";
  /** Number of characters processed (sent in batches of ACK_BATCH_SIZE = 5000) */
  charCount: number;
  /** Session ID this ack belongs to (routes ack to the correct OutputBuffer). */
  tabId: string;
}

/** Terminal view received focus (click/keyboard). Reports active pane session ID for split-pane routing. */
export interface FocusMessage {
  type: "focus";
  /** Active pane session ID (resolved from split layout, not tab ID) */
  activeSessionId?: string;
}

/** Request the extension host to open an external link (e.g. Cmd+Click on a URL in the terminal). */
export interface OpenLinkMessage {
  type: "openLink";
  /** Absolute URL to open in the user's default browser */
  url: string;
}

/** Request the extension host to open a file detected in terminal output. */
export interface OpenFileMessage {
  type: "openFile";
  /** Raw matched path text without any line/column suffix */
  path: string;
  /** Source terminal session id (used to look up the PTY's initial cwd) */
  sessionId: string;
  /** Optional 1-based line number parsed from the suffix */
  line?: number;
  /** Optional 1-based column number parsed from the suffix */
  col?: number;
}

/** Request the extension host to read a file for the hover preview popup. */
export interface RequestFilePreviewMessage {
  type: "requestFilePreview";
  /** Unique per-hover correlation id (echoed back in `filePreviewResult`). */
  requestId: string;
  /** Source terminal session id (used to resolve relative paths via cwd chain). */
  sessionId: string;
  /** Raw matched path text without any line/column suffix. */
  path: string;
  /** Optional 1-based line number parsed from the suffix. */
  line?: number;
  /** Optional 1-based column number parsed from the suffix. */
  col?: number;
  /**
   * When true, the host bypasses the trust-policy block (dotfile / sensitive
   * folder / out-of-workspace) that would otherwise return `requires-
   * confirmation`. Set by the webview when the user explicitly holds Cmd
   * (macOS) / Ctrl (Win/Linux) during the hover.
   */
  override?: boolean;
}

/**
 * All messages that can be sent from the WebView to the Extension Host.
 * Use msg.type as the discriminant in switch/case for exhaustive handling.
 */
export type WebViewToExtensionMessage =
  | ReadyMessage
  | InputMessage
  | ResizeMessage
  | CreateTabMessage
  | SwitchTabMessage
  | CloseTabMessage
  | RenameTabMessage
  | ClearMessage
  | AckMessage
  | RequestSplitSessionMessage
  | RequestCloseSplitPaneMessage
  | FocusMessage
  | OpenLinkMessage
  | OpenFileMessage
  | RequestFilePreviewMessage
  | UpdateHoverPreviewSettingMessage;

// ─── Extension → WebView Messages ───────────────────────────────────

/** Initial state sent to the WebView after the ready handshake. */
export interface InitMessage {
  type: "init";
  /** List of existing terminal tabs (at least one, the initial tab) */
  tabs: Array<{
    /** Unique session ID */
    id: string;
    /** Display name (e.g., "Terminal 1") */
    name: string;
    /** Persisted custom name for this tab (null when none). See add-tab-rename design.md D2. */
    customName: string | null;
    /** Whether this tab is currently active */
    isActive: boolean;
  }>;
  /** Terminal configuration from user settings */
  config: TerminalConfig;
}

/**
 * Buffered PTY output data.
 * May contain raw text, ANSI escape sequences, and control characters.
 */
export interface OutputMessage {
  type: "output";
  /** Source terminal session ID */
  tabId: string;
  /** Raw terminal output (ANSI sequences included) */
  data: string;
}

/** PTY process has exited. */
export interface ExitMessage {
  type: "exit";
  /** Terminal session ID that exited */
  tabId: string;
  /** Process exit code (0 = normal, non-zero = error/signal) */
  code: number;
}

/** A new terminal tab has been created and its PTY is ready. */
export interface TabCreatedMessage {
  type: "tabCreated";
  /** New session ID */
  tabId: string;
  /** Display name (e.g., "Terminal 2") */
  name: string;
  /**
   * Persisted custom name for this tab (root tabs only; null when none). Sent
   * on creation so a hydrated name surfaces on first render without flicker.
   */
  customName: string | null;
}

/**
 * Host pushes the normalized custom name after any rename trigger (inline-edit,
 * context menu, command palette, F2). The webview mirrors it into
 * `TerminalInstance.customName` and re-renders the tab bar.
 */
export interface TabRenamedMessage {
  type: "tabRenamed";
  /** Target tab (root tab) session id */
  tabId: string;
  /**
   * Final normalized name. `null` means the tab reverts to its auto-derived
   * name. Always the host-normalized value (trimmed, possibly truncated).
   */
  customName: string | null;
}

/** A terminal tab has been removed and its PTY destroyed. */
export interface TabRemovedMessage {
  type: "tabRemoved";
  /** Removed session ID */
  tabId: string;
}

/** Cached scrollback data for view restoration. */
export interface RestoreMessage {
  type: "restore";
  /** Terminal session ID to restore */
  tabId: string;
  /** Cached terminal output (raw ANSI data) */
  data: string;
}

/** Terminal configuration has changed (user edited settings). */
export interface ConfigUpdateMessage {
  type: "configUpdate";
  /** Only the changed configuration fields */
  config: Partial<TerminalConfig>;
}

/** Error notification for the WebView to display. */
export interface ErrorMessage {
  type: "error";
  /** Human-readable error message */
  message: string;
  /** Severity level determines display style */
  severity: "info" | "warn" | "error";
}

/**
 * Internal: sent when the view becomes visible again (for deferred resize).
 * Not part of the public protocol spec — used internally between provider and webview.
 */
export interface ViewShowMessage {
  type: "viewShow";
}

/** Trigger a split action in the webview. */
export interface SplitPaneMessage {
  type: "splitPane";
  /** Direction of the split */
  direction: "horizontal" | "vertical";
}

/** Confirms a new split session was created by the extension host. */
export interface SplitPaneCreatedMessage {
  type: "splitPaneCreated";
  /** Session ID of the pane that was split */
  sourcePaneId: string;
  /** New session ID for the split pane */
  newSessionId: string;
  /** Display name for the new session */
  newSessionName: string;
  /** Direction of the split */
  direction: "horizontal" | "vertical";
}

/** Close the active split pane in the webview. */
export interface CloseSplitPaneMessage {
  type: "closeSplitPane";
}

/** Close a specific split pane by session ID (from context menu). */
export interface CloseSplitPaneByIdMessage {
  type: "closeSplitPaneById";
  sessionId: string;
}

/** Split a specific pane by session ID (from context menu). */
export interface SplitPaneAtMessage {
  type: "splitPaneAt";
  direction: "horizontal" | "vertical";
  sourcePaneId: string;
}

/** Context menu: clear terminal viewport and scrollback for a specific session. */
export interface CtxClearMessage {
  type: "ctxClear";
  sessionId?: string;
}

/** Visual feedback: a file path was inserted into the terminal via context menu. */
export interface InsertPathEffectMessage {
  type: "insertPathEffect";
}

/** Outcome of a `requestFilePreview` for hover. See spec "IPC contract — requestFilePreview / filePreviewResult". */
export type FilePreviewStatus =
  | "ok"
  | "not-found"
  | "binary"
  | "too-large"
  | "ambiguous"
  | "error"
  | "requires-confirmation";

/**
 * Fields present on every `filePreviewResult` regardless of `status`. The
 * `path` echo guarantees the popup header has a non-empty value to display.
 */
interface FilePreviewResultBase {
  type: "filePreviewResult";
  /** Echoes the `requestId` from the originating `RequestFilePreviewMessage`. */
  requestId: string;
  /** Echoes the original `path` from the request — header fallback when `absPath` is unknown. */
  path: string;
  /** Echoes the 1-based line number from the request — popup uses it to scroll-to-line. */
  line?: number;
}

/**
 * Result variants of a hover-preview request — discriminated union on `status`
 * so consumers narrow without optional-chaining (review round-1 W1).
 *
 *   - `ok`: file was read; `content`, `languageId`, `isMarkdown`, `totalBytes`,
 *     `totalLines`, `absPath` all required. `truncated` flags the 200 KB / 500-
 *     line cap from `readFileForPreview`.
 *   - `binary` / `too-large`: file was resolved; we know `absPath` and
 *     `totalBytes` but not the contents. `languageId` + `isMarkdown` are still
 *     provided so the popup can label the placeholder.
 *   - `requires-confirmation`: file was resolved but the trust policy (dotfile
 *     / known-sensitive folder / out-of-workspace) blocked auto-preview. The
 *     popup shows a "Press Cmd/Ctrl to preview" placeholder. `absPath` is
 *     provided so the user can verify what they're about to load.
 *   - `not-found` / `ambiguous` / `error`: only base fields (`requestId`,
 *     `path`).
 */
export type FilePreviewResultMessage =
  | (FilePreviewResultBase & {
      status: "ok";
      content: string;
      languageId: string;
      isMarkdown: boolean;
      truncated: boolean;
      totalBytes: number;
      totalLines: number;
      absPath: string;
    })
  | (FilePreviewResultBase & {
      status: "binary" | "too-large";
      languageId: string;
      isMarkdown: boolean;
      totalBytes: number;
      absPath: string;
    })
  | (FilePreviewResultBase & {
      status: "requires-confirmation";
      /**
       * Reason the policy blocked auto-preview — purely informational. The
       * popup placeholder reads the same "Press Cmd/Ctrl to preview" for every
       * reason; this field is for diagnostics + future-proofing.
       *   - `dotfile`: basename starts with `.` (e.g. `.env`).
       *   - `sensitive-dir`: path lives inside `.git`, `.ssh`, `.aws`,
       *     `.config`, `node_modules`, …
       *   - `out-of-workspace`: not under any trust base (initialCwd +
       *     workspace folders).
       */
      reason: "dotfile" | "sensitive-dir" | "out-of-workspace";
      /** Resolved absolute path — present so the popup header shows the target. */
      absPath?: string;
      /** Total file size from `stat`, optional — included when resolver had it. */
      totalBytes?: number;
    })
  | (FilePreviewResultBase & {
      status: "not-found" | "ambiguous" | "error";
    });

/** VSCode color theme kind, mapped for Shiki theme selection in the webview popup. */
export interface ThemeChangedMessage {
  type: "themeChanged";
  /**
   * Light / Dark / HighContrastLight / HighContrast — one of four kinds.
   * See `design.md` D8 for the mapping to Shiki themes.
   */
  kind: "light" | "dark" | "hc-light" | "hc-dark";
}

/** Hover-preview user-facing settings, mirrored from `contributes.configuration`. */
export interface HoverPreviewSettings {
  /** Debounce in milliseconds (matches `anywhereTerminal.hoverPreview.delay`). */
  delay: number;
  /** Trust policy on/off (matches `anywhereTerminal.hoverPreview.blockSensitive`). */
  blockSensitive: boolean;
}

/** Host → webview: new settings snapshot (sent on init + onDidChangeConfiguration). */
export interface HoverPreviewSettingsMessage {
  type: "hoverPreviewSettings";
  settings: HoverPreviewSettings;
}

/** Webview → host: ask the host to persist a setting via `workspace.getConfiguration().update()`. */
export interface UpdateHoverPreviewSettingMessage {
  type: "updateHoverPreviewSetting";
  key: keyof HoverPreviewSettings;
  value: boolean | number;
}

/**
 * All messages that can be sent from the Extension Host to the WebView.
 * Use msg.type as the discriminant in switch/case for exhaustive handling.
 */
export type ExtensionToWebViewMessage =
  | InitMessage
  | OutputMessage
  | ExitMessage
  | TabCreatedMessage
  | TabRenamedMessage
  | TabRemovedMessage
  | RestoreMessage
  | ConfigUpdateMessage
  | ErrorMessage
  | ViewShowMessage
  | SplitPaneMessage
  | SplitPaneCreatedMessage
  | CloseSplitPaneMessage
  | CloseSplitPaneByIdMessage
  | SplitPaneAtMessage
  | CtxClearMessage
  | InsertPathEffectMessage
  | FilePreviewResultMessage
  | ThemeChangedMessage
  | HoverPreviewSettingsMessage;
