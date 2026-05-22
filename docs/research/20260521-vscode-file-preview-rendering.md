---
topic: vscode-file-preview-rendering
created-by: research request for add-hover-file-preview (VSCode internals + external libraries)
date: 2026-05-21
libraries: [vscode, shiki, monaco-editor, highlight.js, markdown-it]
used-by: [add-hover-file-preview]
---

# Research: vscode-file-preview-rendering

## A. VS Code internal mechanisms

1. **`vscode.commands.executeCommand` candidates**
   - I found no public command in `src/vs/workbench/api/common/extHostApiCommands.ts` that renders arbitrary files to HTML/Markdown for extensions. Searches for `markdown.api.render`, `previewHtml`, and related names came up empty there.
   - The exposed “render-ish” commands are things like `vscode.executeHoverProvider`, `vscode.executeDocumentSymbolProvider`, `vscode.executeFormatRangeProvider`, and `vscode.open`/`vscode.openWith`.
   - The closest internal renderer is `src/vs/workbench/contrib/markdown/browser/markdownDocumentRenderer.ts:223-253`, but that is workbench-internal and not surfaced as an extension API.

2. **`vscode.window.showWebview` / `createWebviewPanel`**
   - There is no public `showWebview` API in the extension host; the public surface is `window.createWebviewPanel(...)` in `src/vs/workbench/api/common/extHost.api.impl.ts:934-936`.
   - The show options are limited to `viewColumn` and `preserveFocus` (`extHostWebviewPanels.ts:202-223`, `extHost.protocol.ts:988-991`), which means “open in an editor group” rather than “float at cursor position.”
   - So a webview panel is not a hover-anchored popup; it is a tab/editor surface.

3. **`vscode.MarkdownString` + hover providers**
   - `registerHoverProvider` is wired against a `DocumentSelector` in `extHostLanguageFeatures.ts:2350-2353`, and the adapter calls `provideHover(doc, pos, token)` with a real `TextDocument` from `ExtHostDocuments` (`extHostLanguageFeatures.ts:277-317`).
   - That means hover providers are for text documents/editors; they do not fire inside arbitrary webview DOM content or xterm.js rendered inside a webview.
   - `MarkdownString` is still very useful for native VS Code editor hovers, because VS Code renders it itself, but it does not help a custom webview render a hover automatically.

4. **Peek view / “Peek Definition”**
   - Peek UI is internal editor machinery: `PeekViewWidget` is a `ZoneWidget` in `src/vs/editor/contrib/peekView/browser/peekView.ts:31-136`, and `ReferencesController` in `src/vs/editor/contrib/gotoSymbol/browser/peek/referencesController.ts:77-187` owns the lifecycle.
   - The action `editor.action.peekDefinition` is registered in `src/vs/editor/contrib/gotoSymbol/browser/goToCommands.ts:343-355`.
   - There is no public extension API to create or embed that widget directly; it is a VS Code internal UI pattern.

5. **TextMate grammars from the running VS Code instance**
   - Extensions can read extension metadata through `vscode.extensions.getExtension(...)`; the returned `Extension` object exposes `packageJSON` (`src/vs/workbench/api/common/extHostExtensionService.ts:1173-1188`).
   - That means you can inspect `packageJSON.contributes.grammars` and discover grammar file paths / scope names.
   - But this is only manifest metadata. It does **not** give you the loaded tokenizer, parsed tokens, or a public “highlight this file exactly like VS Code” API.

6. **`openTextDocument` + `showTextDocument({ preview: true, preserveFocus: true })`**
   - This is the public baseline for a real file preview: `workspace.openTextDocument(...)` plus `window.showTextDocument(...)` in `src/vs/workbench/api/common/extHost.api.impl.ts:805-813` and `1163-1185`.
   - It opens an actual editor tab, so it gets VS Code’s native syntax highlighting, markdown rendering, themeing, etc.
   - It is not a hover popup, but it is the only fully native “open and render” option available from the public API.

## B. External library options for webview rendering

7. **Shiki**
   - Shiki is the best fit if you want VS Code-like syntax highlighting inside a webview. Its docs say it uses TextMate grammars and themes, is portable/agnostic, does not rely on Node.js or the filesystem, and works in modern browser runtimes.
   - The official performance docs recommend fine-grained bundles, and note that the full bundle is about 6.4 MB minified / 1.2 MB gzip. For a hover popup, that argues for `shiki/core` plus only the needed langs/themes.
   - For a webview, prefer the JavaScript regex engine when bundle size/startup matter; the Oniguruma WASM engine is more compatible but heavier. For markdown, Shiki also has `@shikijs/markdown-it` and `@shikijs/monaco` integrations.

8. **Monaco editor**
   - Monaco is the full browser-based editor engine from VS Code. It gives excellent syntax highlighting and editing behavior, and it can be embedded in a webview.
   - For a read-only hover preview, it is usually overkill: you are shipping a full editor for a tooltip-sized UI.
   - It is still the best fallback if you need richer interaction than simple code rendering, but it is much heavier operationally than Shiki.

