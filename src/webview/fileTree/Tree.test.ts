// src/webview/fileTree/Tree.test.ts — Unit tests for the generic Tree<T>
// wrapper over the vendored VS Code listWidget.
//
// Covers the 7 Acceptance.Verify scenarios from task 2_2 of asimov change
// `port-vscode-async-data-tree`:
//   1. setInput + initial render
//   2. expand a node, children appear
//   3. collapse, children disappear
//   4. lazy-load called once per element on first expand
//   5. refresh re-fetches
//   6. stale-async: expand then collapse before resolve → resolved value MUST NOT update DOM
//   7. identity stability: replacing parent with new reference resets cache for that element
//
// Plus 10 ARIA + keyboard scenarios from task 2_3:
//   8.  ArrowDown moves selection to the next visible row.
//   9.  ArrowUp moves selection to the previous visible row.
//   10. ArrowRight on a collapsed-with-children expands AND sets aria-expanded="true".
//   11. ArrowRight on an already-expanded row moves selection to the first child.
//   12. ArrowRight on a leaf does nothing (no error).
//   13. ArrowLeft on an expanded row collapses AND sets aria-expanded="false".
//   14. ArrowLeft on a collapsed row moves selection to the parent.
//   15. Home / End jump to first / last visible row.
//   16. aria-level matches depth+1 on every rendered row; role="tree" / "treeitem" set.
//   17. aria-selected flips on selection change.

// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ITreeDataSource } from "./ITreeDataSource";
import type { ITemplateData, ITreeRenderer } from "./ITreeRenderer";
import { Tree } from "./Tree";

// JSDOM stub block copied verbatim from src/test/vendor-import.test.ts —
// listView.ts needs ResizeObserver and matchMedia, which JSDOM 28 doesn't
// guarantee. Without these, `new List(...)` throws ReferenceError.
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
  // children is held in the test's `tree` data and looked up by the data
  // source — the Tree<T> itself doesn't read it directly. We carry it on the
  // object for ergonomic test setup.
  children?: Node[];
}

/** Build a typical `root -> [a [a1, a2], b]` test tree. */
function buildTree(): { root: Node; a: Node; a1: Node; a2: Node; b: Node } {
  const a1: Node = { id: "a1", name: "a1" };
  const a2: Node = { id: "a2", name: "a2" };
  const a: Node = { id: "a", name: "a", children: [a1, a2] };
  const b: Node = { id: "b", name: "b" };
  const root: Node = { id: "root", name: "root", children: [a, b] };
  return { root, a, a1, a2, b };
}

/** Synchronous-ish data source that resolves children via microtask. */
function makeDataSource(): {
  source: ITreeDataSource<Node>;
  getChildrenSpy: ReturnType<typeof vi.fn>;
} {
  const getChildrenSpy = vi.fn((el: Node | null) => {
    if (el === null) {
      return Promise.resolve<Node[]>([]);
    }
    return Promise.resolve(el.children ?? []);
  });
  const source: ITreeDataSource<Node> = {
    hasChildren: (el) => !!el && !!el.children && el.children.length > 0,
    getChildren: (el) => getChildrenSpy(el) as Promise<Node[]>,
  };
  return { source, getChildrenSpy };
}

interface RowTemplate extends ITemplateData {
  span: HTMLSpanElement;
  depth: number;
}

/** Minimal renderer — stamps the name into a `<span>` for each row. */
function makeRenderer(): ITreeRenderer<Node, RowTemplate> {
  return {
    templateId: "test-node",
    renderTemplate(container: HTMLElement) {
      const span = document.createElement("span");
      span.className = "test-row";
      container.appendChild(span);
      return { span, depth: 0 };
    },
    renderElement(element: Node, depth: number, t: RowTemplate) {
      t.span.textContent = element.name;
      t.span.dataset.depth = String(depth);
    },
    disposeTemplate() {},
  };
}

/** Read the visible row labels in DOM order. */
function readRowLabels(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll<HTMLSpanElement>(".test-row"))
    .map((el) => el.textContent ?? "")
    .filter((s) => s.length > 0);
}

/**
 * Return the rendered `.monaco-list-row` element whose contained `.test-row`
 * span has the given label text, or `null` if not currently materialised.
 * Used by ARIA tests to assert per-row attributes.
 */
