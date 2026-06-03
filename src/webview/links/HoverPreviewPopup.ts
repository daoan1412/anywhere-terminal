// src/webview/links/HoverPreviewPopup.ts — Floating preview popup mounted on
// `document.body` as a `position: fixed` overlay (clamped to the webview
// viewport) so it can extend out of the terminal over the AI vault / file tree
// for more room. Keeps the `xterm-hover` class as a styling/identity hook.
//
// See: asimov/changes/add-hover-file-preview/design.md D2, D8, D10
// See: asimov/changes/add-hover-file-preview/specs/file-link-hover-preview/spec.md
//   #requirement-preview-popup-dom-contract
//   #requirement-preview-popup-positioning
//   #requirement-popup-header-path-disclosure
//   #requirement-popup-states-for-non-ok-results
//   #requirement-accessibility--inertness

import type { FilePreviewResultMessage, HoverPreviewSettings } from "../../types/messages";
import type { HoverPreviewPopupHost, HoverPreviewThemeKind } from "./HoverPreviewController";
import type { PastedImagePreview } from "./PastedImageStore";

/** Pixel offset from the hover anchor to the popup's top-left corner (below). */
const ANCHOR_OFFSET_Y = 12;
/** Inset from the terminal's right / bottom edges. */
const VIEWPORT_INSET = 16;
/**
 * Default popup width for every hover. Wider than the old fixed 560 so typical
 * code previews aren't cramped; still clamped to the terminal width so it never
 * exceeds the viewport. The popup remembers nothing between hovers — each
 * `show()` re-anchors at this width; drag/resize apply only to the live popup.
 */
export const DEFAULT_POPUP_WIDTH = 640;
/**
 * Upper bound the user can resize the live popup to (also clamped to the
 * terminal width at show time). Raised above DEFAULT so the SE-grip can grow
 * the popup within the current hover.
 */
export const MAX_POPUP_WIDTH = 1000;
/** Auto-height cap for a fresh popup, before any in-session resize grows it. */
export const MAX_POPUP_HEIGHT = 360;
/** Lower bounds so a resize can't shrink the popup into an unusable sliver. */
export const MIN_POPUP_WIDTH = 280;
export const MIN_POPUP_HEIGHT = 120;

/** Clamp `value` into the inclusive `[lo, hi]` range (lo wins if lo > hi). */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** True iff the result variant carries a resolved `absPath` field. */
function hasAbsPath(
  result: FilePreviewResultMessage,
): result is
  | Extract<FilePreviewResultMessage, { absPath: string }>
  | Extract<FilePreviewResultMessage, { absPath?: string }> {
  if (result.status === "ok" || result.status === "binary" || result.status === "too-large") {
    return true;
  }
  if (result.status === "requires-confirmation") {
    return typeof result.absPath === "string" && result.absPath.length > 0;
  }
  return false;
}

/** True iff the result variant carries a `totalBytes` field. */
function hasTotalBytes(
  result: FilePreviewResultMessage,
): result is Extract<FilePreviewResultMessage, { totalBytes: number } | { totalBytes?: number }> {
  return (
    result.status === "ok" ||
    result.status === "binary" ||
    result.status === "too-large" ||
    result.status === "requires-confirmation"
  );
}

/** Format a byte count for human-readable placeholders ("12.3 KB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Result of position math — coordinates relative to terminal.element. */
export interface ComputedPosition {
  left: number;
  top: number;
  /** True when the popup flipped to appear ABOVE the anchor. */
  flipped: boolean;
}

/**
 * Compute the popup's top-left corner within the terminal's padding box.
 *
 * - Default: anchor + (0, ANCHOR_OFFSET_Y).
 * - If overflows right: shift left to fit (clamped at left=0).
 * - If overflows bottom: flip to anchor - (0, ANCHOR_OFFSET_Y) - popupHeight.
 */
export function computePosition(
  anchorX: number,
  anchorY: number,
  popupWidth: number,
  popupHeight: number,
  terminalWidth: number,
  terminalHeight: number,
): ComputedPosition {
  let left = anchorX;
  let top = anchorY + ANCHOR_OFFSET_Y;
  let flipped = false;

  // Clamp horizontally.
  if (left + popupWidth > terminalWidth) {
    left = Math.max(0, terminalWidth - popupWidth);
  }

  // Flip vertically if it would overflow bottom.
  if (top + popupHeight > terminalHeight) {
    const flippedTop = anchorY - ANCHOR_OFFSET_Y - popupHeight;
    if (flippedTop >= 0) {
      top = flippedTop;
      flipped = true;
    } else {
      // Doesn't fit either direction — clamp at terminalHeight - popupHeight,
      // truncating from below. Visual content overflow scrolls.
      top = Math.max(0, terminalHeight - popupHeight);
    }
  }

  return { left, top, flipped };
}

