// src/webview/fileTree/FileTreeSash.ts — Resize-boundary sash for the file
// tree panel.
//
// The sash is a 4px invisible touch zone on the edge of the panel that
// faces the terminal area. On `pointerdown` it captures the pointer and
// converts subsequent pointer movement into a `--file-tree-size` change
// via the caller's `applySize` callback. Visual position + cursor are
// controlled by the layout wrapper's position class (`.file-tree--{left|
// right|top|bottom}`); the sash element itself never carries orientation.
//
// Extracted from `FileTreePanel` so the panel can stay focused on tree
// lifecycle. See: review round-1 follow-up — Oracle #1 (file-tree core).
//
// Lifetime:
//   - `recreate()` tears down the existing DOM + listeners and remounts.
//     Called from `FileTreePanel.setPosition` whenever the orientation
//     flips between horizontal and vertical.
//   - `dispose()` is permanent — removes DOM + listeners and marks the
//     instance unusable.

import type { FileTreePosition } from "../../types/messages";

export interface FileTreeSashDeps {
  /** Host element inside `.file-tree-panel`. The sash mounts as a child. */
  host: HTMLElement;
  /** Reads the current position (sash sign + axis derive from this). */
  getPosition: () => FileTreePosition;
  /** Reads the current size — used as the drag-start anchor. */
  getStartSize: () => number;
  /** Applies the new size during drag. The caller clamps. */
  applySize: (next: number) => void;
  /** Called once on pointerup (NOT on every move) — persist + fit hook. */
  onCommit?: () => void;
}

/**
 * Whether the panel sits beside (not above/below) the terminal area.
 * Re-used by `FileTreePanel` for the same `left | right` predicate it would
 * otherwise duplicate.
 */
export function isHorizontalLayout(pos: FileTreePosition): boolean {
  return pos === "left" || pos === "right";
}

/**
 * `grow` is the sign of dimension change per positive pointer delta. Sash
 * sits on the edge that faces the terminal area:
 *   position=left  → sash on right edge,  +dx grows  (sign +1)
 *   position=right → sash on left edge,  +dx shrinks (sign -1)
 *   position=top   → sash on bottom edge, +dy grows  (sign +1)
 *   position=bottom→ sash on top edge,    +dy shrinks (sign -1)
 */
function growSignFor(pos: FileTreePosition): 1 | -1 {
  return pos === "left" || pos === "top" ? 1 : -1;
}

export class FileTreeSash {
  private sashEl: HTMLElement | null = null;
  private detachPointerDown: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly deps: FileTreeSashDeps) {}

  /**
   * Tear down any existing sash DOM + listeners and mount a fresh one on the
   * current edge. Safe to call repeatedly; safe to call after the panel was
   * re-mounted at a different orientation.
   */
  recreate(): void {
    this.teardown();
    if (this.disposed) {
      return;
    }
    const { host } = this.deps;
    const doc = host.ownerDocument;
    const sash = doc.createElement("div");
    sash.className = "sash";
    sash.setAttribute("role", "separator");
    // Sash is absolutely positioned via CSS so insert order doesn't matter
    // for layout — first-child keeps it out of the tab order naturally.
    host.insertBefore(sash, host.firstChild);
    this.sashEl = sash;

    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) {
        return;
      }
      ev.preventDefault();
      sash.setPointerCapture(ev.pointerId);
      sash.classList.add("sash-active");
      const startSize = this.deps.getStartSize();
      const position = this.deps.getPosition();
      const horizontal = isHorizontalLayout(position);
      const grow = growSignFor(position);
      const startX = ev.clientX;
      const startY = ev.clientY;

      const onMove = (mv: PointerEvent) => {
        const delta = horizontal ? mv.clientX - startX : mv.clientY - startY;
        this.deps.applySize(startSize + delta * grow);
      };
      const onUp = (_up: PointerEvent) => {
        sash.releasePointerCapture(ev.pointerId);
        sash.classList.remove("sash-active");
        sash.removeEventListener("pointermove", onMove);
        sash.removeEventListener("pointerup", onUp);
        sash.removeEventListener("pointercancel", onUp);
        this.deps.onCommit?.();
      };

      sash.addEventListener("pointermove", onMove);
      sash.addEventListener("pointerup", onUp);
      sash.addEventListener("pointercancel", onUp);
    };

    sash.addEventListener("pointerdown", onPointerDown);
    this.detachPointerDown = () => sash.removeEventListener("pointerdown", onPointerDown);
  }

  /** Tear down listeners + DOM. Idempotent. */
  private teardown(): void {
    this.detachPointerDown?.();
    this.detachPointerDown = null;
    if (this.sashEl) {
      this.sashEl.remove();
      this.sashEl = null;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.teardown();
  }
}
