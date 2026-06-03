// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTreeContextMenu } from "./FileTreeContextMenu";
import type { FileNode } from "./IFileSystemProvider";

function makeMenu() {
  const host = document.createElement("div");
  host.style.width = "400px";
  host.style.height = "300px";
  Object.defineProperty(host, "clientWidth", { configurable: true, value: 400 });
  Object.defineProperty(host, "clientHeight", { configurable: true, value: 300 });
  document.body.appendChild(host);
  const onAction = vi.fn();
  const menu = new FileTreeContextMenu({ host, onAction, platform: "MacIntel" });
  const row = document.createElement("div");
  row.tabIndex = 0;
  host.appendChild(row);
  const node: FileNode = { name: "src", path: "/repo/src", kind: "directory" };
  const ev = new MouseEvent("contextmenu", { clientX: 24, clientY: 32, bubbles: true });
  return { host, menu, onAction, row, node, ev };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("FileTreeContextMenu", () => {
  it("renders required items in order with menu semantics", () => {
    const { menu, row, node, ev } = makeMenu();

    menu.open(node, ev, row);

    const menuEl = document.querySelector<HTMLElement>(".file-tree-context-menu");
    expect(menuEl).not.toBeNull();
    expect(menuEl?.getAttribute("role")).toBe("menu");
    const items = [...document.querySelectorAll<HTMLButtonElement>(".file-tree-context-menu [role='menuitem']")];
    expect(items.map((item) => item.textContent)).toEqual([
      "Reveal in Finder",
      "Copy Path",
      "Copy Relative Path",
      "Delete",
    ]);
    expect(document.querySelectorAll(".file-tree-context-menu__separator")).toHaveLength(1);
    expect(row.classList.contains("is-context-open")).toBe(true);
  });

  it("emits actions and closes on item activation", () => {
    const { menu, onAction, row, node, ev } = makeMenu();
    menu.open(node, ev, row);

    const copyRelative = [
      ...document.querySelectorAll<HTMLButtonElement>(".file-tree-context-menu [role='menuitem']"),
    ].find((item) => item.textContent === "Copy Relative Path");
    copyRelative?.click();

    expect(onAction).toHaveBeenCalledWith({ action: "copy-relative-path", node });
    expect(document.querySelector(".file-tree-context-menu")).toBeNull();
    expect(row.classList.contains("is-context-open")).toBe(false);
  });

  it("closes on Escape and restores focus to the opening row", () => {
    const { menu, row, node, ev } = makeMenu();
    const focus = vi.spyOn(row, "focus");
    menu.open(node, ev, row);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(document.querySelector(".file-tree-context-menu")).toBeNull();
    expect(focus).toHaveBeenCalled();
  });

  it("closes on outside click without firing an action", () => {
    const { menu, onAction, node, ev, row } = makeMenu();
    menu.open(node, ev, row);

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(document.querySelector(".file-tree-context-menu")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });
});