/**
 * Detect the platform modifier-key label for the trust-policy "Press X to
 * preview" placeholder. Webview-side `navigator.platform` is available even
 * under strict CSP. macOS shows ⌘ Cmd, Win/Linux shows Ctrl.
 */
function modifierLabel(): string {
  const platform = typeof navigator !== "undefined" ? navigator.platform : "";
  return /Mac|iPhone|iPod|iPad/i.test(platform) ? "Cmd" : "Ctrl";
}

/** Render content for a non-ok status — exported for tests. */
export function renderPlaceholderText(status: FilePreviewResultMessage["status"], totalBytes?: number): string {
  switch (status) {
    case "not-found":
      return "";
    case "binary":
      return `Binary file (${formatBytes(totalBytes ?? 0)})`;
    case "too-large":
      return `File too large (${formatBytes(totalBytes ?? 0)})`;
    case "ambiguous":
      return "Multiple matches — click to choose";
    case "error":
      return "Could not load preview";
    case "requires-confirmation":
      return `Press ${modifierLabel()} to preview`;
    case "ok":
      return "";
  }
}

/** Function the popup calls back into when its own listeners trigger dismiss. */
export type OnDismiss = () => void;

/**
 * Function injected to render the code body (Shiki) — task 3_3 supplies it.
 *
 * `onAsyncRefresh` is invoked AFTER the async Shiki highlighter finishes
 * loading and the wrapper's `innerHTML` has been replaced with highlighted
 * markup. The popup uses this hook to re-apply the active-line class +
 * re-scroll because the prior DOM (and the highlight class) was destroyed
 * by the innerHTML replacement (round-2 W5).
 *
 * Renderers that never refresh asynchronously (or are already cached) MAY
 * call the callback synchronously OR omit it — the popup tolerates both.
 */
export type RenderCode = (
  content: string,
  languageId: string,
  theme: HoverPreviewThemeKind,
  onAsyncRefresh?: () => void,
) => HTMLElement;

/** Function injected to render the markdown body (markdown-it + Shiki) — task 3_4 supplies it. */
export type RenderMarkdown = (
  content: string,
  theme: HoverPreviewThemeKind,
  onAsyncRefresh?: () => void,
) => HTMLElement;

export interface HoverPreviewPopupDeps {
  /** Notified when the popup self-dismisses (mousedown outside, wheel, Escape). */
  onDismiss?: OnDismiss;
  /**
   * Called when the cursor enters the popup DOM. The controller uses this to
   * cancel any pending leave-grace dismissal so the popup stays alive while
   * the user moves into it (to scroll, click, etc).
   */
  onPointerEnter?: () => void;
  /**
   * Called when the cursor leaves the popup DOM. The controller uses this to
   * start a fresh grace timer — gives the user a window to return to the
   * link or move to dismiss.
   */
  onPointerLeave?: () => void;
  /** Render the code body. Optional — popup falls back to a <pre> escape when missing. */
  renderCode?: RenderCode;
  /** Render the markdown body. Optional — popup falls back to renderCode when missing. */
  renderMarkdown?: RenderMarkdown;
  /**
   * Reads the full settings snapshot. When provided, the popup renders a
   * footer toolbar with a delay input. Omit to render the popup without a
   * footer (e.g. unit tests).
   */
  getSettings?: () => HoverPreviewSettings;
  /**
   * Push a setting change up to the host. The host persists via
   * `workspace.getConfiguration().update()` and re-broadcasts on
   * `hoverPreviewSettings` so every popup sees the new value.
   */
  onUpdateSetting?: (key: keyof HoverPreviewSettings, value: boolean | number) => void;
  /**
   * Invoked when the user clicks the header "Open" button. The host wires
   * this to post an `openFile` message so the file is opened in an editor
   * tab (same flow as clicking the underlined path in the terminal). The
   * popup dismisses itself right after invoking the callback.
   */
  onOpenFile?: (result: FilePreviewResultMessage) => void;
}