9. **highlight.js / Prism**
   - `highlight.js` is lightweight, browser-friendly, and has zero dependencies, but its themes/scopes are not VS Code-level faithful.
   - It is a good choice when startup cost matters more than exact fidelity.
   - Prism is in the same bucket: simple and small, but not the closest match to VS Code’s rendered code.

10. **Markdown rendering for `.md` files**
   - If you want markdown plus code fences, `markdown-it` is a strong parser layer: its docs support a `highlight(code, lang)` callback for fenced code blocks, so you can plug in Shiki or highlight.js.
   - Shiki itself also has a markdown integration (`@shikijs/markdown-it`), which is the most direct path if you want VS Code-like code fences inside rendered markdown.
   - Plain markdown parsing alone is not enough if you want syntax-highlighted code blocks.

## C. Hover popup UX patterns inside a webview

11. **Webview HTML floating panel**
   - VS Code does not provide a built-in cursor-anchored webview popup API for extensions; `createWebviewPanel` opens in an editor column, not at pixel coordinates.
   - For xterm.js inside a webview, the usual pattern is a DOM overlay absolutely/fixed-positioned relative to the webview container, driven by mouse coordinates from the terminal.
   - Libraries like Floating UI or Popper are the standard fit if you want collision-aware positioning, viewport clamping, and arrow alignment.

12. **Debounce / cancel pattern for hover**
   - VS Code’s editor hover timing is a good reference: `HoverOperation` in `src/vs/editor/contrib/hover/browser/hoverOperation.ts:54-62` documents a default hover delay of 300ms, with async work at half delay and sync work at full delay.
   - `ContentHoverController` reads `EditorOption.hover` settings and hides/cancels on mouse move, scroll, and model changes (`contentHoverController.ts:94-123`).
   - For terminal links, a similar pattern is sensible: ~300-500ms delay, immediate cancel on mouseleave/move, and a separate longer timeout for loading states.

## D. Constraints to flag

13. **Webview CSP / resource loading**
   - Webview content is isolated. The protocol-level options include `enableScripts`, `localResourceRoots`, and `portMapping` in `extHost.protocol.ts:1008-1019`.
   - Any CSS, JS, fonts, or grammar/theme assets must be loaded via webview-safe resource URLs (`asWebviewUri` / allowed roots), not arbitrary filesystem paths or CDNs.
   - If you pick Shiki or Monaco, plan the asset pipeline up front so the popup remains CSP-compliant.

14. **Performance**
   - Native VS Code markdown rendering tokenizes code blocks through the language service (`markdownDocumentRenderer.ts:223-253`), which is fine for editor surfaces but not something to recreate on every mouse hover for large files.
   - A file preview popup should cap size, cache by file path + mtime, and render only a window of content if the file is large.
   - Shiki’s performance docs explicitly recommend fine-grained bundles and lazy loading to keep web bundles small and startup fast.

15. **Security**
   - Hover preview is passive UX, so it should not require the same explicit “open file” confirmation as a full editor navigation.
   - That said, arbitrary terminal output should not become arbitrary filesystem probing. Resolve paths through the same trusted path logic you already use for clickable links, and fail closed for out-of-workspace or suspicious paths.
   - A good compromise is: hover preview only for paths the extension can already resolve confidently; full open keeps the existing user-triggered gate.

## Sources

- [Shiki Introduction](https://shiki.style/guide/)
- [Shiki Best Performance Practices](https://shiki.style/guide/best-performance)
- [Shiki RegExp Engines](https://shiki.style/guide/regex-engines)
- [Shiki Monaco Integration](https://shiki.style/packages/monaco)
- [highlight.js homepage](https://highlightjs.org/)
- [highlight.js examples](https://highlightjs.org/examples)
- [Monaco Editor API](https://microsoft.github.io/monaco-editor/docs.html)
- [Monaco Monarch syntax docs](https://microsoft.github.io/monaco-editor/monarch.html)
- [markdown-it API docs](https://markdown-it.github.io/markdown-it/)

## Recommendation summary

- Best path: render the tooltip **inside the xterm webview DOM** as a floating overlay, not as a VS Code webview panel.
- For code/markdown fidelity, choose **Shiki**; use a fine-grained bundle and the JavaScript engine first, then only fall back to Oniguruma if grammar compatibility demands it.
- For markdown files, pair **markdown-it + Shiki** or use `@shikijs/markdown-it` for code fences.
- Use VS Code native hovers only when the content is in a real text editor; `HoverProvider` does not target webview DOM content.
- Treat `createWebviewPanel` and `showTextDocument` as fallback previews, not hover popups.
- Keep preview rendering cached, size-capped, and cancellation-friendly so hover doesn’t become an IPC/render bottleneck.
- Enforce webview CSP-safe asset loading from day one.
- Persisted report: `/Users/huybuidac/Projects/ai-oss/anywhere-terminal/docs/research/20260521-vscode-file-preview-rendering.md`
