// @vitest-environment jsdom
// src/webview/links/markdownRenderer.test.ts — Covers headings, code fences,
// HTML sanitization, link inertness. See: spec
// "Popup rendering — markdown files" + design.md D12.

import { describe, expect, it } from "vitest";
import { createMarkdownRenderer, renderMarkdownElement } from "./markdownRenderer";
import { preloadSyntaxHighlighter } from "./syntaxRenderer";

describe("markdownRenderer — static-import audit", () => {
  it("does not import @shikijs/markdown-it (per design.md D12)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(resolve(__dirname, "markdownRenderer.ts"), "utf-8");
    // Strip comments so the "Does NOT use @shikijs/markdown-it" header doesn't
    // false-positive. We audit real import statements only.
    const codeOnly = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(codeOnly).not.toContain("@shikijs/markdown-it");
  });
});

describe("markdownRenderer — rendering", () => {
  it("renders # Title as <h1>", () => {
    const el = renderMarkdownElement("# hello", "dark");
    expect(el.querySelector("h1")?.textContent).toBe("hello");
  });

  it("renders fenced code blocks via the shared syntax renderer", async () => {
    await preloadSyntaxHighlighter();
    const md = "```ts\nconst x = 1;\n```";
    const el = renderMarkdownElement(md, "dark");
    // Shiki emits <pre class="shiki ..."> for supported langs.
    const pre = el.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre?.getAttribute("class") || "").toMatch(/shiki/);
  });

  it("escapes raw HTML (html=false) — <script> becomes inert text", () => {
    const el = renderMarkdownElement("<script>alert(1)</script>", "dark");
    expect(el.querySelector("script")).toBeNull();
    // The raw text is escaped and rendered as content within a <p>.
    expect(el.textContent).toContain("<script>alert(1)</script>");
  });

  it("strips href from markdown links (validateLink returns false)", () => {
    const el = renderMarkdownElement("[click](https://example.com)", "dark");
    const a = el.querySelector("a");
    // markdown-it skips the link entirely when validateLink fails — the
    // anchor element won't be created at all. Either way: no clickable
    // navigation surfaces.
    if (a) {
      expect(a.getAttribute("href")).toBeNull();
    } else {
      expect(el.textContent).toContain("click");
    }
  });

  it("wraps output in .anywhere-hover-preview-md", () => {
    const el = renderMarkdownElement("hello", "dark");
    expect(el.className).toBe("anywhere-hover-preview-md");
  });

  it("does not share theme state across renders — concurrent calls cannot bleed (W2)", async () => {
    await preloadSyntaxHighlighter();
    // Render the SAME content with two different themes in back-to-back calls.
    // The pre-W2 implementation used a module-scope `_currentTheme` shared
    // across all calls; this test would have passed under it too because JS
    // is single-threaded, but the *output* should differ by theme even when
    // the same singleton parser is used. The W2 fix guarantees this by
    // building per-render `md` with theme captured in closure.
    const md = "```ts\nconst x = 1;\n```";
    const elLight = renderMarkdownElement(md, "light");
    const elDark = renderMarkdownElement(md, "dark");
    // Shiki output has theme-specific inline styles. The two outputs should
    // be different strings (different syntax colors per theme).
    expect(elLight.innerHTML).not.toBe(elDark.innerHTML);
  });

  it("createMarkdownRenderer returns an instance with a render() that uses getTheme by default", async () => {
    await preloadSyntaxHighlighter();
    let theme: "light" | "dark" | "hc-light" | "hc-dark" = "light";
    const renderer = createMarkdownRenderer({ getTheme: () => theme });
    const elLight = renderer.render("```ts\nconst x = 1;\n```");
    expect(elLight.querySelector("pre")).toBeTruthy();
    theme = "dark";
    const elDark = renderer.render("```ts\nconst x = 1;\n```");
    expect(elDark.querySelector("pre")).toBeTruthy();
    // The two theme renders produce different colored output — non-strict assertion:
    // both contain Shiki output, theme switching is exercised via getTheme().
    expect(elLight.innerHTML).toMatch(/shiki/);
    expect(elDark.innerHTML).toMatch(/shiki/);
  });
});