function findRowByLabel(host: HTMLElement, label: string): HTMLElement | null {
  const spans = host.querySelectorAll<HTMLSpanElement>(".test-row");
  for (const span of spans) {
    if (span.textContent === label) {
      // The closest ancestor that listView created — the row container has
      // class `monaco-list-row` (per src/vendor/vscode/.../rowCache.ts).
      return span.closest<HTMLElement>(".monaco-list-row");
    }
  }
  return null;
}

/**
 * Locate the `view.domNode` (`.monaco-list`) — the element that the
 * vendored listWidget attaches its keydown DomEmitter to. Keyboard events
 * must be dispatched ON this element (not the user host) because the
 * DomEmitter listener is registered on it directly (no bubble path).
 */
function getListDom(host: HTMLElement): HTMLElement {
  const listDom = host.querySelector<HTMLElement>(".monaco-list");
  if (!listDom) {
    throw new Error("Test setup: .monaco-list element not found in host");
  }
  return listDom;
}

/**
 * Dispatch a `keydown` KeyboardEvent on the list's view.domNode. We set both
 * `key` (modern API the Tree handler uses) and `keyCode` (legacy numeric
 * which the vendored KeyboardController converts via StandardKeyboardEvent).
 */
function pressKey(host: HTMLElement, key: string, keyCode: number): void {
  const listDom = getListDom(host);
  // `bubbles: true` is harmless since the DomEmitter listens directly on
  // listDom — included for parity with real browser events.
  const event = new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true });
  listDom.dispatchEvent(event);
}

