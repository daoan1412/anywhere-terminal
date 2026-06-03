// Mechanical floating-window behavior for the preview card: resize (8 handles),
// move (header drag), maximize/restore, and geometry persistence (a Memento that
// survives close→reopen + reloads). Deliberately knows NOTHING about vault
// entries / timelines — it only manipulates the element it is given, so it stays
// reusable. Positioning is viewport-based (the card is position:fixed).

import type { VaultPreviewGeometry } from "../state/WebviewState";
import { ICON_MAXIMIZE, ICON_RESTORE } from "./icons";

type Geometry = { top: number; left: number; width: number; height: number };

export interface FloatingWindowDeps {
  /** The floating element to drive (the `.vault-preview` aside). */
  el: HTMLElement;
  /** Geometry to restore on construction (size/pos/maximized), if any. */
  initialGeometry?: VaultPreviewGeometry | null;
  /** Persist geometry whenever the user drags/resizes/maximizes. */
  persistGeometry?: (geometry: VaultPreviewGeometry) => void;
  /** The row to anchor to when no geometry is remembered (re-queried live). */
  getAnchorRow: () => HTMLElement | null;
  /** Lowest viewport y the card's top may occupy — e.g. the bottom of the
   *  terminal tab bar, so the card never covers it. Re-queried live so it tracks
   *  the tab bar showing/hiding. Defaults to 0. */
  getMinTop?: () => number;
}

export class FloatingWindow {
  /** Edge/corner handles, re-attached on every render via setPreviewContent. */
  readonly resizeHandles: HTMLElement[];
  private readonly el: HTMLElement;
  private readonly persistGeometry?: (geometry: VaultPreviewGeometry) => void;
  private readonly getAnchorRow: () => HTMLElement | null;
  private readonly getMinTop: () => number;
  /** Remembered floating size+position (null until the user resizes/maximizes). */
  private geometry: Geometry | null = null;
  private maximized = false;
  /** Tears down an in-flight resize/move drag WITHOUT committing geometry (W5). */
  private activeGestureTeardown?: () => void;

