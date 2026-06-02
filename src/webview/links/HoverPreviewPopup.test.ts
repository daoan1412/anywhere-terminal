// @vitest-environment jsdom
// src/webview/links/HoverPreviewPopup.test.ts — DOM-level coverage for mount /
// unmount, position math, placeholder strings, dismissal listeners.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePreviewResultMessage } from "../../types/messages";
import {
  computePosition,
  DEFAULT_POPUP_WIDTH,
  formatBytes,
  HoverPreviewPopup,
  MAX_POPUP_HEIGHT,
  MAX_POPUP_WIDTH,
  MIN_POPUP_HEIGHT,
  MIN_POPUP_WIDTH,
  renderPlaceholderText,
} from "./HoverPreviewPopup";

/**
 * Pin the jsdom window's inner size. The popup mounts on document.body as a
 * `position: fixed` overlay and positions/clamps against the VIEWPORT (so it can
 * spill over the vault / file tree), so the viewport is what drives the math.
 */
function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
}

function makeTerminalElement(width = 800, height = 600): HTMLElement {
  const el = document.createElement("div");
  el.classList.add("xterm");
  // Override JSDOM's defaults so getBoundingClientRect + clientWidth return what we expect.
  el.style.position = "absolute";
  el.style.left = "0";
  el.style.top = "0";
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: height });
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }),
  });
  document.body.appendChild(el);
  // The popup clamps to the viewport now, not the terminal box — mirror the
  // terminal size into the window so the existing position expectations hold.
  setViewport(width, height);
  return el;
}

function fakeMouseEvent(target: HTMLElement, clientX: number, clientY: number): MouseEvent {
  const ev = new MouseEvent("mouseover", { clientX, clientY, bubbles: true });
  Object.defineProperty(ev, "target", { value: target });
  Object.defineProperty(ev, "currentTarget", { value: target });
  return ev;
}

/**
 * Build a complete `status: "ok"` FilePreviewResultMessage from a partial.
 * The discriminated union (round-1 W1) requires all 8 fields for the `ok`
 * variant; this helper supplies safe defaults so tests can stay terse.
 */
function makeOkResult(
  partial: Partial<Extract<FilePreviewResultMessage, { status: "ok" }>> = {},
): Extract<FilePreviewResultMessage, { status: "ok" }> {
  return {
    type: "filePreviewResult",
    path: "test/path",
    requestId: "r1",
    status: "ok",
    content: "",
    languageId: "plaintext",
    isMarkdown: false,
    truncated: false,
    totalBytes: 0,
    totalLines: 0,
    absPath: "/abs/test/path",
    ...partial,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  setViewport(1024, 768);
});
afterEach(() => {
  document.body.innerHTML = "";
  setViewport(1024, 768);
});