/** WAI-ARIA Tree pattern keys — keyCode values match the W3C KeyboardEvent legacy numbers. */
const Keys = {
  ArrowUp: { key: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", keyCode: 36 },
  End: { key: "End", keyCode: 35 },
  Enter: { key: "Enter", keyCode: 13 },
};

/** Yield to the microtask queue so resolved promises run their then-handlers. */
async function flushMicrotasks(): Promise<void> {
  // Two awaits = one extra tick to let the rebuildRows after promise resolution apply.
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

describe("Tree<T>", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("setInput renders only the root initially", async () => {
    const { root } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);

    tree.setInput(root);
    await flushMicrotasks();

    const labels = readRowLabels(host);
    // After setInput we don't auto-expand the root in our flat-row model
    // (root is "expanded" but its children haven't been loaded yet — the
    // loadChildren kick-off in setInput populates them); after the microtask
    // settles, the root + its loaded children should be visible.
    expect(labels[0]).toBe("root");
    // Children of root are loaded (resolved promise) but the children
    // themselves are collapsed by default — so a + b are visible at depth 1.
    expect(labels).toContain("a");
    expect(labels).toContain("b");
    // a1/a2 should NOT yet be visible (a is collapsed).
    expect(labels).not.toContain("a1");
    expect(labels).not.toContain("a2");

    tree.dispose();
  });

  it("expand makes children appear", async () => {
    const { root, a } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);

    tree.setInput(root);
    await flushMicrotasks();

    tree.expand(a);
    await flushMicrotasks();

    const labels = readRowLabels(host);
    expect(labels).toContain("a1");
    expect(labels).toContain("a2");

    tree.dispose();
  });

  it("collapse makes children disappear", async () => {
    const { root, a } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);

    tree.setInput(root);
    await flushMicrotasks();
    tree.expand(a);
    await flushMicrotasks();
    expect(readRowLabels(host)).toContain("a1");

    tree.collapse(a);
    await flushMicrotasks();

    const labels = readRowLabels(host);
    expect(labels).not.toContain("a1");
    expect(labels).not.toContain("a2");
    expect(labels).toContain("a"); // a itself still visible

    tree.dispose();
  });

  it("lazy-load: getChildren called exactly once per element on first expand", async () => {
    const { root, a } = buildTree();
    const host = makeHost();
    const { source, getChildrenSpy } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);

    tree.setInput(root);
    await flushMicrotasks();
    // After setInput we've already called getChildren once (for root).
    const afterSetInput = getChildrenSpy.mock.calls.length;
    expect(afterSetInput).toBe(1);
    expect(getChildrenSpy.mock.calls[0][0]).toBe(root);

    tree.expand(a);
    await flushMicrotasks();
    expect(getChildrenSpy).toHaveBeenCalledTimes(2);
    expect(getChildrenSpy.mock.calls[1][0]).toBe(a);

    // Collapsing then re-expanding MUST NOT re-fetch (cached).
    tree.collapse(a);
    await flushMicrotasks();
    tree.expand(a);
    await flushMicrotasks();
    expect(getChildrenSpy).toHaveBeenCalledTimes(2);

    tree.dispose();
  });

  it("refresh re-fetches children for the target element", async () => {
    const { root, a } = buildTree();
    const host = makeHost();
    const { source, getChildrenSpy } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);

    tree.setInput(root);
    await flushMicrotasks();
    tree.expand(a);
    await flushMicrotasks();
    expect(getChildrenSpy).toHaveBeenCalledTimes(2);

    // Mutate the underlying data (simulating an FS change), then refresh(a).
    const a3: Node = { id: "a3", name: "a3" };
    a.children = [...(a.children ?? []), a3];

    tree.refresh(a);
    await flushMicrotasks();

    // refresh(a) MUST have re-invoked getChildren(a) — that's the contract.
    expect(getChildrenSpy).toHaveBeenCalledTimes(3);
    expect(getChildrenSpy.mock.calls[2][0]).toBe(a);
    expect(readRowLabels(host)).toContain("a3");

    tree.dispose();
  });

  it("stale-async: expand then collapse before resolve drops the resolved value", async () => {
    const { root, a, a1, a2 } = buildTree();
    const host = makeHost();

    // Build a data source whose getChildren(a) is deliberately deferred so
    // we can call collapse() between the call site and the resolve.
    let resolveA: ((value: Node[]) => void) | null = null;
    const getChildrenSpy = vi.fn((el: Node | null) => {
      if (el === root) {
        return Promise.resolve(root.children ?? []);
      }
      if (el === a) {
        return new Promise<Node[]>((res) => {
          resolveA = res;
        });
      }
      return Promise.resolve<Node[]>([]);
    });
    const source: ITreeDataSource<Node> = {
      hasChildren: (el) => !!el && !!el.children && el.children.length > 0,
      getChildren: (el) => getChildrenSpy(el) as Promise<Node[]>,
    };

    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();

    tree.expand(a); // kicks off getChildren(a) — promise is pending
    // Collapse BEFORE resolving — this MUST drop the in-flight promise
    // reference, so when we later resolve, the result is ignored.
    tree.collapse(a);

    // Now resolve the stale promise.
    expect(resolveA).not.toBeNull();
    resolveA!([a1, a2]);
    await flushMicrotasks();

    // a1/a2 MUST NOT appear in DOM because the resolution was stale.
    const labels = readRowLabels(host);
    expect(labels).not.toContain("a1");
    expect(labels).not.toContain("a2");

    tree.dispose();
  });

  it("identity stability: replacing parent with new reference resets the cache", async () => {
    const { root, a, a1, a2 } = buildTree();
    const host = makeHost();
    const { source, getChildrenSpy } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);

    tree.setInput(root);
    await flushMicrotasks();
    tree.expand(a);
    await flushMicrotasks();
    expect(readRowLabels(host)).toContain("a1");
    expect(getChildrenSpy).toHaveBeenCalledTimes(2);

    // Build a NEW root reference with a NEW `a` reference (structurally
    // similar but distinct identity). The Tree must NOT carry the old cache
    // entries forward.
    const newA1: Node = { id: "a1-new", name: "a1-new" };
    const newA: Node = { id: "a", name: "a", children: [newA1] };
    const newB: Node = { id: "b", name: "b" };
    const newRoot: Node = { id: "root", name: "root", children: [newA, newB] };

    // Reset spy count so we can assert the cache really was cleared.
    getChildrenSpy.mockClear();

    tree.setInput(newRoot);
    await flushMicrotasks();

    // Re-expanding the NEW `a` must trigger a fresh getChildren call (cache
    // is keyed on object identity, so the old `a` entry doesn't help).
    tree.expand(newA);
    await flushMicrotasks();

    // setInput re-fetches root, and the expand re-fetches newA.
    expect(getChildrenSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(getChildrenSpy.mock.calls.some((c) => c[0] === newRoot)).toBe(true);
    expect(getChildrenSpy.mock.calls.some((c) => c[0] === newA)).toBe(true);
    // The OLD a / a1 / a2 references must never be queried again — the cache
    // for them was dropped wholesale by setInput.
    expect(getChildrenSpy.mock.calls.some((c) => c[0] === a)).toBe(false);
    expect(getChildrenSpy.mock.calls.some((c) => c[0] === a1)).toBe(false);
    expect(getChildrenSpy.mock.calls.some((c) => c[0] === a2)).toBe(false);

    // DOM reflects the NEW data: the new child a1-new is visible, not the old a1.
    const labels = readRowLabels(host);
    expect(labels).toContain("a1-new");
    expect(labels).not.toContain("a1");

    tree.dispose();
  });

  // -------------------------------------------------------------------------
  // Task 2_3: WAI-ARIA Tree pattern — keyboard navigation + ARIA attributes
  // -------------------------------------------------------------------------

  it("ArrowDown moves selection to the next visible row", async () => {
    const { root, a } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();

    // Seed selection at root so ArrowDown has a starting position. Setting
    // selection also lets the vendored KeyboardController find a focused row
    // (focus is initialised from selection-anchor on first navigation).
    tree.setSelection(root);
    // Capture for comparison.
    const before = tree.getSelection();
    expect(before).toBe(root);

    pressKey(host, Keys.ArrowDown.key, Keys.ArrowDown.keyCode);

    // After ArrowDown selection should advance one row — to `a` (the first
    // child of root).
    expect(tree.getSelection()).toBe(a);
    tree.dispose();
  });

  it("ArrowUp moves selection to the previous visible row", async () => {
    const { root, a, b } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();

    // Start at `b` (last visible row) and press Up — should land on `a`.
    tree.setSelection(b);
    expect(tree.getSelection()).toBe(b);

    pressKey(host, Keys.ArrowUp.key, Keys.ArrowUp.keyCode);

    expect(tree.getSelection()).toBe(a);
    tree.dispose();
  });

  it("ArrowRight on a collapsed-with-children expands AND sets aria-expanded='true'", async () => {
    const { root, a } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();

    // `a` starts collapsed (default for non-root). Sanity check:
    expect(readRowLabels(host)).not.toContain("a1");
    const rowA = findRowByLabel(host, "a");
    expect(rowA).not.toBeNull();
    expect(rowA?.getAttribute("aria-expanded")).toBe("false");

    tree.setSelection(a);
    pressKey(host, Keys.ArrowRight.key, Keys.ArrowRight.keyCode);
    await flushMicrotasks();

    // After ArrowRight `a` should be expanded and its children visible.
    expect(readRowLabels(host)).toContain("a1");
    // aria-expanded on the `a` row must read "true" SYNCHRONOUSLY (we
    // re-stamp in expand() before yielding to the microtask queue, so the
    // attribute is up-to-date even without the await above — but we keep the
    // await for parity with the spec's async data source).
    const rowAAfter = findRowByLabel(host, "a");
    expect(rowAAfter?.getAttribute("aria-expanded")).toBe("true");
    tree.dispose();
  });

  it("ArrowRight on an already-expanded row moves selection to the first child", async () => {
    const { root, a, a1 } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();

    // Pre-expand `a` so it's already open.
    tree.expand(a);
    await flushMicrotasks();
    expect(readRowLabels(host)).toContain("a1");

    tree.setSelection(a);
    pressKey(host, Keys.ArrowRight.key, Keys.ArrowRight.keyCode);

    // Selection should move down to the first child of `a` (which is `a1`).
    expect(tree.getSelection()).toBe(a1);
    tree.dispose();
  });

  it("ArrowRight on a leaf does nothing (no error)", async () => {
    const { root, b } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();

    // `b` is a leaf (no children).
    tree.setSelection(b);
    const labelsBefore = readRowLabels(host);

    // Must not throw and must not change visible rows.
    expect(() => pressKey(host, Keys.ArrowRight.key, Keys.ArrowRight.keyCode)).not.toThrow();
    expect(readRowLabels(host)).toEqual(labelsBefore);
    // Selection unchanged.
    expect(tree.getSelection()).toBe(b);

    // The `b` row should have NO aria-expanded attribute (leaves don't get
    // one per WAI-ARIA: removeAttribute path in stampAriaOnRow).
    const rowB = findRowByLabel(host, "b");
    expect(rowB).not.toBeNull();
    expect(rowB?.hasAttribute("aria-expanded")).toBe(false);
    tree.dispose();
  });

  it("ArrowLeft on an expanded row collapses AND sets aria-expanded='false'", async () => {
    const { root, a } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();
    tree.expand(a);
    await flushMicrotasks();
    expect(readRowLabels(host)).toContain("a1");
    expect(findRowByLabel(host, "a")?.getAttribute("aria-expanded")).toBe("true");

    tree.setSelection(a);
    pressKey(host, Keys.ArrowLeft.key, Keys.ArrowLeft.keyCode);

    // Children must be hidden after collapse.
    expect(readRowLabels(host)).not.toContain("a1");
    // aria-expanded must read "false" synchronously.
    expect(findRowByLabel(host, "a")?.getAttribute("aria-expanded")).toBe("false");
    tree.dispose();
  });

  it("ArrowLeft on a collapsed row moves selection to the parent", async () => {
    const { root, a, a1 } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();
    tree.expand(a);
    await flushMicrotasks();

    // a1 is a leaf (no children) but DOES have a parent (`a`). ArrowLeft on
    // a non-expanded row should move selection up to the parent.
    tree.setSelection(a1);
    expect(tree.getSelection()).toBe(a1);

    pressKey(host, Keys.ArrowLeft.key, Keys.ArrowLeft.keyCode);

    expect(tree.getSelection()).toBe(a);
    tree.dispose();
  });

  it("Home / End jump to first / last visible row", async () => {
    const { root, a, b } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();

    // After setInput root + a + b are visible. End → last row should be `b`.
    tree.setSelection(a);
    pressKey(host, Keys.End.key, Keys.End.keyCode);
    expect(tree.getSelection()).toBe(b);

    // Home → first row should be root.
    pressKey(host, Keys.Home.key, Keys.Home.keyCode);
    expect(tree.getSelection()).toBe(root);
    tree.dispose();
  });

  it("aria-level matches depth on every rendered row + container has role='tree'", async () => {
    const { root, a } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();
    tree.expand(a);
    await flushMicrotasks();

    // The host (user-supplied container) gets role="tree".
    expect(host.getAttribute("role")).toBe("tree");

    // Every visible row has role="treeitem" and aria-level = depth + 1.
    // Visible tree after expand(a): root (0) -> a (1) -> a1 (2), a2 (2) -> b (1).
    const expected: Array<[string, string]> = [
      ["root", "1"],
      ["a", "2"],
      ["a1", "3"],
      ["a2", "3"],
      ["b", "2"],
    ];
    for (const [label, level] of expected) {
      const row = findRowByLabel(host, label);
      expect(row, `row '${label}'`).not.toBeNull();
      expect(row?.getAttribute("role"), `role on ${label}`).toBe("treeitem");
      expect(row?.getAttribute("aria-level"), `aria-level on ${label}`).toBe(level);
    }
    tree.dispose();
  });

  it("aria-selected flips on selection change", async () => {
    const { root, a, b } = buildTree();
    const host = makeHost();
    const { source } = makeDataSource();
    const tree = new Tree<Node>(host, source, makeRenderer());
    tree.layout(400, 300);
    tree.setInput(root);
    await flushMicrotasks();

    // Initially nothing is selected — every visible row has aria-selected="false".
    for (const label of ["root", "a", "b"]) {
      expect(findRowByLabel(host, label)?.getAttribute("aria-selected")).toBe("false");
    }

    // Select `a` → only `a` should read "true".
    tree.setSelection(a);
    expect(findRowByLabel(host, "a")?.getAttribute("aria-selected")).toBe("true");
    expect(findRowByLabel(host, "root")?.getAttribute("aria-selected")).toBe("false");
    expect(findRowByLabel(host, "b")?.getAttribute("aria-selected")).toBe("false");

    // Move selection to `b` → the flip is observable on BOTH rows.
    tree.setSelection(b);
    expect(findRowByLabel(host, "a")?.getAttribute("aria-selected")).toBe("false");
    expect(findRowByLabel(host, "b")?.getAttribute("aria-selected")).toBe("true");
    tree.dispose();
  });
});
