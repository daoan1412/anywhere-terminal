// @vitest-environment jsdom

// Confirms the panel's two contract points:
//   - empty-state when no workspace folder is open
//   - click-to-open file rows post `OpenFileMessage` with both `path` AND a
//     non-null `sessionId` resolved via the injected `getActiveSessionId()`
//     helper (mirroring DragDropHandler — see design.md Risk Map).
//
// The Tree's listWidget needs `ResizeObserver` and `matchMedia` shims under
// JSDOM (see `src/test/vendor-import.test.ts`).

import { beforeAll, describe, expect, it } from "vitest";
import type {
  CancelFileTreeSearchMessage,
  OpenFileMessage,
  RequestFileTreeSearchMessage,
  RequestReadDirectoryMessage,
  RequestSetFileTreePositionMessage,
} from "../../types/messages";
import { FileTreePanel } from "./FileTreePanel";

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

type AnyMsg =
  | RequestReadDirectoryMessage
  | OpenFileMessage
  | RequestSetFileTreePositionMessage
  | RequestFileTreeSearchMessage
  | CancelFileTreeSearchMessage;

function createHost(): HTMLElement {
  const host = document.createElement("div");
  host.style.height = "200px";
  host.style.width = "300px";
  document.body.appendChild(host);
  return host;
}

describe("FileTreePanel", () => {
  it("renders empty-state placeholder when workspaceRoot is null", () => {
    const host = createHost();
    const panel = new FileTreePanel({
      host,
      workspaceRoot: null,
      rootGeneration: 0,
      getActiveSessionId: () => "any-session",
      postMessage: () => {},
    });

    const empty = host.querySelector(".file-tree-empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("No folder open");
    // No Tree should have been constructed — host itself is NOT stamped with role="tree".
    expect(host.getAttribute("role")).toBeNull();

    panel.dispose();
  });

  it("posts OpenFileMessage with both path AND sessionId on file activation", () => {
    const host = createHost();
    const posted: AnyMsg[] = [];

    const panel = new FileTreePanel({
      host,
      workspaceRoot: "/workspace",
      rootGeneration: 5,
      getActiveSessionId: () => "sess-A",
      postMessage: (m) => posted.push(m),
    });

    panel.handleActivate({
      name: "main.ts",
      path: "/workspace/src/main.ts",
      kind: "file",
    });

    const openFileMsgs = posted.filter((m): m is OpenFileMessage => m.type === "openFile");
    expect(openFileMsgs).toHaveLength(1);
    expect(openFileMsgs[0]).toMatchObject({
      type: "openFile",
      path: "/workspace/src/main.ts",
      sessionId: "sess-A",
    });

    panel.dispose();
  });

  it("does NOT post OpenFileMessage when getActiveSessionId returns null", () => {
    const host = createHost();
    const posted: AnyMsg[] = [];

    const panel = new FileTreePanel({
      host,
      workspaceRoot: "/workspace",
      rootGeneration: 5,
      getActiveSessionId: () => null,
      postMessage: (m) => posted.push(m),
    });

    panel.handleActivate({
      name: "main.ts",
      path: "/workspace/src/main.ts",
      kind: "file",
    });

    const openFileMsgs = posted.filter((m): m is OpenFileMessage => m.type === "openFile");
    expect(openFileMsgs).toHaveLength(0);

    panel.dispose();
  });

  it("does NOT activate synthetic search footer rows", () => {
    const host = createHost();
    const posted: AnyMsg[] = [];

    const panel = new FileTreePanel({
      host,
      workspaceRoot: "/workspace",
      rootGeneration: 5,
      getActiveSessionId: () => "sess-A",
      postMessage: (m) => posted.push(m),
    });

    panel.handleActivate({
      name: "Showing first 2000 files in scope — narrow your scope to see more",
      path: "__overflow__",
      kind: "file",
      searchRow: { relativePath: "__overflow__", variant: "overflow-footer" },
    });

    const openFileMsgs = posted.filter((m): m is OpenFileMessage => m.type === "openFile");
    expect(openFileMsgs).toHaveLength(0);

    panel.dispose();
  });

  it("constructs a Tree (body stamped role='tree') when workspaceRoot is provided", () => {
    const host = createHost();
    const panel = new FileTreePanel({
      host,
      workspaceRoot: "/workspace",
      rootGeneration: 0,
      getActiveSessionId: () => "sess-A",
      postMessage: () => {},
    });

    // The Tree now mounts inside `.file-tree-body` (header sits above it),
    // so role="tree" lands on the body, not the panel host.
    const body = host.querySelector(".file-tree-body");
    expect(body?.getAttribute("role")).toBe("tree");
    expect(host.querySelector(".file-tree-empty")).toBeNull();
    // Header strip with the move button should be present alongside the body.
    expect(host.querySelector(".file-tree-header__btn")).not.toBeNull();

    panel.dispose();
  });
});
