// @vitest-environment jsdom
// src/webview/fileTree/ReadOnlyFileRenderer.test.ts — jsdom tests for the
// read-only file-tree row renderer.
//
// Covers the two row shapes the renderer must produce:
//   - directory row: chevron visible, icon slot collapsed via `icon-hidden`
//   - file (leaf) row: chevron collapsed via `chevron-hidden`, icon visible
//     and bound to the vendored Seti font (`seti-file-icon` class, inline
//     `color` tint from `resolveSetiIcon`)
//
// See: asimov/changes/port-vscode-async-data-tree/specs/file-tree-panel/spec.md#requirement-file-tree-panel-component

import { describe, expect, it } from "vitest";

import type { FileNode } from "./IFileSystemProvider";
import { FILE_TREE_DRAG_MIME, ReadOnlyFileRenderer } from "./ReadOnlyFileRenderer";

function mountRow(node: FileNode, depth: number) {
  const renderer = new ReadOnlyFileRenderer();
  const container = document.createElement("div");
  const template = renderer.renderTemplate(container);
  renderer.renderElement(node, depth, template);
  return { renderer, container, template };
}

describe("ReadOnlyFileRenderer", () => {
  it("exposes a stable templateId matching ITreeRenderer contract", () => {
    const renderer = new ReadOnlyFileRenderer();
    expect(renderer.templateId).toBe("file-tree-row");
  });

  it("renders a folder row with a visible chevron and hidden icon slot", () => {
    const folder: FileNode = {
      name: "src",
      path: "/repo/src",
      kind: "directory",
    };
    const { container, template } = mountRow(folder, 0);

    const row = container.querySelector(".file-tree-row");
    expect(row).not.toBeNull();
    expect(row).toBe(template.row);

    const chevron = row!.querySelector(".chevron");
    expect(chevron).not.toBeNull();
    expect(chevron!.classList.contains("chevron-hidden")).toBe(false);

    // Per Seti convention — folder rows show chevron only, no glyph icon.
    expect(template.icon.classList.contains("icon-hidden")).toBe(true);
    expect(template.icon.classList.contains("seti-file-icon")).toBe(false);
    expect(template.icon.textContent).toBe("");
    expect(template.name.textContent).toBe("src");
    expect(template.row.dataset.depth).toBe("0");
    expect(template.row.style.paddingLeft).toBe("20px");
  });

  it("renders a file row with a Seti glyph icon and a hidden chevron slot", () => {
    const file: FileNode = {
      name: "README.md",
      path: "/repo/README.md",
      kind: "file",
    };
    const { container, template } = mountRow(file, 2);

    const row = container.querySelector(".file-tree-row");
    expect(row).not.toBeNull();

    const chevron = row!.querySelector(".chevron");
    expect(chevron).not.toBeNull();
    expect(chevron!.classList.contains("chevron-hidden")).toBe(true);

    // File row → icon visible with Seti font + inline color from theme JSON.
    expect(template.icon.classList.contains("seti-file-icon")).toBe(true);
    expect(template.icon.classList.contains("icon-hidden")).toBe(false);
    expect(template.icon.textContent?.length).toBe(1); // single Seti glyph
    expect(template.icon.style.color).toMatch(/^#?[a-z0-9]+|rgb/i);
    expect(template.name.textContent).toBe("README.md");
    expect(template.row.dataset.depth).toBe("2");
    expect(template.row.style.paddingLeft).toBe("60px");
  });

  it("rebinds the same template when an existing row is reused", () => {
    const renderer = new ReadOnlyFileRenderer();
    const container = document.createElement("div");
    const template = renderer.renderTemplate(container);

    renderer.renderElement({ name: "src", path: "/repo/src", kind: "directory" }, 0, template);
    expect(template.chevron.classList.contains("chevron-hidden")).toBe(false);
    expect(template.icon.classList.contains("icon-hidden")).toBe(true);
    expect(template.icon.classList.contains("seti-file-icon")).toBe(false);

    renderer.renderElement({ name: "a.ts", path: "/repo/a.ts", kind: "file" }, 1, template);
    expect(template.chevron.classList.contains("chevron-hidden")).toBe(true);
    expect(template.icon.classList.contains("seti-file-icon")).toBe(true);
    expect(template.icon.classList.contains("icon-hidden")).toBe(false);
    expect(template.name.textContent).toBe("a.ts");
    expect(template.row.style.paddingLeft).toBe("40px");

    // disposeTemplate now detaches the dragstart listener; calling it must not throw.
    expect(() => renderer.disposeTemplate(template)).not.toThrow();
  });

  it("marks every row draggable=true and sets 3 MIME types on dragstart", () => {
    const node: FileNode = {
      name: "main.ts",
      path: "/repo/src/main.ts",
      kind: "file",
    };
    const { template } = mountRow(node, 1);

    expect(template.row.getAttribute("draggable")).toBe("true");

    // Mock DataTransfer — jsdom 28's DragEvent ships with a minimal one but its
    // setData behaviour varies by version; using a fake captures exactly what
    // the renderer wrote.
    const writes: Record<string, string> = {};
    const dt = {
      setData(format: string, value: string): void {
        writes[format] = value;
      },
      effectAllowed: "",
    } as unknown as DataTransfer;

    const dragEvent = Object.assign(new Event("dragstart") as DragEvent, {
      dataTransfer: dt,
    });
    template.row.dispatchEvent(dragEvent);

    expect(writes[FILE_TREE_DRAG_MIME]).toBe("/repo/src/main.ts");
    expect(writes["text/plain"]).toBe("/repo/src/main.ts");
    expect(writes["text/uri-list"]).toBe(encodeURI("file:///repo/src/main.ts"));
    expect(dt.effectAllowed).toBe("copyLink");
  });

  it("falls back silently when DataTransfer is unavailable on dragstart", () => {
    const node: FileNode = {
      name: "main.ts",
      path: "/repo/src/main.ts",
      kind: "file",
    };
    const { template } = mountRow(node, 0);

    // Event constructed with `dataTransfer: null` (some browsers / synthesized
    // tests do this). The handler must NOT throw.
    const evt = new Event("dragstart") as DragEvent;
    expect(() => template.row.dispatchEvent(evt)).not.toThrow();
  });
});

describe("ReadOnlyFileRenderer — git decorations", () => {
  it("applies the matching git-{status} class for each GitStatus value", () => {
    const cases: Array<[FileNode["gitStatus"], string]> = [
      ["modified", "git-modified"],
      ["added", "git-added"],
      ["deleted", "git-deleted"],
      ["renamed", "git-renamed"],
      ["untracked", "git-untracked"],
      ["conflicted", "git-conflicted"],
      ["ignored", "git-ignored"],
    ];
    for (const [status, cls] of cases) {
      const { template } = mountRow({ name: "x.ts", path: "/repo/x.ts", kind: "file", gitStatus: status }, 0);
      expect(template.row.classList.contains(cls)).toBe(true);
    }
  });

  it("strips a previously-applied git-* class when status clears", () => {
    const renderer = new ReadOnlyFileRenderer();
    const container = document.createElement("div");
    const template = renderer.renderTemplate(container);

    renderer.renderElement({ name: "a.ts", path: "/repo/a.ts", kind: "file", gitStatus: "modified" }, 0, template);
    expect(template.row.classList.contains("git-modified")).toBe(true);

    renderer.renderElement({ name: "a.ts", path: "/repo/a.ts", kind: "file" /* no status */ }, 0, template);
    expect(template.row.classList.contains("git-modified")).toBe(false);
    for (const cls of template.row.classList) {
      expect(cls.startsWith("git-")).toBe(false);
    }
  });

  it("stamps the right badge letter for files and clears it when undecorated", () => {
    const renderer = new ReadOnlyFileRenderer();
    const container = document.createElement("div");
    const template = renderer.renderTemplate(container);

    const expectLetter = (status: FileNode["gitStatus"], letter: string) => {
      renderer.renderElement({ name: "x", path: "/x", kind: "file", gitStatus: status }, 0, template);
      expect(template.gitBadge.textContent).toBe(letter);
      expect(template.gitBadge.classList.contains("is-visible")).toBe(letter.length > 0);
    };

    expectLetter("modified", "M");
    expectLetter("added", "A");
    expectLetter("deleted", "D");
    expectLetter("renamed", "R");
    expectLetter("untracked", "U");
    expectLetter("conflicted", "C");
    expectLetter("ignored", ""); // ignored gets tint but no badge
    expectLetter(undefined, "");
  });

  it("renders a folder dirty badge `•` and applies git-folder-dirty when dirtyDescendantCount > 0", () => {
    const folder: FileNode = {
      name: "src",
      path: "/repo/src",
      kind: "directory",
      dirtyDescendantCount: 3,
    };
    const { template } = mountRow(folder, 0);
    expect(template.row.classList.contains("git-folder-dirty")).toBe(true);
    expect(template.gitBadge.textContent).toBe("•");
    expect(template.gitBadge.classList.contains("is-visible")).toBe(true);
  });

  it("clears the folder dirty badge when dirtyDescendantCount drops to 0", () => {
    const renderer = new ReadOnlyFileRenderer();
    const container = document.createElement("div");
    const template = renderer.renderTemplate(container);
    renderer.renderElement({ name: "src", path: "/repo/src", kind: "directory", dirtyDescendantCount: 2 }, 0, template);
    expect(template.row.classList.contains("git-folder-dirty")).toBe(true);
    renderer.renderElement({ name: "src", path: "/repo/src", kind: "directory", dirtyDescendantCount: 0 }, 0, template);
    expect(template.row.classList.contains("git-folder-dirty")).toBe(false);
    expect(template.gitBadge.classList.contains("is-visible")).toBe(false);
  });

  it("does NOT apply the deprecated `.is-ignored` class anywhere", () => {
    const { template } = mountRow(
      { name: "x.ts", path: "/repo/x.ts", kind: "file", ignored: true, gitStatus: "ignored" },
      0,
    );
    expect(template.row.classList.contains("is-ignored")).toBe(false);
    // Cache-look in case of stale state.
    for (const cls of template.row.classList) {
      expect(cls).not.toBe("is-ignored");
    }
  });

  it("search-row mode hydrates git status from the data source's cache", () => {
    const lookup = {
      getCachedNode: (p: string) => (p === "/repo/changed.ts" ? { gitStatus: "modified" as const } : undefined),
    };
    const renderer = new ReadOnlyFileRenderer(lookup);
    const container = document.createElement("div");
    const template = renderer.renderTemplate(container);

    const matched: FileNode = {
      name: "changed.ts",
      path: "/repo/changed.ts",
      kind: "file",
      searchRow: { relativePath: "changed.ts", variant: "match" },
    };
    renderer.renderElement(matched, 0, template);
    expect(template.row.classList.contains("git-modified")).toBe(true);
    expect(template.gitBadge.textContent).toBe("M");

    const uncached: FileNode = {
      name: "untouched.ts",
      path: "/repo/untouched.ts",
      kind: "file",
      searchRow: { relativePath: "untouched.ts", variant: "match" },
    };
    renderer.renderElement(uncached, 0, template);
    expect(template.row.classList.contains("git-modified")).toBe(false);
    expect(template.gitBadge.classList.contains("is-visible")).toBe(false);
  });
});
