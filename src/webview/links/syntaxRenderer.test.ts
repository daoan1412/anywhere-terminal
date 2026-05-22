// @vitest-environment jsdom
// src/webview/links/syntaxRenderer.test.ts — Curated language set + static-import
// audit + plain-text fallback. See: design.md D1, D11.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setHighlighterForTests,
  createSyntaxRenderer,
  isHighlighterReady,
  preloadSyntaxHighlighter,
  SUPPORTED_LANGUAGES,
  whenHighlighterReady,
} from "./syntaxRenderer";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("syntaxRenderer — static-import audit (D11)", () => {
  it("source file contains zero dynamic import() or require() calls", () => {
    const sourcePath = resolve(__dirname, "syntaxRenderer.ts");
    const raw = readFileSync(sourcePath, "utf-8");
    // Strip comment / string contexts so we only audit real code tokens.
    // Order matters: block comments first (they may contain // sequences),
    // then line comments, then string literals.
    const codeOnly = raw
      .replace(/\/\*[\s\S]*?\*\//g, "") // /* ... */ block comments
      .replace(/\/\/[^\n]*/g, "") // // line comments
      .replace(/`(?:[^`\\]|\\.)*`/g, "``") // template literals
      .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted strings
      .replace(/"(?:[^"\\]|\\.)*"/g, '""'); // double-quoted strings
    const dynamicImport = /[^a-zA-Z_$]import\s*\(/.test(codeOnly);
    const requireCall = /[^a-zA-Z_$]require\s*\(/.test(codeOnly);
    expect(dynamicImport).toBe(false);
    expect(requireCall).toBe(false);
  });

  it("SUPPORTED_LANGUAGES matches the curated 20-language set from design.md D1", () => {
    const expected = new Set([
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
    expect(SUPPORTED_LANGUAGES).toEqual(expected);
  });
});

describe("syntaxRenderer — rendering", () => {
  beforeEach(() => {
    __setHighlighterForTests(null);
  });
  afterEach(() => {
    __setHighlighterForTests(null);
  });

  it("returns a <pre> plain-text wrapper for unsupported languages even when highlighter is loaded", async () => {
    await preloadSyntaxHighlighter();
    const renderer = createSyntaxRenderer({ getTheme: () => "dark" });
    const html = renderer.renderHtml("foo bar", "this-language-doesnt-exist");
    expect(html.startsWith('<pre class="anywhere-hover-preview-plain">')).toBe(true);
    expect(html).toContain("foo bar");
  });

  it("returns a <pre> plain-text wrapper before the highlighter is loaded", () => {
    __setHighlighterForTests(null);
    const renderer = createSyntaxRenderer({ getTheme: () => "dark" });
    const html = renderer.renderHtml('const x = "hi";', "typescript");
    expect(html.startsWith('<pre class="anywhere-hover-preview-plain">')).toBe(true);
  });

  it("returns Shiki-classed HTML once the highlighter is loaded for a supported language", async () => {
    await preloadSyntaxHighlighter();
    const renderer = createSyntaxRenderer({ getTheme: () => "dark" });
    const html = renderer.renderHtml('const x = "hi";', "typescript");
    expect(html.startsWith("<pre")).toBe(true);
    // Shiki emits <pre class="shiki ...">.
    expect(html).toMatch(/<pre[^>]*class="[^"]*shiki/);
  });

  it("renderElement wraps the html in .anywhere-hover-preview-code", async () => {
    await preloadSyntaxHighlighter();
    const renderer = createSyntaxRenderer({ getTheme: () => "dark" });
    const el = renderer.renderElement("x", "typescript");
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("anywhere-hover-preview-code");
    expect(el.querySelector("pre")).toBeTruthy();
  });

  it("normalizes typescriptreact → tsx and bash → shellscript", async () => {
    await preloadSyntaxHighlighter();
    const renderer = createSyntaxRenderer({ getTheme: () => "dark" });
    const tsxHtml = renderer.renderHtml("<Foo />", "typescriptreact");
    const bashHtml = renderer.renderHtml("echo hi", "bash");
    // Both produce Shiki-classed output.
    expect(tsxHtml).toMatch(/<pre[^>]*class="[^"]*shiki/);
    expect(bashHtml).toMatch(/<pre[^>]*class="[^"]*shiki/);
  });

  it("each VSCode theme kind produces a Shiki render (no throw)", async () => {
    await preloadSyntaxHighlighter();
    for (const kind of ["light", "dark", "hc-light", "hc-dark"] as const) {
      const renderer = createSyntaxRenderer({ getTheme: () => kind });
      const html = renderer.renderHtml("x", "typescript");
      expect(html).toMatch(/<pre[^>]*class="[^"]*shiki/);
    }
  });

  it("isHighlighterReady returns false before preload and true after (W4)", async () => {
    expect(isHighlighterReady()).toBe(false);
    await preloadSyntaxHighlighter();
    expect(isHighlighterReady()).toBe(true);
  });

  it("whenHighlighterReady resolves after the highlighter loads (W4)", async () => {
    const promise = whenHighlighterReady();
    await preloadSyntaxHighlighter();
    await expect(promise).resolves.toBeUndefined();
    expect(isHighlighterReady()).toBe(true);
  });
});