  constructor(deps: FloatingWindowDeps) {
    this.el = deps.el;
    this.persistGeometry = deps.persistGeometry;
    this.getAnchorRow = deps.getAnchorRow;
    this.getMinTop = deps.getMinTop ?? (() => 0);
    const seeded = deps.initialGeometry ?? null;
    if (seeded) {
      this.geometry = { top: seeded.top, left: seeded.left, width: seeded.width, height: seeded.height };
      this.maximized = seeded.maximized === true;
    }
    this.resizeHandles = this.createResizeHandles();
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  /** Abort an in-flight drag (called by closePreview so a mid-drag close doesn't
   *  leak listeners or persist a half-dragged geometry). */
  cancelGesture(): void {
    this.activeGestureTeardown?.();
  }

  /** Place the card on open: remembered geometry / maximized, else anchor to the
   *  live row (re-queried via getAnchorRow — no stored row ref). */
  place(): void {
    this.el.classList.toggle("vault-preview--max", this.maximized);
    if (this.maximized) {
      this.clearInlineGeometry();
      return;
    }
    if (this.geometry) {
      this.applyGeometry(this.geometry);
    } else {
      const row = this.getAnchorRow();
      if (row) {
        this.anchor(row);
      }
    }
  }

  /** Toggle between floating size and a full-viewport overlay. */
  toggleMaximize(): void {
    if (!this.maximized) {
      this.captureGeometry(); // remember floating size/pos for restore
    }
    this.maximized = !this.maximized;
    this.el.classList.toggle("vault-preview--max", this.maximized);
    const btn = this.el.querySelector<HTMLButtonElement>(".vault-preview-maximize");
    if (this.maximized) {
      this.clearInlineGeometry();
      if (btn) {
        // No `.title` here — the custom tooltip tracks the label; setting `.title`
        // would reintroduce the slow native tooltip alongside it.
        btn.innerHTML = ICON_RESTORE;
        btn.setAttribute("aria-label", "Restore size");
        btn.setAttribute("aria-pressed", "true");
      }
    } else {
      if (btn) {
        btn.innerHTML = ICON_MAXIMIZE;
        btn.setAttribute("aria-label", "Expand to full size");
        btn.setAttribute("aria-pressed", "false");
      }
      if (this.geometry) {
        this.applyGeometry(this.geometry);
      } else {
        const row = this.getAnchorRow();
        if (row) {
          this.anchor(row);
        }
      }
    }
    this.persistState();
  }

  /** Drag the header to move the card (size pinned). Ignores action buttons, the
   *  selectable meta block, and a plain click (no movement → no pin/persist). */
  startMove(ev: PointerEvent): void {
    if (this.maximized || ev.button !== 0) {
      return;
    }
    const target = ev.target as Element | null;
    if (target?.closest(".vault-preview-title-actions")) {
      return; // header action buttons keep their own click behaviour
    }
    if (target?.closest(".vault-preview-meta")) {
      return; // the meta block stays selectable (drag works on its padding)
    }
    this.activeGestureTeardown?.(); // only one gesture's listeners live at a time
    ev.preventDefault();
    const rect = this.el.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startL = rect.left;
    const startT = rect.top;
    const w = rect.width;
    const h = rect.height;
    const pointerId = ev.pointerId;
    const handle = ev.currentTarget as HTMLElement;
    handle.setPointerCapture?.(pointerId);
    this.el.style.right = "auto";
    let moved = false;
    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) {
        return; // a second pointer (multi-touch / pen) must not hijack this drag
      }
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) {
        return; // sub-pixel jitter — a plain click must not pin/persist geometry
      }
      moved = true;
      const l = Math.max(0, Math.min(startL + dx, window.innerWidth - 40));
      const t = Math.max(this.topFloor(), Math.min(startT + dy, window.innerHeight - 40));
      this.el.style.left = `${l}px`;
      this.el.style.top = `${t}px`;
      this.el.style.width = `${w}px`;
      this.el.style.height = `${h}px`;
    };
    const teardown = (): void => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      handle.releasePointerCapture?.(pointerId);
      this.activeGestureTeardown = undefined;
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) {
        return;
      }
      teardown();
      if (moved) {
        this.captureGeometry();
      }
    };
    this.activeGestureTeardown = teardown;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  private createResizeHandles(): HTMLElement[] {
    const dirs = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
    return dirs.map((dir) => {
      const h = document.createElement("div");
      h.className = `vault-preview-resize vault-preview-resize-${dir}`;
      h.setAttribute("aria-hidden", "true");
      h.addEventListener("pointerdown", (ev) => this.startResize(ev, dir));
      return h;
    });
  }

  private startResize(ev: PointerEvent, dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"): void {
    if (this.maximized) {
      return;
    }
    this.activeGestureTeardown?.(); // only one gesture's listeners live at a time
    ev.preventDefault();
    ev.stopPropagation();
    const rect = this.el.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const startL = rect.left;
    const startT = rect.top;
    const minW = 280;
    const minH = 160;
    const pointerId = ev.pointerId;
    const handle = ev.currentTarget as HTMLElement;
    handle.setPointerCapture?.(pointerId);
    this.el.style.right = "auto";

    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) {
        return; // a second pointer must not hijack this resize
      }
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let w = startW;
      let h = startH;
      let l = startL;
      let t = startT;
      if (dir.includes("e")) {
        w = startW + dx;
      }
      if (dir.includes("s")) {
        h = startH + dy;
      }
      if (dir.includes("w")) {
        w = startW - dx;
        l = startL + dx;
      }
      if (dir.includes("n")) {
        h = startH - dy;
        t = startT + dy;
      }
      if (w < minW) {
        if (dir.includes("w")) {
          l = startL + (startW - minW);
        }
        w = minW;
      }
      if (h < minH) {
        if (dir.includes("n")) {
          t = startT + (startH - minH);
        }
        h = minH;
      }
      l = Math.max(0, Math.min(l, window.innerWidth - 40));
      t = Math.max(this.topFloor(), Math.min(t, window.innerHeight - 40));
      this.el.style.left = `${l}px`;
      this.el.style.top = `${t}px`;
      this.el.style.width = `${w}px`;
      this.el.style.height = `${h}px`;
    };
    const teardown = (): void => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      handle.releasePointerCapture?.(pointerId);
      this.activeGestureTeardown = undefined;
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) {
        return;
      }
      teardown();
      this.captureGeometry(); // commit; an aborted drag skips this (no persist)
    };
    this.activeGestureTeardown = teardown;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  /** Floor for the card's top: 8px from the viewport edge, pushed down below a
   *  shown terminal tab bar so the card never covers it. */
  private topFloor(): number {
    return Math.max(8, this.getMinTop());
  }

  private applyGeometry(g: Geometry): void {
    // Clamp into the CURRENT viewport — a geometry saved in a larger window must
    // not place the card off-screen. Mirrors the resize/move bounds.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(280, g.width), Math.max(280, vw - 16));
    const height = Math.min(Math.max(160, g.height), Math.max(160, vh - 16));
    const left = Math.max(0, Math.min(g.left, Math.max(0, vw - 40)));
    const top = Math.max(this.topFloor(), Math.min(g.top, Math.max(0, vh - 40)));
    this.el.style.right = "auto";
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.style.width = `${width}px`;
    this.el.style.height = `${height}px`;
  }

  private clearInlineGeometry(): void {
    this.el.style.top = "";
    this.el.style.left = "";
    this.el.style.right = "";
    this.el.style.width = "";
    this.el.style.height = "";
  }

  private captureGeometry(): void {
    const r = this.el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      this.geometry = { top: r.top, left: r.left, width: r.width, height: r.height };
      this.persistState();
    }
  }

  private persistState(): void {
    if (!this.geometry) {
      return;
    }
    this.persistGeometry?.({ ...this.geometry, maximized: this.maximized });
  }

  /** Anchor near the row in VIEWPORT coords — prefer left of the row, then right,
   *  then clamp in-viewport. The card is position:fixed so it can overlap content. */
  private anchor(row: HTMLElement): void {
    if (this.maximized) {
      return;
    }
    const rowRect = row.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = this.el.offsetWidth || 560;
    const h = this.el.offsetHeight || Math.min(Math.round(vh * 0.7), 560);
    let left = rowRect.left - w - 12;
    if (left < 8) {
      left = rowRect.right + 12;
    }
    left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8));
    const top = Math.max(this.topFloor(), Math.min(rowRect.top, vh - h - 8));
    this.el.style.right = "auto";
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }
}
