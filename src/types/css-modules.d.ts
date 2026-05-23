// src/types/css-modules.d.ts — Type stub for `import x from "*.css"`.
//
// esbuild bundles `.css` imports as text strings (see esbuild.js extensionConfig
// loader). This declaration tells TypeScript the import resolves to a string.
//
// Used by `src/providers/webviewHtml.ts` to inline-inject the vendored
// VS Code list-widget CSS into the webview's <style> block. See:
// asimov/changes/port-vscode-async-data-tree/design.md D7.

declare module "*.css" {
  const css: string;
  export default css;
}

/**
 * `.woff` imports resolve to a `data:font/woff;base64,…` URL string under the
 * webview bundle (esbuild `dataurl` loader, see esbuild.js webviewConfig).
 * Used by the vendored Seti file-icon font to ship the woff binary inline
 * inside webview.js — no separate font fetch needed in the webview sandbox.
 */
declare module "*.woff" {
  const dataUrl: string;
  export default dataUrl;
}
