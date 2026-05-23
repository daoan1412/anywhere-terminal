// src/vendor/seti/setiFontCss.ts — Generates the inline CSS string that
// registers the vendored Seti icon font with the webview document.
//
// The woff binary is imported as a `data:font/woff;base64,…` URL via
// esbuild's `dataurl` loader (see esbuild.js webviewConfig.loader). The
// emitted CSS:
//   - registers `@font-face` for `seti`
//   - exposes `.file-tree-row .icon.seti-file-icon` which the row renderer
//     adds on every file row. Color is applied inline (per-icon).
//
// Vendored from microsoft/vscode (MIT, release/1.96). Original font:
// jesseweed/seti-ui (MIT). See THIRD_PARTY_NOTICES.md.

import setiWoffDataUrl from "./seti.woff";

export const SETI_FONT_CSS = `
@font-face {
  font-family: "seti";
  src: url("${setiWoffDataUrl}") format("woff");
  font-weight: normal;
  font-style: normal;
  font-display: block;
}

/* File rows use the Seti font for the icon glyph. Color is set inline by the
 * renderer (per-icon definition from vs-seti-icon-theme.json). */
.file-tree-row .icon.seti-file-icon {
  font-family: "seti";
  font-size: 16px;
  line-height: 1;
  font-style: normal;
  font-weight: normal;
  text-rendering: geometricPrecision;
  -webkit-font-smoothing: antialiased;
  background: transparent;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
`;
