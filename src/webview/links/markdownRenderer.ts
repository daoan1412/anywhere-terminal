// src/webview/links/markdownRenderer.ts — Render markdown for the hover popup
// using `markdown-it` + the shared Shiki renderer (via markdown-it's
// `highlight(code, lang)` callback). Does NOT use `@shikijs/markdown-it` —
// its CSS-variable multi-theme output only supports two theme slots, and we
// need 4-way JS-controlled theme selection (see design.md D12).
//
// Security: `html: false` + `linkify: false` + `validateLink = () => false`
// strips any embedded HTML and disables auto-linkification. The popup CSS
// also sets `pointer-events: none` on `<a>` children so even if a link is
// rendered, the user can't navigate from it.
//
// See: asimov/changes/add-hover-file-preview/design.md D12
// See: asimov/changes/add-hover-file-preview/specs/file-link-hover-preview/spec.md
//   #requirement-popup-rendering--markdown-files

import MarkdownIt from "markdown-it";
import type { HoverPreviewThemeKind } from "./HoverPreviewController";
import { renderHtml as renderCodeHtml } from "./syntaxRenderer";

/**
 * Build a fresh MarkdownIt instance whose `highlight` callback closes over
 * the supplied theme. No module-scope mutable state — concurrent renders for
 * different terminals with different themes cannot bleed (review round-1 W2).
 * The cost is one extra `new MarkdownIt(...)` per render; tiny, and avoids
 * the fragility of sharing a singleton with a mutable theme variable.
 */
function buildMd(theme: HoverPreviewThemeKind): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: false,
    highlight: (code: string, lang: string): string => {
      // Shiki returns its own `<pre class="shiki">` wrapper, so we hand it
      // back to markdown-it as-is instead of letting markdown-it wrap it in
      // its default `<pre><code>` shell.
      return renderCodeHtml(code, lang || "plaintext", theme);
    },
  });
  // Strip every link's href so cracked-through content is inert.
  md.validateLink = () => false;
  return md;
}

/** Render markdown content as an HTMLElement. Pure — no module-scope writes. */
export function renderMarkdownElement(content: string, theme: HoverPreviewThemeKind): HTMLElement {
  const md = buildMd(theme);
  const html = md.render(content);
  const wrapper = document.createElement("div");
  wrapper.className = "anywhere-hover-preview-md";
  wrapper.innerHTML = html;
  return wrapper;
}

export interface MarkdownRendererDeps {
  /** Reads the current theme on each render. */
  getTheme: () => HoverPreviewThemeKind;
}

/** Factory used by callers that prefer an instance-style API. */
export function createMarkdownRenderer(deps: MarkdownRendererDeps): {
  render(content: string): HTMLElement;
  render(content: string, theme: HoverPreviewThemeKind): HTMLElement;
} {
  return {
    render(content: string, theme?: HoverPreviewThemeKind): HTMLElement {
      return renderMarkdownElement(content, theme ?? deps.getTheme());
    },
  };
}