/** Concrete popup that implements `HoverPreviewPopupHost`. */
export class HoverPreviewPopup implements HoverPreviewPopupHost {
  private el: HTMLDivElement | null = null;
  private host: HTMLElement | null = null;
  private readonly onDismiss?: OnDismiss;
  private readonly onPointerEnter?: () => void;
  private readonly onPointerLeave?: () => void;
  private readonly renderCode?: RenderCode;
  private readonly renderMarkdown?: RenderMarkdown;
  private readonly getSettings?: () => HoverPreviewSettings;
  private readonly onUpdateSetting?: (key: keyof HoverPreviewSettings, value: boolean | number) => void;
  private readonly onOpenFile?: (result: FilePreviewResultMessage) => void;
  private disposed = false;

  /**
   * True while a drag (move) or resize gesture is in flight. Suppresses the
   * pointer-leave → controller leave-grace dismissal so the cursor crossing
   * the popup boundary mid-gesture can't tear the popup down (which would
   * abort the drag/resize). Cleared on `mouseup`.
   */
  private interacting = false;
  /** Cleanup for the active gesture's pointer capture + per-handle pointermove/up/cancel listeners. */
  private gestureCleanup: (() => void) | null = null;

  // Listeners attached on show; removed on hide.
  private readonly onWindowMouseDown = (event: MouseEvent) => {
    if (this.el && event.target && this.el.contains(event.target as Node)) {
      // Click inside popup — keep it. Stop propagation so the controller's
      // terminal-level `mousedown` listener doesn't see this event and
      // dismiss us mid-interaction. Drag/resize are driven by dedicated
      // `pointerdown` handlers on the header + grip (pointer capture, so the
      // gesture survives the cursor leaving the webview iframe) — a separate
      // event flow this mouse-path doesn't touch.
      event.stopPropagation();
      return;
    }
    this.dismissSelf();
  };
  // Wheel-to-dismiss is owned by the controller (gated by cursorOverPopup so
  // wheels inside the popup scroll the popup body instead of dismissing). The
  // listener that used to live here on `this.host` would fire for scrolls
  // inside the popup too, hiding it the moment the user tried to scroll.
  //
  // We DO need a wheel handler on the popup root itself: `stopPropagation`
  // prevents the wheel from bubbling out and reaching xterm's viewport scroll
  // (which would otherwise scroll the terminal buffer underneath while the
  // user is trying to scroll the preview content). The browser's default
  // action — scrolling the popup if it has overflow content — runs first
  // because stopPropagation doesn't suppress defaults.
  private readonly onPopupWheel = (event: WheelEvent) => {
    event.stopPropagation();
  };
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.dismissSelf();
    }
  };

  constructor(deps: HoverPreviewPopupDeps = {}) {
    this.onDismiss = deps.onDismiss;
    this.onPointerEnter = deps.onPointerEnter;
    this.onPointerLeave = deps.onPointerLeave;
    this.renderCode = deps.renderCode;
    this.renderMarkdown = deps.renderMarkdown;
    this.getSettings = deps.getSettings;
    this.onUpdateSetting = deps.onUpdateSetting;
    this.onOpenFile = deps.onOpenFile;
  }

  show(anchor: MouseEvent, result: FilePreviewResultMessage, theme: HoverPreviewThemeKind): void {
    if (this.disposed) {
      return;
    }
    if (result.status === "not-found") {
      this.hide();
      return;
    }
    const header = this.buildFileHeader(result);
    const body = this.buildFileBody(result, theme);
    // Line-focus scroll MUST run after the popup is in the DOM AND positioned —
    // scrollIntoView no-ops on detached elements (the body is the scroll
    // container). The active-line class was set during renderOkBody.
    this.renderShell(anchor, header, body, () => {
      if (this.el) {
        this.scrollToActiveLine(this.el);
      }
    });
  }

  /**
   * Show a pasted-image preview. Reuses the same shell (positioning, drag/
   * resize, dismissal) as the file preview; the body is just an `<img>` bound
   * to the cached `blob:` object URL — resolved entirely webview-side, no IPC.
   * See: asimov/changes/preview-pasted-images/design.md D4.
   */
  showImage(anchor: MouseEvent, image: PastedImagePreview): void {
    if (this.disposed) {
      return;
    }
    const labelText = `Pasted image · ${formatBytes(image.byteSize)}`;
    const header = document.createElement("div");
    header.className = "anywhere-hover-preview-header";
    const label = document.createElement("span");
    label.className = "anywhere-hover-preview-header-path";
    label.textContent = labelText;
    label.setAttribute("title", labelText);
    header.appendChild(label);

    const body = document.createElement("div");
    body.className = "anywhere-hover-preview-body";
    const img = document.createElement("img");
    img.className = "anywhere-hover-preview-image";
    img.src = image.url;
    img.alt = labelText;
    body.appendChild(img);

    this.renderShell(
      anchor,
      header,
      body,
      (root) => {
        // The blob hasn't decoded at first measure, so the popup was positioned
        // for a near-empty box (couldn't flip). Re-anchor once the image has real
        // height — guarded on `this.el === root` so a load that resolves after the
        // popup was replaced/dismissed doesn't move a different popup.
        const reposition = () => {
          if (this.el === root) {
            this.positionPopup(root, anchor);
          }
        };
        if (img.complete && img.naturalHeight > 0) {
          reposition();
        } else {
          img.addEventListener("load", reposition, { once: true });
        }
      },
      // Auto-grow to the image's width-scaled height (viewport-bounded), rather
      // than the file preview's fixed height cap.
      Number.POSITIVE_INFINITY,
    );
  }

  /** Build the file-preview header (path label + optional Open button). */
  private buildFileHeader(result: FilePreviewResultMessage): HTMLElement {
    const header = document.createElement("div");
    header.className = "anywhere-hover-preview-header";
    // Show absPath when resolved, else the echoed request path — every popup
    // must display some path (spec "Popup header").
    const headerPath = (hasAbsPath(result) ? result.absPath : undefined) ?? result.path;
    const pathLabel = document.createElement("span");
    pathLabel.className = "anywhere-hover-preview-header-path";
    pathLabel.textContent = headerPath;
    pathLabel.setAttribute("title", headerPath);
    header.appendChild(pathLabel);
    // Open button hidden for error; not-found results are ignored before the
    // popup is rendered.
    if (this.onOpenFile && this.canOpen(result)) {
      header.appendChild(this.buildOpenButton(result));
    }
    return header;
  }

  /** Build the file-preview body (code/markdown when ok, else a placeholder). */
  private buildFileBody(result: FilePreviewResultMessage, theme: HoverPreviewThemeKind): HTMLElement {
    // `-body-numbers` enables the CSS-counter gutter on each `.line`. See D14.
    const body = document.createElement("div");
    body.className = "anywhere-hover-preview-body anywhere-hover-preview-body-numbers";
    if (result.status === "ok") {
      this.renderOkBody(body, result, theme);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "anywhere-hover-preview-placeholder";
      const totalBytes = hasTotalBytes(result) ? result.totalBytes : undefined;
      placeholder.textContent = renderPlaceholderText(result.status, totalBytes);
      body.appendChild(placeholder);
    }
    return body;
  }

  /**
   * Mount `header` + `body` as the popup shell on document.body: sizing,
   * footer, SE-resize grip, height measure, viewport-clamped positioning, and
   * listeners. `header` doubles as the drag handle. Shared by `show` (file) and
   * `showImage` (image) so both inherit identical chrome + behavior. The popup
   * remembers nothing between hovers — each call re-anchors at the default size
   * (z-index 1001 keeps it above the vault overlay at 1000).
   */
  private renderShell(
    anchor: MouseEvent,
    header: HTMLElement,
    body: HTMLElement,
    afterMount?: (root: HTMLDivElement) => void,
    maxPopupHeight: number = MAX_POPUP_HEIGHT,
  ): void {
    const terminalElement = this.findTerminalElement(anchor);
    if (!terminalElement) {
      return;
    }
    // Unmount any prior — one popup at a time.
    this.unmountElement();

    const root = document.createElement("div");
    root.className = "xterm-hover anywhere-hover-preview";
    root.setAttribute("role", "tooltip");
    root.style.position = "fixed";
    root.style.zIndex = "1001";

    // Image previews pass Infinity so the popup auto-grows to the image's
    // width-scaled height (capped only by the viewport) instead of the file
    // preview's fixed cap — positionPopup reads this back off root.style.maxHeight.
    const bounds = this.computeBounds();
    const popupWidth = clamp(DEFAULT_POPUP_WIDTH, bounds.minWidth, bounds.maxWidth);
    const autoMaxHeight = Math.min(maxPopupHeight, bounds.maxHeight);
    root.style.width = `${popupWidth}px`;
    root.style.maxWidth = `${bounds.maxWidth}px`;
    root.style.maxHeight = `${autoMaxHeight}px`;
    root.style.overflow = "hidden";
    // Hide until measured + positioned so the user never sees the pre-anchor frame.
    root.style.visibility = "hidden";
    root.style.left = "0px";
    root.style.top = "0px";

    // The header doubles as the drag-to-move handle; pointer capture keeps the
    // gesture alive when the cursor leaves the narrow sidebar iframe.
    header.addEventListener("pointerdown", this.onHeaderPointerDown);
    root.appendChild(header);
    root.appendChild(body);

    if (this.getSettings && this.onUpdateSetting) {
      root.appendChild(this.buildFooter(this.getSettings(), this.onUpdateSetting));
    }

    const grip = document.createElement("div");
    grip.className = "anywhere-hover-preview-resize-grip";
    grip.setAttribute("aria-hidden", "true");
    grip.addEventListener("pointerdown", this.onGripPointerDown);
    root.appendChild(grip);

    document.body.appendChild(root);

    this.el = root;
    this.host = document.body;

    this.positionPopup(root, anchor);
    root.style.visibility = "";

    this.attachListeners();

    afterMount?.(root);
  }

  /**
   * (Re)compute the popup's viewport-clamped top-left from `anchor` and the
   * popup's CURRENT measured height, then apply it. Called once at mount and
   * again after an async `<img>` loads: the image has no height at first
   * measure, so the initial placement can't decide to flip above — re-running
   * this once the real height is known lets computePosition flip the popup
   * upward when there isn't room below (so it isn't clipped). See showImage.
   */
  private positionPopup(root: HTMLDivElement, anchor: MouseEvent): void {
    // Read width + the height cap back off the live root (renderShell set them;
    // the cap differs for image vs file previews). Fall back to the file cap.
    const bounds = this.computeBounds();
    const width = this.styleNum(root.style.width) ?? clamp(DEFAULT_POPUP_WIDTH, bounds.minWidth, bounds.maxWidth);
    const cap = this.styleNum(root.style.maxHeight) ?? Math.min(MAX_POPUP_HEIGHT, bounds.maxHeight);
    // Fall back to the cap when offsetHeight is 0 (jsdom computes no layout).
    const measured = root.offsetHeight;
    const actualHeight = measured > 0 ? Math.min(measured, cap) : cap;
    const vp = this.viewportSize();
    const pos = computePosition(anchor.clientX, anchor.clientY, width, actualHeight, vp.width, vp.height);
    root.style.left = `${pos.left}px`;
    root.style.top = `${pos.top}px`;
  }

  /**
   * True when the result carries enough info to open the file in an editor.
   * Hidden for `not-found` / `error`; not-found results are ignored before the
   * popup is rendered.
   */
  private canOpen(result: FilePreviewResultMessage): boolean {
    if (result.status === "not-found" || result.status === "error") {
      return false;
    }
    return typeof result.path === "string" && result.path.length > 0;
  }

  /**
   * Build the icon button that fires `onOpenFile(result)` and dismisses the
   * popup. The SVG is inlined to avoid an external sprite dependency; the
   * shape mirrors VSCode's `go-to-file` codicon (page silhouette + arrow).
   *
   * Mousedown stops propagation so the window-level outside-click listener
   * doesn't dismiss the popup mid-click. The actual open + dismiss runs on
   * `click` (after the mouseup fires).
   */
  private buildOpenButton(result: FilePreviewResultMessage): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "anywhere-hover-preview-open-btn";
    btn.title = "Open file";
    btn.setAttribute("aria-label", "Open file");
    // 14×14 inline SVG — open-in-editor / external-link glyph.
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">' +
      '<path d="M9 1v1h3.293L6.146 8.146l.708.708L13 2.707V6h1V1H9zM2 3h5v1H3v9h9V9h1v5H2V3z"/>' +
      "</svg>";
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        this.onOpenFile?.(result);
      } catch (err) {
        console.warn("[AnyWhere Terminal] onOpenFile threw:", err);
      }
      this.dismissSelf();
    });
    return btn;
  }

  /**
   * Build the popup footer — currently only the delay (ms) number input.
   * Posts `updateHoverPreviewSetting` to the host on change.
   *
   * Inputs use mousedown.stopPropagation so the controller/popup's outside-
   * mousedown listeners don't dismiss when the user clicks the field.
   */
  private buildFooter(
    settings: HoverPreviewSettings,
    onUpdate: (key: keyof HoverPreviewSettings, value: boolean | number) => void,
  ): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "anywhere-hover-preview-footer";
    footer.addEventListener("mousedown", (e) => e.stopPropagation());

    const delayWrap = document.createElement("label");
    delayWrap.className = "anywhere-hover-preview-footer-delay";
    const delayLabel = document.createElement("span");
    delayLabel.textContent = "Delay";
    const delayInput = document.createElement("input");
    delayInput.type = "number";
    delayInput.min = "100";
    delayInput.max = "2000";
    delayInput.step = "50";
    delayInput.value = String(settings.delay);
    delayInput.addEventListener("change", () => {
      const n = Number.parseInt(delayInput.value, 10);
      if (Number.isFinite(n) && n >= 100 && n <= 2000) {
        onUpdate("delay", n);
      }
    });
    delayWrap.appendChild(delayLabel);
    delayWrap.appendChild(delayInput);
    footer.appendChild(delayWrap);

    return footer;
  }

  hide(): void {
    this.unmountElement();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unmountElement();
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private renderOkBody(
    body: HTMLElement,
    result: Extract<FilePreviewResultMessage, { status: "ok" }>,
    theme: HoverPreviewThemeKind,
  ): void {
    const { content, isMarkdown, languageId, truncated, line } = result;
    // Round-2 W5: when the renderer falls back to plain `<pre>` and later
    // async-replaces with Shiki HTML, the active-line class and scroll
    // position get destroyed. The popup hands a refresh callback to the
    // renderer that re-applies both. Skipped for markdown bodies because
    // markdown's line→DOM mapping is lossy.
    const onAsyncRefresh =
      line !== undefined && !isMarkdown
        ? () => {
            // The previous `rendered` node was replaced in-place via innerHTML —
            // its outer element is still the same node, so re-marking from `body`
            // finds the fresh `.line` spans Shiki just generated.
            this.markActiveLine(body, line);
            if (this.el) {
              this.scrollToActiveLine(this.el);
            }
          }
        : undefined;
    let rendered: HTMLElement | null = null;
    if (isMarkdown && this.renderMarkdown) {
      try {
        rendered = this.renderMarkdown(content, theme, onAsyncRefresh);
        body.appendChild(rendered);
      } catch (err) {
        console.warn("[AnyWhere Terminal] renderMarkdown threw, falling back:", err);
        rendered = null;
      }
    }
    if (!rendered && this.renderCode) {
      try {
        rendered = this.renderCode(content, languageId, theme, onAsyncRefresh);
        body.appendChild(rendered);
      } catch (err) {
        console.warn("[AnyWhere Terminal] renderCode threw, falling back:", err);
        rendered = null;
      }
    }
    if (!rendered) {
      // Plain text fallback. Wrap each line in a span so scroll-to-line works
      // even without Shiki (the highlighter wraps in `<span class="line">`).
      const pre = document.createElement("pre");
      pre.className = "anywhere-hover-preview-plain";
      for (const ln of content.split("\n")) {
        const span = document.createElement("span");
        span.className = "line";
        span.textContent = `${ln}\n`;
        pre.appendChild(span);
      }
      body.appendChild(pre);
      rendered = pre;
    }
    if (truncated) {
      const note = document.createElement("div");
      note.className = "anywhere-hover-preview-truncated";
      note.textContent = "Preview truncated.";
      body.appendChild(note);
    }
    // Mark the active line right away — adding the highlight class is safe
    // even on a detached element. The actual `scrollIntoView` MUST run AFTER
    // the popup is appended to the DOM (a detached element has no scroll
    // box, so scrollIntoView silently no-ops). `show()` invokes
    // `scrollToActiveLine(body)` after `terminalElement.appendChild(root)`.
    if (line !== undefined && !isMarkdown) {
      this.markActiveLine(body, line);
    }
  }

  /** Add the highlight class to the Nth `.line` element. No layout effects. */
  private markActiveLine(body: HTMLElement, line: number): void {
    if (line < 1) {
      return;
    }
    const lines = body.querySelectorAll<HTMLElement>(".line");
    const target = lines[line - 1];
    if (target) {
      target.classList.add("anywhere-hover-preview-line-active");
    }
  }

  /**
   * Scroll the currently-active `.line` (marked by `markActiveLine`) to the
   * vertical center of the popup. MUST be called AFTER the popup is appended
   * to the DOM — `scrollIntoView` is a no-op on detached elements.
   */
  private scrollToActiveLine(body: HTMLElement): void {
    const target = body.querySelector<HTMLElement>(".anywhere-hover-preview-line-active");
    if (!target) {
      return;
    }
    // `scrollIntoView({ block: "center" })` keeps the popup body scrolled so
    // the target line is in the middle of the viewport without yanking the
    // surrounding page. JSDOM doesn't implement layout — calls are no-ops
    // there but don't throw.
    try {
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    } catch {
      // Defensive — some browsers reject options object.
    }
  }

  /**
   * Locate the `terminal.element` from the hover event. We walk up from the
   * event target until we hit an element with class `xterm`. Falls back to
   * the event's currentTarget when the walk doesn't find one.
   */
  private findTerminalElement(event: MouseEvent): HTMLElement | null {
    let node: Node | null = event.target as Node | null;
    while (node && node.nodeType === 1) {
      const el = node as HTMLElement;
      if (el.classList.contains("xterm")) {
        return el;
      }
      node = el.parentNode;
    }
    // Fallback: in unit tests we sometimes synthesize events whose target is
    // a stand-in for the terminal element directly.
    if (event.currentTarget instanceof HTMLElement) {
      return event.currentTarget;
    }
    if (event.target instanceof HTMLElement) {
      return event.target;
    }
    return null;
  }

  private attachListeners(): void {
    if (!this.host) {
      return;
    }
    window.addEventListener("mousedown", this.onWindowMouseDown, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    // mouseenter / mouseleave on the popup element drive the controller's
    // leave-grace timer so the popup stays alive while the cursor is over it.
    if (this.el) {
      this.el.addEventListener("mouseenter", this.onPopupMouseEnter);
      this.el.addEventListener("mouseleave", this.onPopupMouseLeave);
      // Stop wheel events at the popup boundary so xterm's viewport scroll
      // doesn't fire while the user is scrolling the preview body.
      this.el.addEventListener("wheel", this.onPopupWheel);
    }
  }

  private detachListeners(): void {
    window.removeEventListener("mousedown", this.onWindowMouseDown, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    if (this.el) {
      this.el.removeEventListener("mouseenter", this.onPopupMouseEnter);
      this.el.removeEventListener("mouseleave", this.onPopupMouseLeave);
      this.el.removeEventListener("wheel", this.onPopupWheel);
    }
  }

  private readonly onPopupMouseEnter = () => {
    try {
      this.onPointerEnter?.();
    } catch {
      // Best-effort — controller's enter handler shouldn't be able to throw,
      // but the popup must not break if a buggy callback does.
    }
  };

  private readonly onPopupMouseLeave = () => {
    if (this.interacting) {
      // A drag/resize is in flight — the cursor crossing the popup edge must
      // NOT start the controller's leave-grace dismissal (that would tear the
      // popup down mid-gesture). The gesture's own `mouseup` ends it cleanly.
      return;
    }
    try {
      this.onPointerLeave?.();
    } catch {
      // Best-effort.
    }
  };

  private unmountElement(): void {
    // End any in-flight drag/resize first so its pointer capture + move/up
    // listeners never outlive the popup (would otherwise leak across renders
    // and, in jsdom, across tests).
    this.endGesture();
    if (this.el) {
      try {
        this.detachListeners();
      } catch {
        // Best-effort.
      }
      this.el.remove();
      this.el = null;
      this.host = null;
    }
  }

  // ─── Drag / resize ─────────────────────────────────────────────────
  //
  // Both gestures use Pointer Events with setPointerCapture (mirroring
  // FileTreeSash). Capture is essential in the webview: the popup often lives
  // in a narrow sidebar iframe, and a mouse-based `window` mousemove/mouseup
  // gesture loses its `mouseup` the moment the cursor exits the iframe — so the
  // popup would stop tracking and never release the gesture. Pointer capture
  // routes pointermove / pointerup back to the captured element no matter where
  // the cursor goes, guaranteeing the gesture completes cleanly. The new
  // geometry lives only on the popup's inline styles — nothing is persisted, so
  // the next hover starts fresh at the default size/position.

  /** Pointerdown on the header → move gesture (unless the press is on the Open button). */
  private readonly onHeaderPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !this.el || !this.host) {
      return;
    }
    if ((event.target as HTMLElement | null)?.closest(".anywhere-hover-preview-open-btn")) {
      return;
    }
    this.beginPointerGesture(event, "move");
  };

  /** Pointerdown on the SE grip → resize gesture. */
  private readonly onGripPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !this.el || !this.host) {
      return;
    }
    this.beginPointerGesture(event, "resize");
  };

  /**
   * Drive a move/resize gesture from `pointerdown` until `pointerup` /
   * `pointercancel`, capturing the pointer to the affordance element. Sets
   * `interacting` (suppresses leave-dismiss) for the gesture's duration. The
   * gesture only mutates the live popup's inline geometry — nothing is
   * persisted. Mutually exclusive — a new gesture ends any prior one.
   */
  private beginPointerGesture(event: PointerEvent, kind: "move" | "resize"): void {
    if (!this.el || !this.host) {
      return;
    }
    this.endGesture();
    // Suppress text selection / native drag while dragging the handle.
    event.preventDefault();
    const el = this.el;
    const handle = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = this.styleNum(el.style.left) ?? el.offsetLeft;
    const startTop = this.styleNum(el.style.top) ?? el.offsetTop;
    const startWidth = this.styleNum(el.style.width) ?? el.offsetWidth;
    const startHeight = this.styleNum(el.style.height) ?? el.offsetHeight;
    const vp = this.viewportSize();
    const b = this.computeBounds();
    if (kind === "resize") {
      // A manual resize may grow the popup past the default height cap — lift
      // max-height to the full viewport so the explicit height isn't clipped.
      el.style.maxHeight = `${b.maxHeight}px`;
    }
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // Best-effort — jsdom / older engines may not implement pointer capture.
    }
    this.interacting = true;

    const onMove = (move: PointerEvent) => {
      try {
        if (kind === "move") {
          const width = this.styleNum(el.style.width) ?? el.offsetWidth;
          const height = this.styleNum(el.style.height) ?? el.offsetHeight;
          const left = clamp(startLeft + (move.clientX - startX), 0, Math.max(0, vp.width - width));
          const top = clamp(startTop + (move.clientY - startY), 0, Math.max(0, vp.height - height));
          el.style.left = `${left}px`;
          el.style.top = `${top}px`;
        } else {
          // Bound by the absolute caps AND the space remaining to the
          // viewport's right/bottom edge from the popup's top-left corner.
          const availW = Math.max(b.minWidth, vp.width - startLeft);
          const availH = Math.max(b.minHeight, vp.height - startTop);
          const width = clamp(startWidth + (move.clientX - startX), b.minWidth, Math.min(b.maxWidth, availW));
          const height = clamp(startHeight + (move.clientY - startY), b.minHeight, Math.min(b.maxHeight, availH));
          el.style.width = `${width}px`;
          el.style.height = `${height}px`;
        }
      } catch {
        // Best-effort — a throwing move handler must not strand the gesture.
      }
    };
    const onEnd = () => {
      // Geometry is intentionally not persisted — the live inline styles set by
      // `onMove` are the whole effect, and the next hover re-anchors at default.
      this.endGesture();
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
    this.gestureCleanup = () => {
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Best-effort.
      }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };
  }

  /** End the active gesture: release capture, drop listeners, clear the flag. Idempotent. */
  private endGesture(): void {
    this.interacting = false;
    if (this.gestureCleanup) {
      const cleanup = this.gestureCleanup;
      this.gestureCleanup = null;
      cleanup();
    }
  }

  // ─── Geometry helpers ──────────────────────────────────────────────

  /** Min/max width & height bounds for the popup within the webview viewport. */
  private computeBounds(): {
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    maxHeight: number;
  } {
    // Max = the space the popup may occupy inside the webview viewport. When the
    // viewport is narrower/shorter than the usability minimum, the popup shrinks
    // to fit rather than overflowing — so `max` is floored at 0 (not at MIN_*),
    // and `min` collapses down to `max` so the clamp range never inverts.
    const vp = this.viewportSize();
    const maxWidth = Math.max(0, Math.min(MAX_POPUP_WIDTH, vp.width - VIEWPORT_INSET));
    const maxHeight = Math.max(0, vp.height - VIEWPORT_INSET);
    return {
      minWidth: Math.min(MIN_POPUP_WIDTH, maxWidth),
      maxWidth,
      minHeight: Math.min(MIN_POPUP_HEIGHT, maxHeight),
      maxHeight,
    };
  }

  /**
   * Current webview viewport size — the popup is `position: fixed` and clamped
   * to this, so it can overlay the whole webview (vault, file tree, terminal).
   */
  private viewportSize(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  /** Parse a `"123px"` inline-style value to a number, or null when absent/invalid. */
  private styleNum(value: string): number | null {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }

  private dismissSelf(): void {
    this.unmountElement();
    try {
      this.onDismiss?.();
    } catch {
      // Best-effort.
    }
  }
}
