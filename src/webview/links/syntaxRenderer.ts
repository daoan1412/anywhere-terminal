// src/webview/links/syntaxRenderer.ts — Static curated Shiki bundle for the
// hover preview popup.
//
// The static-import set comes from `design.md` D1 (the curated 20-grammar +
// 4-theme bundle). Any language outside the curated set falls back to plain
// text. The renderer NEVER calls dynamic `import()` — the IIFE webview build
// (`esbuild.js:83-89`) bundles everything statically; a runtime import would
// break the CSP nonce check.
//
// See: asimov/changes/add-hover-file-preview/design.md D1, D8, D11
// See: docs/research/20260521-shiki-v3-api.md (exact API surface)

import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import css from "@shikijs/langs/css";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import kotlin from "@shikijs/langs/kotlin";
import markdown from "@shikijs/langs/markdown";
import php from "@shikijs/langs/php";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import shellscript from "@shikijs/langs/shellscript";
import sql from "@shikijs/langs/sql";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";
import darkPlus from "@shikijs/themes/dark-plus";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import lightPlus from "@shikijs/themes/light-plus";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import type { HoverPreviewThemeKind } from "./HoverPreviewController";

/** Curated language set bundled into the webview at build time. */
export const SUPPORTED_LANGUAGES = new Set<string>([
  "c",
  "cpp",
  "css",
  "go",
  "html",
  "java",
  "javascript",
  "json",
  "jsx",
  "kotlin",
  "markdown",
  "php",
  "python",
  "ruby",
  "rust",
  "shellscript",
  "sql",
  "tsx",
  "typescript",
  "yaml",
]);

/** Map common VSCode + Shiki aliases to the curated grammar id. */
const LANGUAGE_ALIASES: Record<string, string> = {
  // VSCode language ids that map onto our curated names
  typescriptreact: "tsx",
  javascriptreact: "jsx",
  // Common short aliases for fenced code blocks
  ts: "typescript",
  js: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  // Shell aliases
  sh: "shellscript",
  shell: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  // Markdown short alias
  md: "markdown",
  // YAML short alias
  yml: "yaml",
  // C++ aliases
  "c++": "cpp",
  cxx: "cpp",
  cc: "cpp",
  // Kotlin short alias
  kt: "kotlin",
};

/** Pick the Shiki theme name for the current VSCode theme kind. */
function themeFor(kind: HoverPreviewThemeKind): string {
  switch (kind) {
    case "light":
      return "github-light";
    case "dark":
      return "github-dark";
    case "hc-light":
      return "light-plus";
    case "hc-dark":
      return "dark-plus";
  }
}

/** Normalize the language id to a curated grammar name, or "" when unsupported. */
function normalizeLanguage(languageId: string | undefined): string {
  if (!languageId) {
    return "";
  }
  const lower = languageId.toLowerCase();
  const aliased = LANGUAGE_ALIASES[lower] ?? lower;
  return SUPPORTED_LANGUAGES.has(aliased) ? aliased : "";
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface SyntaxRendererDeps {
  /** Latest theme kind. Read fresh on every render. */
  getTheme: () => HoverPreviewThemeKind;
}

/** Singleton highlighter — created lazily on first render. */
let _highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  if (!_highlighterPromise) {
    _highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      langs: [
        c,
        cpp,
        css,
        go,
        html,
        java,
        javascript,
        json,
        jsx,
        kotlin,
        markdown,
        php,
        python,
        ruby,
        rust,
        shellscript,
        sql,
        tsx,
        typescript,
        yaml,
      ],
      themes: [githubLight, lightPlus, githubDark, darkPlus],
    });
  }
  return _highlighterPromise;
}

/**
 * Synchronous render to an HTML string. Returns a `<pre>` plain-text wrapper
 * when the highlighter hasn't loaded yet or the language is unsupported —
 * the popup falls back transparently in those cases.
 */
export function renderHtml(content: string, languageId: string, theme: HoverPreviewThemeKind): string {
  const lang = normalizeLanguage(languageId);
  // Touch the highlighter to start initialization (idempotent).
  void getHighlighter();
  const cached = highlighterSync;
  if (!cached || !lang) {
    return `<pre class="anywhere-hover-preview-plain">${escapeHtml(content)}</pre>`;
  }
  try {
    return cached.codeToHtml(content, { lang, theme: themeFor(theme) });
  } catch (err) {
    console.warn("[AnyWhere Terminal] Shiki render failed:", err);
    return `<pre class="anywhere-hover-preview-plain">${escapeHtml(content)}</pre>`;
  }
}

/**
 * Synchronous accessor populated as a side effect of the first async render.
 * Once `getHighlighter()` resolves we cache the result here so `renderHtml`
 * can run sync. Tests can also set this via `__setHighlighterForTests`.
 */
let highlighterSync: HighlighterCore | null = null;

/** True iff the singleton highlighter has finished loading. */
export function isHighlighterReady(): boolean {
  return highlighterSync !== null;
}

/**
 * Resolves when the singleton highlighter is loaded — callers (the popup) use
 * this to re-render once Shiki is available. Cheap to await repeatedly: the
 * promise is cached. See review round-1 W4.
 */
export function whenHighlighterReady(): Promise<void> {
  return getHighlighter().then(() => undefined);
}

/** Kick off async init + cache for sync access. Call once at webview startup. */
export async function preloadSyntaxHighlighter(): Promise<void> {
  highlighterSync = await getHighlighter();
}

/**
 * Render content to a DOM element. Wraps the Shiki HTML in a container div.
 */
export function createSyntaxRenderer(deps: SyntaxRendererDeps): {
  render(content: string, languageId: string): Promise<HTMLElement>;
  renderHtml(content: string, languageId: string, theme?: HoverPreviewThemeKind): string;
  renderElement(content: string, languageId: string, theme?: HoverPreviewThemeKind): HTMLElement;
} {
  return {
    async render(content: string, languageId: string): Promise<HTMLElement> {
      await getHighlighter();
      return this.renderElement(content, languageId);
    },
    renderHtml(content: string, languageId: string, theme?: HoverPreviewThemeKind): string {
      return renderHtml(content, languageId, theme ?? deps.getTheme());
    },
    renderElement(content: string, languageId: string, theme?: HoverPreviewThemeKind): HTMLElement {
      const wrapper = document.createElement("div");
      wrapper.className = "anywhere-hover-preview-code";
      wrapper.innerHTML = renderHtml(content, languageId, theme ?? deps.getTheme());
      return wrapper;
    },
  };
}

/** Test-only override — never call in production. */
export function __setHighlighterForTests(h: HighlighterCore | null): void {
  highlighterSync = h;
}