describe("HoverPreviewPopup — showImage (preview-pasted-images)", () => {
  it("mounts an <img> bound to the object URL with a byte-size header", () => {
    const popup = new HoverPreviewPopup();
    const term = makeTerminalElement();
    popup.showImage(fakeMouseEvent(term, 40, 40), {
      url: "blob:mock/xyz",
      mimeType: "image/png",
      byteSize: 2048,
      index: 1,
    });
    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    expect(root).toBeTruthy();
    const img = root.querySelector("img.anywhere-hover-preview-image") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("blob:mock/xyz");
    const header = root.querySelector(".anywhere-hover-preview-header-path") as HTMLElement;
    expect(header.textContent).toContain("2.0 KB");
  });

  it("re-anchors after the image loads so it can flip above when there's no room below", () => {
    const popup = new HoverPreviewPopup();
    const term = makeTerminalElement(800, 600);
    // Anchor near the bottom edge so a tall popup must flip above.
    popup.showImage(fakeMouseEvent(term, 100, 560), {
      url: "blob:mock/x",
      mimeType: "image/png",
      byteSize: 1,
      index: 1,
    });
    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    const img = root.querySelector("img.anywhere-hover-preview-image") as HTMLImageElement;

    // Simulate the browser: the decoded image now gives the popup a real height
    // that won't fit below the anchor. jsdom computes no layout, so force it.
    Object.defineProperty(root, "offsetHeight", { configurable: true, value: 300 });
    img.dispatchEvent(new Event("load"));

    // 560 + 12 + 300 = 872 > 600 → flips above: 560 - 12 - 300 = 248.
    expect(Number.parseFloat(root.style.top)).toBe(248);
  });

  it("does not move a replaced popup when a stale image load resolves", () => {
    const popup = new HoverPreviewPopup();
    const term = makeTerminalElement(800, 600);
    popup.showImage(fakeMouseEvent(term, 100, 560), {
      url: "blob:mock/stale",
      mimeType: "image/png",
      byteSize: 1,
      index: 1,
    });
    const staleRoot = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    const staleImg = staleRoot.querySelector("img.anywhere-hover-preview-image") as HTMLImageElement;

    // A second preview replaces the first (unmounts staleRoot, mounts a new one).
    popup.showImage(fakeMouseEvent(term, 100, 100), {
      url: "blob:mock/fresh",
      mimeType: "image/png",
      byteSize: 1,
      index: 2,
    });
    const freshRoot = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    const freshTopBefore = freshRoot.style.top;

    // The stale image's late load must not reposition the fresh popup.
    Object.defineProperty(staleRoot, "offsetHeight", { configurable: true, value: 300 });
    staleImg.dispatchEvent(new Event("load"));
    expect(freshRoot.style.top).toBe(freshTopBefore);
  });

  it("resizes via the SE grip without error, even if the image loads mid-gesture", () => {
    const popup = new HoverPreviewPopup();
    const term = makeTerminalElement(800, 600);
    popup.showImage(fakeMouseEvent(term, 50, 50), {
      url: "blob:mock/r",
      mimeType: "image/png",
      byteSize: 1,
      index: 1,
    });
    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    const grip = document.querySelector(".anywhere-hover-preview-resize-grip") as HTMLElement;
    const img = root.querySelector("img.anywhere-hover-preview-image") as HTMLImageElement;
    grip.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientX: 200,
        clientY: 200,
      }),
    );
    grip.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 260, clientY: 280 }));
    // Image finishes loading in the middle of the resize.
    Object.defineProperty(root, "offsetHeight", { configurable: true, value: 200 });
    img.dispatchEvent(new Event("load"));
    grip.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    // Width grew (640 + 60); no exception thrown.
    expect(root.style.width).toBe("700px");
  });

  it("reuses the shell — fixed-positioned and dismissable via hide()", () => {
    const popup = new HoverPreviewPopup();
    const term = makeTerminalElement();
    popup.showImage(fakeMouseEvent(term, 10, 10), {
      url: "blob:mock/a",
      mimeType: "image/png",
      byteSize: 1,
      index: 1,
    });
    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    expect(root.style.position).toBe("fixed");
    popup.hide();
    expect(document.querySelector(".anywhere-hover-preview")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("formats < 1 KiB as bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });
  it("formats KB / MB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
    expect(formatBytes(2_500_000)).toBe("2.38 MB");
  });
});

describe("computePosition", () => {
  it("places popup below the anchor by default", () => {
    const pos = computePosition(100, 100, 400, 200, 800, 600);
    expect(pos.left).toBe(100);
    expect(pos.top).toBe(112);
    expect(pos.flipped).toBe(false);
  });
  it("shifts left when popup would overflow the right edge", () => {
    const pos = computePosition(700, 100, 400, 200, 800, 600);
    expect(pos.left).toBe(400); // 800 - 400
    expect(pos.flipped).toBe(false);
  });
  it("flips above when popup would overflow the bottom edge", () => {
    const pos = computePosition(100, 500, 400, 200, 800, 600);
    expect(pos.flipped).toBe(true);
    expect(pos.top).toBe(500 - 12 - 200);
  });
});

describe("renderPlaceholderText", () => {
  it("returns the spec strings", () => {
    expect(renderPlaceholderText("not-found")).toBe("File not found");
    expect(renderPlaceholderText("binary", 12_345)).toBe("Binary file (12.1 KB)");
    expect(renderPlaceholderText("too-large", 2_000_000)).toBe("File too large (1.91 MB)");
    expect(renderPlaceholderText("ambiguous")).toBe("Multiple matches — click to choose");
    expect(renderPlaceholderText("error")).toBe("Could not load preview");
  });
});

describe("HoverPreviewPopup — show / hide", () => {
  it("mounts a div.xterm-hover.anywhere-hover-preview with role=tooltip as a fixed overlay on document.body", () => {
    const term = makeTerminalElement();
    const popup = new HoverPreviewPopup();
    popup.show(
      fakeMouseEvent(term, 50, 50),
      makeOkResult({ absPath: "/x/y/foo.ts", languageId: "typescript", content: "const x = 1;" }),
      "dark",
    );

    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement | null;
    expect(root).toBeTruthy();
    expect(root?.classList.contains("xterm-hover")).toBe(true);
    expect(root?.getAttribute("role")).toBe("tooltip");
    // Above the vault preview overlay (z-index 1000).
    expect(root?.style.zIndex).toBe("1001");
    // Mounted on document.body as a fixed overlay (NOT inside the terminal) so
    // it can extend over the vault / file tree.
    expect(root?.parentElement).toBe(document.body);
    expect(term.contains(root)).toBe(false);
    expect(root?.style.position).toBe("fixed");
  });

  it("shows the absPath in the header, truncated with title attribute", () => {
    const term = makeTerminalElement();
    const popup = new HoverPreviewPopup();
    popup.show(
      fakeMouseEvent(term, 50, 50),
      makeOkResult({ absPath: "/very/long/path/to/foo.ts", content: "x" }),
      "dark",
    );

    const pathLabel = document.querySelector(".anywhere-hover-preview-header-path") as HTMLElement | null;
    expect(pathLabel?.textContent).toBe("/very/long/path/to/foo.ts");
    expect(pathLabel?.getAttribute("title")).toBe("/very/long/path/to/foo.ts");
  });

  it("renders the matching placeholder for each non-ok status", () => {
    const term = makeTerminalElement();
    const popup = new HoverPreviewPopup();
    const cases: Array<{ result: FilePreviewResultMessage; expectedSubstring: string }> = [
      {
        result: { type: "filePreviewResult", path: "test/path", requestId: "r-x", status: "not-found" },
        expectedSubstring: "File not found",
      },
      {
        result: {
          type: "filePreviewResult",
          path: "test/path",
          requestId: "r-x",
          status: "binary",
          absPath: "/foo",
          totalBytes: 1024,
          languageId: "plaintext",
          isMarkdown: false,
        },
        expectedSubstring: "Binary file",
      },
      {
        result: {
          type: "filePreviewResult",
          path: "test/path",
          requestId: "r-x",
          status: "too-large",
          absPath: "/foo",
          totalBytes: 2_000_000,
          languageId: "plaintext",
          isMarkdown: false,
        },
        expectedSubstring: "File too large",
      },
      {
        result: { type: "filePreviewResult", path: "test/path", requestId: "r-x", status: "ambiguous" },
        expectedSubstring: "Multiple matches",
      },
      {
        result: { type: "filePreviewResult", path: "test/path", requestId: "r-x", status: "error" },
        expectedSubstring: "Could not load preview",
      },
    ];
    for (const { result, expectedSubstring } of cases) {
      popup.hide();
      popup.show(fakeMouseEvent(term, 50, 50), result, "dark");
      const placeholder = document.querySelector(".anywhere-hover-preview-placeholder");
      expect(placeholder?.textContent).toContain(expectedSubstring);
    }
  });

  it("clamps position when the anchor is near the right edge", () => {
    const term = makeTerminalElement(400, 300);
    const popup = new HoverPreviewPopup();
    popup.show(fakeMouseEvent(term, 380, 50), makeOkResult({ content: "x" }), "dark");

    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    // popupWidth = min(560, 384) = 384, terminalWidth = 400 → left = max(0, 400 - 384) = 16.
    expect(Number.parseInt(root.style.left, 10)).toBe(16);
  });

  it("flips above when the anchor is near the bottom edge", () => {
    const term = makeTerminalElement(400, 300);
    const popup = new HoverPreviewPopup();
    popup.show(fakeMouseEvent(term, 50, 280), makeOkResult({ content: "x" }), "dark");

    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    // anchorY=280, offsetHeight=0 in jsdom → fallback to maxPopupHeight = min(360, 284) = 284.
    // 280 + 12 + 284 > 300 → flip. flippedTop = 280 - 12 - 284 = -16 → clamp at max(0, 300-284) = 16.
    expect(Number.parseInt(root.style.top, 10)).toBeLessThan(280);
  });

  it("flip uses ACTUAL popup height when offsetHeight reports it (no overshoot for short content)", () => {
    // Regression: short placeholder content (e.g. "Multiple matches") used to
    // be positioned using maxPopupHeight (~360px), shoving the popup hundreds
    // of pixels above the anchor when the anchor was near the bottom.
    // Now offsetHeight is measured after mount and used for the flip math.
    const term = makeTerminalElement(400, 300);
    // Mock offsetHeight on every <div> so the next-created popup root reports 60px.
    const proto = HTMLDivElement.prototype as unknown as { __origOH?: PropertyDescriptor };
    proto.__origOH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 60 });
    try {
      const popup = new HoverPreviewPopup();
      popup.show(
        fakeMouseEvent(term, 50, 280),
        { type: "filePreviewResult", path: "p", requestId: "r", status: "ambiguous" },
        "dark",
      );
      const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
      // anchorY=280, actualHeight=60. 280 + 12 + 60 = 352 > 300 → flip.
      // flippedTop = 280 - 12 - 60 = 208 (>= 0) → top = 208, popup sits just above the link.
      expect(Number.parseInt(root.style.top, 10)).toBe(208);
      // Without the fix, top would clamp to 16 (way above) instead.
    } finally {
      if (proto.__origOH) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", proto.__origOH);
      }
    }
  });

  it("dispatches mousedown outside the popup triggers unmount + onDismiss", () => {
    const term = makeTerminalElement();
    const onDismiss = vi.fn();
    const popup = new HoverPreviewPopup({ onDismiss });
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");

    expect(document.querySelector(".anywhere-hover-preview")).toBeTruthy();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".anywhere-hover-preview")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("mousedown INSIDE the popup does NOT dismiss + stops propagation (controller listener won't fire)", () => {
    const term = makeTerminalElement();
    const onDismiss = vi.fn();
    const popup = new HoverPreviewPopup({ onDismiss });
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");

    const popupEl = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    expect(popupEl).toBeTruthy();
    // Install a spy on the terminal's bubble-phase mousedown — this mirrors
    // the controller's listener. With stopPropagation in the popup's capture
    // listener, this MUST NOT fire when the click target is inside the popup.
    const terminalListener = vi.fn();
    term.addEventListener("mousedown", terminalListener);

    // Dispatch a mousedown whose target is the popup's body (inside).
    const insideEvent = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(insideEvent, "target", { value: popupEl });
    window.dispatchEvent(insideEvent);

    // Popup stays visible.
    expect(document.querySelector(".anywhere-hover-preview")).toBeTruthy();
    expect(onDismiss).not.toHaveBeenCalled();
    // Controller's mousedown listener was prevented from firing.
    expect(terminalListener).not.toHaveBeenCalled();
  });

  it("popup.onDismiss callback is invoked on self-dismiss paths (mousedown outside / Escape)", () => {
    const term = makeTerminalElement();
    const onDismiss = vi.fn();
    // mousedown outside
    let popup = new HoverPreviewPopup({ onDismiss });
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ path: "p", content: "x" }), "dark");
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // Escape
    popup = new HoverPreviewPopup({ onDismiss });
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ path: "p", requestId: "r2", content: "x" }), "dark");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    // Wheel dismissal is owned by the controller (gated by cursorOverPopup);
    // see HoverPreviewController.test.ts for that path.
  });

  it("header falls back to result.path when absPath is absent (e.g. not-found)", () => {
    const term = makeTerminalElement();
    const popup = new HoverPreviewPopup();
    popup.show(
      fakeMouseEvent(term, 50, 50),
      {
        type: "filePreviewResult",
        path: "src/missing.ts",
        requestId: "r1",
        status: "not-found",
      } satisfies FilePreviewResultMessage,
      "dark",
    );
    const pathLabel = document.querySelector(".anywhere-hover-preview-header-path") as HTMLElement;
    expect(pathLabel.textContent).toBe("src/missing.ts");
    expect(pathLabel.getAttribute("title")).toBe("src/missing.ts");
  });

  it("Escape key triggers unmount + onDismiss", () => {
    const term = makeTerminalElement();
    const onDismiss = vi.fn();
    const popup = new HoverPreviewPopup({ onDismiss });
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".anywhere-hover-preview")).toBeNull();
    expect(onDismiss).toHaveBeenCalled();
  });

  // The popup no longer owns wheel-to-dismiss — that moved to the controller
  // so we can gate on `cursorOverPopup` and allow scrolling inside the popup.
  // See HoverPreviewController.test.ts for the controller-side wheel behavior.

  it("wheel inside the popup calls stopPropagation so it doesn't reach xterm viewport scroll", () => {
    const term = makeTerminalElement();
    const popup = new HoverPreviewPopup();
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "a\nb\nc" }), "dark");

    const popupEl = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    expect(popupEl).toBeTruthy();

    // Watch a bubble-phase listener on the terminal element — it would fire
    // if the wheel propagated past the popup. With the popup's stopPropagation
    // wheel handler, the terminal listener MUST NOT see the event.
    const terminalWheelListener = vi.fn();
    term.addEventListener("wheel", terminalWheelListener);

    popupEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    expect(terminalWheelListener).not.toHaveBeenCalled();
    // Popup must still be mounted.
    expect(document.querySelector(".anywhere-hover-preview")).toBeTruthy();
  });

  it("uses renderMarkdown for isMarkdown=true and renderCode otherwise", () => {
    const term = makeTerminalElement();
    const renderCode = vi.fn(() => {
      const el = document.createElement("pre");
      el.className = "code-rendered";
      return el;
    });
    const renderMarkdown = vi.fn(() => {
      const el = document.createElement("div");
      el.className = "md-rendered";
      return el;
    });
    const popup = new HoverPreviewPopup({ renderCode, renderMarkdown });

    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ isMarkdown: true, content: "# hi" }), "dark");
    expect(renderMarkdown).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".md-rendered")).toBeTruthy();

    popup.hide();
    popup.show(
      fakeMouseEvent(term, 50, 50),
      makeOkResult({ languageId: "typescript", content: "const x = 1;" }),
      "dark",
    );
    expect(renderCode).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".code-rendered")).toBeTruthy();
  });

  it("falls back to plain <pre> when no renderers are provided", () => {
    const term = makeTerminalElement();
    const popup = new HoverPreviewPopup();
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "hello\nworld" }), "dark");
    const pre = document.querySelector(".anywhere-hover-preview-plain") as HTMLElement | null;
    expect(pre?.tagName).toBe("PRE");
    // Plain text fallback wraps each line in `<span class="line">` so
    // scroll-to-line works without Shiki.
    expect(pre?.querySelectorAll(".line").length).toBe(2);
    expect(pre?.textContent).toContain("hello");
    expect(pre?.textContent).toContain("world");
  });

  it("body has anywhere-hover-preview-body-numbers class for the CSS-counter gutter (D)", () => {
    const term = makeTerminalElement();
    const popup = new HoverPreviewPopup();
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "a\nb" }), "dark");
    const body = document.querySelector(".anywhere-hover-preview-body") as HTMLElement | null;
    expect(body).toBeTruthy();
    expect(body?.classList.contains("anywhere-hover-preview-body-numbers")).toBe(true);
  });

  it("renders the footer with just the delay input when getSettings is provided (E)", () => {
    const term = makeTerminalElement();
    const onUpdate = vi.fn();
    const popup = new HoverPreviewPopup({
      getSettings: () => ({ delay: 300, blockSensitive: true }),
      onUpdateSetting: onUpdate,
    });
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "a" }), "dark");
    const footer = document.querySelector(".anywhere-hover-preview-footer") as HTMLElement | null;
    expect(footer).toBeTruthy();
    // Wrap/Auto toggles were removed — footer hosts only the delay input now.
    const checkboxes = footer?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes?.length).toBe(0);
    const numberInput = footer?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(numberInput?.value).toBe("300");
  });

  it("footer delay input clamps and posts a number update (E)", () => {
    const term = makeTerminalElement();
    const onUpdate = vi.fn();
    const popup = new HoverPreviewPopup({
      getSettings: () => ({ delay: 300, blockSensitive: true }),
      onUpdateSetting: onUpdate,
    });
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "a" }), "dark");
    const num = document.querySelector<HTMLInputElement>(".anywhere-hover-preview-footer-delay input");
    if (!num) {
      throw new Error("no delay input");
    }
    num.value = "500";
    num.dispatchEvent(new Event("change"));
    expect(onUpdate).toHaveBeenCalledWith("delay", 500);

    // Out-of-range value MUST NOT propagate.
    onUpdate.mockClear();
    num.value = "5000"; // > max 2000
    num.dispatchEvent(new Event("change"));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("does NOT render a footer when getSettings is omitted (E)", () => {
    const term = makeTerminalElement();
    const popup = new HoverPreviewPopup();
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "a" }), "dark");
    expect(document.querySelector(".anywhere-hover-preview-footer")).toBeNull();
  });

  it("highlights the target line when result.line is set (C)", () => {
    const term = makeTerminalElement();
    const popup = new HoverPreviewPopup();
    popup.show(
      fakeMouseEvent(term, 50, 50),
      makeOkResult({ content: "line1\nline2\nline3\nline4\nline5", line: 3 }),
      "dark",
    );
    const lines = document.querySelectorAll(".line");
    expect(lines).toHaveLength(5);
    expect(lines[2].classList.contains("anywhere-hover-preview-line-active")).toBe(true);
    // Other lines must NOT be highlighted.
    expect(lines[0].classList.contains("anywhere-hover-preview-line-active")).toBe(false);
    expect(lines[4].classList.contains("anywhere-hover-preview-line-active")).toBe(false);
  });

  it("ignores result.line when it's out of range or markdown", () => {
    const term = makeTerminalElement();
    const popup = new HoverPreviewPopup();
    // Out-of-range line — no element should be flagged.
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "line1\nline2", line: 999 }), "dark");
    expect(document.querySelector(".anywhere-hover-preview-line-active")).toBeNull();
  });

  it("popup size constants match the spec", () => {
    expect(DEFAULT_POPUP_WIDTH).toBe(640);
    expect(MAX_POPUP_WIDTH).toBe(1000);
    expect(MAX_POPUP_HEIGHT).toBe(360);
    expect(MIN_POPUP_WIDTH).toBe(280);
    expect(MIN_POPUP_HEIGHT).toBe(120);
  });

  it("renders the header Open button and fires onOpenFile with the result on click", () => {
    const term = makeTerminalElement();
    const onOpenFile = vi.fn();
    const popup = new HoverPreviewPopup({ onOpenFile });
    const result = makeOkResult({ absPath: "/a/b/foo.ts", content: "x", line: 7 });
    popup.show(fakeMouseEvent(term, 50, 50), result, "dark");

    const btn = document.querySelector(".anywhere-hover-preview-open-btn") as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    expect(btn?.getAttribute("aria-label")).toBe("Open file");
    expect(btn?.title).toBe("Open file");

    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile.mock.calls[0][0]).toBe(result);
    // Popup unmounts itself after click so the user sees the editor instead.
    expect(document.querySelector(".anywhere-hover-preview")).toBeNull();
  });

  it("hides the Open button for not-found / error statuses", () => {
    const term = makeTerminalElement();
    const onOpenFile = vi.fn();
    const popup = new HoverPreviewPopup({ onOpenFile });
    popup.show(
      fakeMouseEvent(term, 50, 50),
      {
        type: "filePreviewResult",
        path: "src/missing.ts",
        requestId: "r1",
        status: "not-found",
      } satisfies FilePreviewResultMessage,
      "dark",
    );
    expect(document.querySelector(".anywhere-hover-preview-open-btn")).toBeNull();
  });

  it("does not render the Open button when onOpenFile is not wired", () => {
    const term = makeTerminalElement();
    const popup = new HoverPreviewPopup();
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");
    expect(document.querySelector(".anywhere-hover-preview-open-btn")).toBeNull();
  });

  it("mousedown on the Open button is swallowed so the outside-click dismiss listener does not fire", () => {
    const term = makeTerminalElement();
    const onDismiss = vi.fn();
    const popup = new HoverPreviewPopup({ onOpenFile: vi.fn(), onDismiss });
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");
    const btn = document.querySelector(".anywhere-hover-preview-open-btn") as HTMLButtonElement | null;
    btn?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("HoverPreviewPopup — drag / resize (live popup, no persistence)", () => {
  // Track every popup so afterEach can dispose() it — that removes the
  // window `mousedown` / document `keydown` listeners attached on show(),
  // preventing cross-test listener leakage in the full-suite run.
  const popups: HoverPreviewPopup[] = [];
  function track(popup: HoverPreviewPopup): HoverPreviewPopup {
    popups.push(popup);
    return popup;
  }
  afterEach(() => {
    for (const p of popups.splice(0)) {
      p.dispose();
    }
  });

  // Gestures use Pointer Events with setPointerCapture; pointermove/up are
  // delivered to the captured handle element (header for move, grip for resize),
  // so tests dispatch them on that same element.
  function pointerDownOn(handle: HTMLElement, clientX: number, clientY: number): void {
    handle.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX, clientY }),
    );
  }
  function pointerMoveOn(handle: HTMLElement, clientX: number, clientY: number): void {
    handle.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX, clientY }));
  }
  function pointerUpOn(handle: HTMLElement): void {
    handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
  }

  it("opens at DEFAULT_POPUP_WIDTH, cursor-anchored, with no explicit height", () => {
    const term = makeTerminalElement(800, 600);
    const popup = track(new HoverPreviewPopup());
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");
    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    expect(root.style.width).toBe(`${DEFAULT_POPUP_WIDTH}px`);
    // Anchored next to the cursor (computePosition path).
    expect(root.style.left).toBe("50px");
    expect(root.style.top).toBe("62px");
    // No explicit height until the user resizes the live popup.
    expect(root.style.height).toBe("");
  });

  it("clamps the default width down to a narrow terminal", () => {
    const term = makeTerminalElement(400, 600);
    const popup = track(new HoverPreviewPopup());
    popup.show(fakeMouseEvent(term, 10, 10), makeOkResult({ content: "x" }), "dark");
    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    // maxWidth = min(MAX_POPUP_WIDTH, clientWidth - 16) = min(1000, 384) = 384.
    expect(root.style.width).toBe("384px");
  });

  it("moves the live popup when dragging the header", () => {
    const term = makeTerminalElement(800, 600);
    const popup = track(new HoverPreviewPopup());
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");
    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    const header = document.querySelector(".anywhere-hover-preview-header") as HTMLElement;
    // start at (100,100); move +30,+40 → left 50→80, top 62→102 (height 0 in jsdom).
    pointerDownOn(header, 100, 100);
    pointerMoveOn(header, 130, 140);
    pointerUpOn(header);
    expect(root.style.left).toBe("80px");
    expect(root.style.top).toBe("102px");
  });

  it("resizes the live popup when dragging the SE grip", () => {
    const term = makeTerminalElement(800, 600);
    const popup = track(new HoverPreviewPopup());
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");
    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    const grip = document.querySelector(".anywhere-hover-preview-resize-grip") as HTMLElement;
    // width 640→690 (+50); height floored to MIN (offsetHeight is 0 in jsdom).
    pointerDownOn(grip, 200, 200);
    pointerMoveOn(grip, 250, 260);
    pointerUpOn(grip);
    expect(root.style.width).toBe("690px");
    expect(root.style.height).toBe(`${MIN_POPUP_HEIGHT}px`);
  });

  it("forgets the dragged/resized geometry on the next show (each hover refreshes)", () => {
    const term = makeTerminalElement(800, 600);
    const popup = track(new HoverPreviewPopup());
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");
    let root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    const header = document.querySelector(".anywhere-hover-preview-header") as HTMLElement;
    const grip = document.querySelector(".anywhere-hover-preview-resize-grip") as HTMLElement;
    // Move + resize the live popup away from the defaults.
    pointerDownOn(header, 100, 100);
    pointerMoveOn(header, 200, 180);
    pointerUpOn(header);
    pointerDownOn(grip, 200, 200);
    pointerMoveOn(grip, 280, 300);
    pointerUpOn(grip);
    expect(root.style.left).not.toBe("50px");
    expect(root.style.width).not.toBe(`${DEFAULT_POPUP_WIDTH}px`);

    // A fresh hover re-creates the popup at the default geometry + anchor —
    // nothing is remembered between hovers.
    popup.hide();
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");
    root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    expect(root.style.width).toBe(`${DEFAULT_POPUP_WIDTH}px`);
    expect(root.style.left).toBe("50px");
    expect(root.style.top).toBe("62px");
    expect(root.style.height).toBe("");
  });

  it("suppresses leave-dismiss while a drag gesture is in flight", () => {
    const term = makeTerminalElement(800, 600);
    const onPointerLeave = vi.fn();
    const popup = track(new HoverPreviewPopup({ onPointerLeave }));
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");
    const root = document.querySelector(".anywhere-hover-preview") as HTMLElement;
    const header = document.querySelector(".anywhere-hover-preview-header") as HTMLElement;

    pointerDownOn(header, 100, 100);
    // Cursor crosses the popup edge mid-drag → must NOT trigger leave-dismiss.
    root.dispatchEvent(new MouseEvent("mouseleave", {}));
    expect(onPointerLeave).not.toHaveBeenCalled();

    pointerUpOn(header); // gesture ends → interacting cleared
    // A genuine leave AFTER the gesture is delivered normally.
    root.dispatchEvent(new MouseEvent("mouseleave", {}));
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
  });

  it("tears down gesture listeners on unmount (move after hide is a no-op)", () => {
    const term = makeTerminalElement(800, 600);
    const popup = track(new HoverPreviewPopup());
    popup.show(fakeMouseEvent(term, 50, 50), makeOkResult({ content: "x" }), "dark");
    const header = document.querySelector(".anywhere-hover-preview-header") as HTMLElement;
    pointerDownOn(header, 100, 100);
    // Hiding mid-gesture must release capture + drop the pointermove/up listeners.
    popup.hide();
    // Late events on the detached handle must not throw or resurrect the popup.
    expect(() => {
      pointerMoveOn(header, 300, 300);
      pointerUpOn(header);
    }).not.toThrow();
    expect(document.querySelector(".anywhere-hover-preview")).toBeNull();
  });
});
