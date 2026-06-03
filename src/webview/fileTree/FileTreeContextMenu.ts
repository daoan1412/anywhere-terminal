import type { FileNode } from "./IFileSystemProvider";

export type FileTreeContextMenuAction = "reveal-in-os" | "copy-path" | "copy-relative-path" | "delete";

export interface FileTreeContextMenuEvent {
  action: FileTreeContextMenuAction;
  node: FileNode;
}

export class FileTreeContextMenu {
  private readonly host: HTMLElement;
  private readonly onAction: (event: FileTreeContextMenuEvent) => void;
  private readonly revealLabel: string;
  private menuEl: HTMLElement | null = null;
  private menuRow: HTMLElement | null = null;
  private onDocPointerDown?: (ev: MouseEvent) => void;
  private onDocKeyDown?: (ev: KeyboardEvent) => void;

  constructor(deps: { host: HTMLElement; onAction: (event: FileTreeContextMenuEvent) => void; platform?: string }) {
    this.host = deps.host;
    this.onAction = deps.onAction;
    this.revealLabel = isMacPlatform(deps.platform ?? globalThis.navigator?.platform ?? "")
      ? "Reveal in Finder"
      : "Reveal in File Explorer";
  }

  isOpen(): boolean {
    return this.menuEl !== null;
  }

  open(node: FileNode, ev: MouseEvent, row: HTMLElement): void {
    this.close();

    const menu = document.createElement("div");
    menu.className = "file-tree-context-menu";
    menu.setAttribute("role", "menu");

    const items: Array<{ label: string; action: FileTreeContextMenuAction } | "sep"> = [
      { label: this.revealLabel, action: "reveal-in-os" },
      { label: "Copy Path", action: "copy-path" },
      { label: "Copy Relative Path", action: "copy-relative-path" },
      "sep",
      { label: "Delete", action: "delete" },
    ];

    for (const item of items) {
      if (item === "sep") {
        const separator = document.createElement("hr");
        separator.className = "file-tree-context-menu__separator";
        menu.appendChild(separator);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        item.action === "delete"
          ? "file-tree-context-menu__item file-tree-context-menu__item--danger"
          : "file-tree-context-menu__item";
      button.setAttribute("role", "menuitem");
      button.textContent = item.label;
      button.addEventListener("click", () => {
        this.onAction({ action: item.action, node });
        this.close();
      });
      menu.appendChild(button);
    }

    this.host.appendChild(menu);
    this.position(menu, ev);

    this.menuEl = menu;
    this.menuRow = row;
    row.classList.add("is-context-open");

    this.onDocPointerDown = (e) => {
      if (this.menuEl && !this.menuEl.contains(e.target as Node)) {
        this.close();
      }
    };
    this.onDocKeyDown = (e) => {
      if (e.key === "Escape") {
        this.close({ restoreFocus: true });
      }
    };
    document.addEventListener("mousedown", this.onDocPointerDown);
    document.addEventListener("keydown", this.onDocKeyDown);
  }

  close(opts: { restoreFocus?: boolean } = {}): void {
    if (this.onDocPointerDown) {
      document.removeEventListener("mousedown", this.onDocPointerDown);
      this.onDocPointerDown = undefined;
    }
    if (this.onDocKeyDown) {
      document.removeEventListener("keydown", this.onDocKeyDown);
      this.onDocKeyDown = undefined;
    }
    const row = this.menuRow;
    row?.classList.remove("is-context-open");
    this.menuRow = null;
    this.menuEl?.remove();
    this.menuEl = null;
    if (opts.restoreFocus) {
      row?.focus();
    }
  }

  dispose(): void {
    this.close();
  }

  private position(menu: HTMLElement, ev: MouseEvent): void {
    const rect = this.host.getBoundingClientRect();
    let left = ev.clientX - rect.left;
    let top = ev.clientY - rect.top;
    const maxLeft = this.host.clientWidth - menu.offsetWidth - 4;
    const maxTop = this.host.clientHeight - menu.offsetHeight - 4;
    if (maxLeft > 0 && left > maxLeft) {
      left = maxLeft;
    }
    if (maxTop > 0 && top > maxTop) {
      top = maxTop;
    }
    menu.style.left = `${Math.max(4, left)}px`;
    menu.style.top = `${Math.max(4, top)}px`;
  }
}

function isMacPlatform(platform: string): boolean {
  return /\bMac|iPhone|iPad|iPod/i.test(platform);
}
