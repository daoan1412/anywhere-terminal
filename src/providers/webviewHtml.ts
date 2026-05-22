// src/providers/webviewHtml.ts — Shared HTML generation for terminal webviews
// See: docs/design/webview-provider.md#§4

import * as crypto from "node:crypto";
import * as vscode from "vscode";

/**
 * Generate secure HTML for a terminal webview with CSP and nonce.
 *
 * Used by both TerminalViewProvider (sidebar/panel) and TerminalEditorProvider (editor area)
 * to produce identical HTML structure. The only difference is the `data-terminal-location`
 * attribute on the body element.
 *
 * @param webview - The webview to generate HTML for
 * @param extensionUri - The extension's root URI (for resolving media/ resources)
 * @param location - The terminal location ('sidebar' | 'panel' | 'editor')
 * @returns The complete HTML string
 */
export function getTerminalHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  location: "sidebar" | "panel" | "editor",
): string {
  const nonce = crypto.randomBytes(16).toString("hex");

  // Convert file paths to webview-safe URIs
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "xterm.css"));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';
                 font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
  <style>
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
    }
    body {
      display: flex;
      flex-direction: column;
    }
    #tab-bar {
      flex-shrink: 0;
      display: none;
      height: 30px;
      background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
      align-items: center;
      overflow-x: auto;
      overflow-y: hidden;
      user-select: none;
      font-size: 12px;
      font-family: var(--vscode-font-family, sans-serif);
      scrollbar-width: none;
    }
    #tab-bar::-webkit-scrollbar {
      display: none;
    }
    #tab-bar.visible {
      display: flex;
    }
    .tab-item {
      display: flex;
      align-items: center;
      height: 100%;
      padding: 0 8px;
      cursor: pointer;
      white-space: nowrap;
      color: var(--vscode-tab-inactiveForeground, #999);
      background: var(--vscode-tab-inactiveBackground, transparent);
      border-right: 1px solid var(--vscode-tab-border, transparent);
      gap: 6px;
      flex-shrink: 0;
    }
    .tab-item:hover {
      background: var(--vscode-tab-hoverBackground, rgba(255,255,255,0.05));
    }
    .tab-item.active {
      color: var(--vscode-tab-activeForeground, #fff);
      background: var(--vscode-tab-activeBackground, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-focusBorder, #007acc);
    }
    .tab-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 3px;
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 12px;
      padding: 0;
      opacity: 0;
      flex-shrink: 0;
    }
    .tab-item:hover .tab-close,
    .tab-item.active .tab-close {
      opacity: 0.7;
    }
    .tab-close:hover {
      opacity: 1 !important;
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }
    .tab-add {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 100%;
      cursor: pointer;
      color: var(--vscode-tab-inactiveForeground, #999);
      background: transparent;
      border: none;
      font-size: 16px;
      padding: 0;
      flex-shrink: 0;
    }
    .tab-add:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
      color: var(--vscode-tab-activeForeground, #fff);
    }
    .tab-exited .tab-name {
      opacity: 0.5;
      font-style: italic;
    }
    /* Inline-rename overlay input (add-tab-rename design.md D4). Positioned
       absolutely so it survives renderTabBar()'s destructive re-renders. */
    .tab-rename-overlay {
      position: absolute;
      box-sizing: border-box;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 12px);
      padding: 1px 4px;
      margin: 0;
      border: 1px solid var(--vscode-focusBorder, #007acc);
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      z-index: 100;
    }
    /* Strip the browser default outline only when not keyboard-focused (a11y:
       WCAG 2.4.11). Keyboard users still see a focus ring via :focus-visible. */
    .tab-rename-overlay:not(:focus-visible) {
      outline: none;
    }
    .tab-rename-overlay:focus-visible {
      outline: 2px solid var(--vscode-focusBorder, #007acc);
      outline-offset: -1px;
    }
    .error-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      font-size: 12px;
      font-family: var(--vscode-font-family, sans-serif);
      color: #fff;
      z-index: 100;
      flex-shrink: 0;
    }
    .error-banner-error {
      background: #c72e2e;
    }
    .error-banner-warn {
      background: #b5850a;
    }
    .error-banner-info {
      background: #1a6fb5;
    }
    .error-banner-message {
      flex: 1;
      margin-right: 8px;
    }
    .error-banner-dismiss {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: none;
      background: transparent;
      color: #fff;
      cursor: pointer;
      font-size: 14px;
      padding: 0;
      opacity: 0.7;
      border-radius: 3px;
    }
    .error-banner-dismiss:hover {
      opacity: 1;
      background: rgba(255,255,255,0.2);
    }
    #terminal-container {
      flex: 1;
      overflow: hidden;
      padding-left: 8px;
      box-sizing: border-box;
      position: relative;
    }

    /* Drag-drop tip banner — dismissable hint at bottom of terminal */
    .drag-drop-tip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 12px;
      font-size: 11px;
      font-family: var(--vscode-font-family, sans-serif);
      color: var(--vscode-descriptionForeground, #888);
      background: var(--vscode-editorWidget-background, rgba(30, 30, 30, 0.8));
      border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      flex-shrink: 0;
      gap: 8px;
    }
    .drag-drop-tip-text {
      flex: 1;
    }
    .drag-drop-tip-dismiss {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground, #888);
      cursor: pointer;
      font-size: 12px;
      padding: 0;
      opacity: 0.6;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .drag-drop-tip-dismiss:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }

    /* Flash effect when path is inserted via context menu —
       uses ::after overlay to cover xterm content */
    @keyframes insert-path-flash {
      0% { opacity: 1; }
      100% { opacity: 0; }
    }
    #terminal-container.path-inserted::after {
      content: '';
      position: absolute;
      inset: 0;
      background: rgba(0, 122, 204, 0.12);
      pointer-events: none;
      z-index: 50;
      animation: insert-path-flash 0.8s ease-out forwards;
    }

    /* Hover-preview popup — see asimov/changes/add-hover-file-preview/design.md D2, D8. */
    .anywhere-hover-preview {
      box-sizing: border-box;
      border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128, 128, 128, 0.35));
      background: var(--vscode-editorHoverWidget-background, rgba(30, 30, 30, 0.98));
      color: var(--vscode-editorHoverWidget-foreground, var(--vscode-editor-foreground, #ddd));
      border-radius: 6px;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3);
      font-family: var(--vscode-editor-font-family, "Menlo", "Consolas", monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      padding: 0;
      pointer-events: auto;
    }
    .anywhere-hover-preview-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-editorHoverWidget-border, rgba(128, 128, 128, 0.35));
      color: var(--vscode-descriptionForeground, #999);
      font-size: 11px;
    }
    .anywhere-hover-preview-header-path {
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      direction: rtl; /* keep the file name visible when the abs path is long */
      text-align: left;
      unicode-bidi: plaintext;
      user-select: text;
      cursor: text;
    }
    .anywhere-hover-preview-open-btn {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      background: transparent;
      border: none;
      border-radius: 3px;
      color: inherit;
      cursor: pointer;
      opacity: 0.75;
    }
    .anywhere-hover-preview-open-btn:hover,
    .anywhere-hover-preview-open-btn:focus-visible {
      background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.08));
      opacity: 1;
      outline: none;
    }
    .anywhere-hover-preview-open-btn svg {
      width: 14px;
      height: 14px;
      display: block;
    }
    .anywhere-hover-preview-body {
      padding: 8px 10px;
      overflow: auto;
      counter-reset: anywhere-line;
      user-select: text;
      -webkit-user-select: text;
      cursor: text;
    }
    .anywhere-hover-preview-body pre,
    .anywhere-hover-preview-plain {
      margin: 0;
      white-space: pre;
      font-family: inherit;
      font-size: inherit;
    }
    /* Markdown body — compact spacing modeled on VSCode's .monaco-hover
     * (src/vs/base/browser/ui/hover/hoverWidget.css). Prose wraps softly;
     * only fenced code keeps white-space:pre so long lines scroll. */
    .anywhere-hover-preview-md {
      white-space: normal;
      word-wrap: break-word;
      line-height: 1.5;
    }
    .anywhere-hover-preview-md p,
    .anywhere-hover-preview-md ul,
    .anywhere-hover-preview-md ol,
    .anywhere-hover-preview-md blockquote,
    .anywhere-hover-preview-md table,
    .anywhere-hover-preview-md pre,
    .anywhere-hover-preview-md h1,
    .anywhere-hover-preview-md h2,
    .anywhere-hover-preview-md h3,
    .anywhere-hover-preview-md h4,
    .anywhere-hover-preview-md h5,
    .anywhere-hover-preview-md h6 {
      margin: 8px 0;
    }
    .anywhere-hover-preview-md h1,
    .anywhere-hover-preview-md h2,
    .anywhere-hover-preview-md h3,
    .anywhere-hover-preview-md h4,
    .anywhere-hover-preview-md h5,
    .anywhere-hover-preview-md h6 {
      line-height: 1.1;
    }
    .anywhere-hover-preview-md h1 { font-size: 1.4em; }
    .anywhere-hover-preview-md h2 { font-size: 1.2em; }
    .anywhere-hover-preview-md h3 { font-size: 1.05em; }
    .anywhere-hover-preview-md h4,
    .anywhere-hover-preview-md h5,
    .anywhere-hover-preview-md h6 { font-size: 1em; }
    .anywhere-hover-preview-md > :first-child { margin-top: 0; }
    .anywhere-hover-preview-md > :last-child  { margin-bottom: 0; }
    .anywhere-hover-preview-md ul,
    .anywhere-hover-preview-md ol { padding-left: 20px; }
    .anywhere-hover-preview-md li > p  { margin-bottom: 0; }
    .anywhere-hover-preview-md li > ul,
    .anywhere-hover-preview-md li > ol { margin-top: 0; }
    .anywhere-hover-preview-md pre.shiki {
      white-space: pre;
    }
    /* Shiki sets its theme's background-color inline on the <pre class="shiki">.
     * That clashes with the popup chrome's editorHoverWidget background — on
     * horizontal scroll the right edge shows a different shade of dark, and
     * Shiki's bg over a non-matching popup bg looks like a "selected" block.
     * Override to transparent so the popup's background shows through
     * uniformly; tokens still keep their per-token foreground colors.
     * min-width:100% prevents short content from leaving a strip of popup bg
     * to the right of the Shiki pre. */
    .anywhere-hover-preview pre.shiki,
    .anywhere-hover-preview pre.shiki code,
    .anywhere-hover-preview-md pre.shiki,
    .anywhere-hover-preview-md pre.shiki code {
      background: transparent !important;
      background-color: transparent !important;
      min-width: 100%;
      box-sizing: border-box;
    }
    /* CSS-counter gutter — works for both Shiki output and the plain-text
     * fallback because both wrap each line in span.line. */
    .anywhere-hover-preview-body .line {
      counter-increment: anywhere-line;
      position: relative;
    }
    .anywhere-hover-preview-body-numbers .line::before {
      content: counter(anywhere-line);
      display: inline-block;
      width: 3ch;
      margin-right: 12px;
      color: var(--vscode-editorLineNumber-foreground, #858585);
      text-align: right;
      user-select: none;
      opacity: 0.7;
    }
    .anywhere-hover-preview-placeholder {
      padding: 4px 0;
      color: var(--vscode-descriptionForeground, #999);
    }
    .anywhere-hover-preview-truncated {
      margin-top: 6px;
      color: var(--vscode-descriptionForeground, #999);
      font-style: italic;
      font-size: 11px;
    }
    .anywhere-hover-preview-md a {
      pointer-events: none;
      text-decoration: underline;
      color: var(--vscode-textLink-foreground, #4daafc);
    }
    /* Footer toolbar — toggles for wrap/auto + delay input. See: design.md D17. */
    .anywhere-hover-preview-footer {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 10px;
      border-top: 1px solid var(--vscode-editorHoverWidget-border, rgba(128, 128, 128, 0.35));
      background: var(--vscode-editorHoverWidget-statusBarBackground, rgba(255, 255, 255, 0.03));
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #999);
    }
    .anywhere-hover-preview-footer-toggle,
    .anywhere-hover-preview-footer-delay {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      user-select: none;
    }
    .anywhere-hover-preview-footer-delay {
      margin-left: auto;
    }
    .anywhere-hover-preview-footer-delay input {
      width: 56px;
      padding: 2px 4px;
      background: var(--vscode-input-background, rgba(0, 0, 0, 0.2));
      color: var(--vscode-input-foreground, inherit);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-size: 11px;
    }
    .anywhere-hover-preview-footer input[type="checkbox"] {
      cursor: pointer;
    }
    /* Highlight the line referenced by path:LineNo / path#LineNo. */
    .anywhere-hover-preview .line.anywhere-hover-preview-line-active {
      background-color: var(--vscode-editor-rangeHighlightBackground, rgba(255, 200, 0, 0.15));
      box-shadow: inset 2px 0 0 var(--vscode-editorWarning-foreground, #cca700);
      display: inline-block;
      min-width: 100%;
    }

    /* Split handle — visible 1px separator at rest, full sash on hover */
    .split-handle {
      flex: 0 0 4px;
      position: relative;
      background: transparent;
      opacity: 1;
      transition: background 0.15s ease;
    }
    .split-handle::after {
      content: '';
      position: absolute;
    }
    .split-handle[data-direction="vertical"]::after {
      top: 0;
      bottom: 0;
      left: 50%;
      width: 1px;
      transform: translateX(-50%);
      background: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }
    .split-handle[data-direction="horizontal"]::after {
      left: 0;
      right: 0;
      top: 50%;
      height: 1px;
      transform: translateY(-50%);
      background: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }
    .split-handle:hover,
    .split-handle:active {
      background: var(--vscode-sash-hoverBorder, rgba(128, 128, 128, 0.35));
    }
    .split-handle:hover::after,
    .split-handle:active::after {
      background: transparent;
    }
    .split-handle[data-direction="vertical"] {
      cursor: col-resize;
    }
    .split-handle[data-direction="horizontal"] {
      cursor: row-resize;
    }

    /* Keep xterm's 1px overview-ruler/scrollbar lane invisible.
       We still keep overviewRuler.width=1 in JS for FitAddon sizing math. */
    .xterm .xterm-decoration-overview-ruler {
      opacity: 0 !important;
      pointer-events: none !important;
    }

    .xterm .xterm-scrollable-element > .scrollbar.vertical,
    .xterm .xterm-scrollable-element > .scrollbar.vertical > .slider {
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
    }
  </style>
</head>
<body data-terminal-location="${location}">
  <div id="tab-bar"></div>
  <div id="terminal-container"></div>
  <div id="drag-drop-tip"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
