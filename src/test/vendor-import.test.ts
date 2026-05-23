// src/test/vendor-import.test.ts — Vendored VS Code list-widget smoke test.
//
// Confirms three things in one place:
//   1. The `vs/*` path alias resolves under vitest.
//   2. The transitive dep closure produced by `scripts/vendor-vscode-list.mjs`
//      is complete enough that `listWidget` can be `import`-ed without runtime
//      "module not found" errors.
//   3. `new List(...)` constructs without crashing, stamping `.monaco-list` onto
//      the container element — a minimal sign-of-life check that the renderer +
//      delegate API contracts the upstream code expects are still honored.
//
// If this test fails, the most likely root cause is a missing transitive dep
// in `scripts/vendor-vscode-list.mjs`. Re-run that script's `--dry-run` mode
// against the failing import path to add the entry point.

// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";

import type { IListRenderer, IListVirtualDelegate } from "vs/base/browser/ui/list/list";
import { List } from "vs/base/browser/ui/list/listWidget";

// JSDOM 28 ships ResizeObserver, but listView.ts also exercises matchMedia and
// requestAnimationFrame. Stub anything that's missing before any vendored code
// runs to avoid `ReferenceError` during `new List(...)`.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  if (typeof globalThis.matchMedia === "undefined") {
    globalThis.matchMedia = (() => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof matchMedia;
  }
});

describe("vendored vs/base/browser/ui/list/listWidget", () => {
  it("exports a constructable List class", () => {
    expect(typeof List).toBe("function");
  });

  it("stamps `.monaco-list` onto the container when constructed with a trivial delegate + renderer", () => {
    const delegate: IListVirtualDelegate<string> = {
      getHeight: () => 22,
      getTemplateId: () => "string-row",
    };

    const renderer: IListRenderer<string, HTMLElement> = {
      templateId: "string-row",
      renderTemplate(container: HTMLElement): HTMLElement {
        const el = document.createElement("div");
        el.className = "row";
        container.appendChild(el);
        return el;
      },
      renderElement(element: string, _index: number, template: HTMLElement): void {
        template.textContent = element;
      },
      disposeTemplate(): void {},
    };

    const host = document.createElement("div");
    host.style.height = "200px";
    host.style.width = "200px";
    document.body.appendChild(host);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars — instance is kept by closure so listView can attach internals.
    const list = new List<string>("test-list", host, delegate, [renderer]);
    expect(list).toBeDefined();

    // The List widget wraps `host` with a `.monaco-list` element on construction.
    const stamped = host.querySelector(".monaco-list");
    expect(stamped).not.toBeNull();
  });
});
