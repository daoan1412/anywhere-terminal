// src/webview/fileTree/Tree.flat-list.test.ts — Unit tests for setFlatItems.
//
// Covers per task 2_3 plan:
//   - flat-list mode renders the given array as depth-0 rows
//   - matchData map passes through to the renderer
//   - setFlatItems(null) restores prior tree state INCLUDING selection
//   - filter is bypassed in flat-list mode

// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ITreeDataSource } from "./ITreeDataSource";
import type { ITemplateData, ITreeMatchData, ITreeRenderer } from "./ITreeRenderer";
import { Tree } from "./Tree";

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

interface Node {
  id: string;
  name: string;
  children?: Node[];
}

function buildTree(): { root: Node; a: Node; b: Node; c: Node } {
  const a: Node = { id: "a", name: "a" };
  const b: Node = { id: "b", name: "b" };
  const c: Node = { id: "c", name: "c" };
  const root: Node = { id: "root", name: "root", children: [a, b, c] };
  return { root, a, b, c };
}

function makeDataSource(): ITreeDataSource<Node> {
  return {
    hasChildren: (el) => !!el && !!el.children && el.children.length > 0,
    getChildren: (el) => Promise.resolve(el?.children ?? []),
  };
}

interface RowTemplate extends ITemplateData {
  span: HTMLSpanElement;
}

function makeRenderer(): ITreeRenderer<Node, RowTemplate> {
  return {
    templateId: "test-node",
    renderTemplate(container: HTMLElement) {
      const span = document.createElement("span");
      span.className = "test-row";
      container.appendChild(span);
      return { span };
    },
    renderElement(element: Node, depth: number, t: RowTemplate, matchData?: ITreeMatchData) {
      t.span.textContent = element.name;
      t.span.dataset.depth = String(depth);
      if (matchData) {
        t.span.dataset.score = String(matchData.score);
      } else {
        delete t.span.dataset.score;
      }
    },
    disposeTemplate() {},
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeHost(): HTMLElement {
  const host = document.createElement("div");
  host.style.width = "300px";
  host.style.height = "400px";
  document.body.appendChild(host);
  return host;
}

function readRowLabels(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll<HTMLSpanElement>(".test-row"))
    .map((el) => el.textContent ?? "")
    .filter((s) => s.length > 0);
}

describe("Tree.setFlatItems", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the given array as a flat list at depth 0", async () => {
    const { root, a, b, c } = buildTree();
    const host = makeHost();
    const tree = new Tree<Node>(host, makeDataSource(), makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();

    tree.setFlatItems([b, c, a]); // out of source order
    await flushMicrotasks();

    expect(readRowLabels(host)).toEqual(["b", "c", "a"]);
    // depth=0 on every row, regardless of original tree position.
    const depths = Array.from(host.querySelectorAll<HTMLSpanElement>(".test-row")).map((el) => el.dataset.depth);
    expect(depths).toEqual(["0", "0", "0"]);
  });

  it("matchData map passes through to renderer", async () => {
    const { root, a } = buildTree();
    const host = makeHost();
    const tree = new Tree<Node>(host, makeDataSource(), makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();

    const matchMap = new Map<Node, ITreeMatchData>([[a, { matches: [{ start: 0, end: 1 }], score: 99 }]]);
    tree.setFlatItems([a], matchMap);
    await flushMicrotasks();

    const aRow = host.querySelector<HTMLSpanElement>(".test-row");
    expect(aRow?.dataset.score).toBe("99");
  });

  it("setFlatItems(null) restores prior tree state + selection", async () => {
    const { root, a, b } = buildTree();
    const host = makeHost();
    const tree = new Tree<Node>(host, makeDataSource(), makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();

    // Pre-flat: select `b` in the tree.
    tree.setSelection(b);
    expect(tree.getSelection()).toBe(b);

    // Enter flat mode with just `a`.
    tree.setFlatItems([a]);
    await flushMicrotasks();
    expect(readRowLabels(host)).toEqual(["a"]);

    // Exit flat mode → selection must restore to `b`.
    tree.setFlatItems(null);
    await flushMicrotasks();
    expect(readRowLabels(host).sort()).toEqual(["a", "b", "c", "root"]);
    expect(tree.getSelection()).toBe(b);
  });
});
