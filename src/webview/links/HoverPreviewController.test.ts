// @vitest-environment jsdom
// src/webview/links/HoverPreviewController.test.ts — fake-timer driven coverage
// for the 300ms debounce + requestId tracking + stale-response drop + dispose.

import type { ILink, Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePreviewResultMessage } from "../../types/messages";
import { HOVER_DEBOUNCE_MS, HoverPreviewController, type HoverPreviewPopupHost } from "./HoverPreviewController";
import type { PastedImagePreview } from "./PastedImageStore";

function makeLink(text: string, x = 1, y = 1): ILink {
  return {
    text,
    range: { start: { x, y }, end: { x: x + text.length - 1, y } },
    activate: () => {},
  } as unknown as ILink;
}

/**
 * Build a complete `status: "ok"` FilePreviewResultMessage from a partial.
 * Round-1 W1 made the union discriminate on `status`; this helper supplies
 * the required `ok`-variant fields so tests stay terse.
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

/**
 * Build a `status: "requires-confirmation"` result with the given requestId.
 * Required for B1 override-gating tests: the controller only honors a Cmd/Ctrl
 * keypress as an override gesture when this result has been received first.
 */
function makeRequiresConfirmationResult(
  requestId: string,
  partial: Partial<Extract<FilePreviewResultMessage, { status: "requires-confirmation" }>> = {},
): Extract<FilePreviewResultMessage, { status: "requires-confirmation" }> {
  return {
    type: "filePreviewResult",
    path: "test/path",
    requestId,
    status: "requires-confirmation",
    reason: "dotfile",
    absPath: "/abs/test/path",
    ...partial,
  };
}

function makeFakeTerminal(): { terminal: { element: HTMLElement }; element: HTMLElement } {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return { terminal: { element } as { element: HTMLElement }, element };
}

function makePopup(): HoverPreviewPopupHost & {
  showCalls: Array<{ result: FilePreviewResultMessage; theme: string }>;
  showImageCalls: Array<{ image: PastedImagePreview }>;
  hideCalls: number;
  disposeCalls: number;
} {
  const showCalls: Array<{ result: FilePreviewResultMessage; theme: string }> = [];
  const showImageCalls: Array<{ image: PastedImagePreview }> = [];
  let hideCalls = 0;
  let disposeCalls = 0;
  return {
    show: (_anchor, result, theme) => {
      showCalls.push({ result, theme });
    },
    showImage: (_anchor, image) => {
      showImageCalls.push({ image });
    },
    hide: () => {
      hideCalls++;
    },
    dispose: () => {
      disposeCalls++;
    },
    get showCalls() {
      return showCalls;
    },
    get showImageCalls() {
      return showImageCalls;
    },
    get hideCalls() {
      return hideCalls;
    },
    get disposeCalls() {
      return disposeCalls;
    },
  } as HoverPreviewPopupHost & {
    showCalls: Array<{ result: FilePreviewResultMessage; theme: string }>;
    showImageCalls: Array<{ image: PastedImagePreview }>;
    hideCalls: number;
    disposeCalls: number;
  };
}

function makeMouseEvent(): MouseEvent {
  return new MouseEvent("mouseover", { clientX: 10, clientY: 20, bubbles: true });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("HoverPreviewController.attachImageHover (preview-pasted-images)", () => {
  function setup(resolve: () => PastedImagePreview | null) {
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });
    const link = makeLink("[Image #1]");
    controller.attachImageHover(link, resolve);
    return { popup, postMessage, link };
  }

  const image: PastedImagePreview = { url: "blob:mock/1", mimeType: "image/png", byteSize: 10, index: 1 };

  it("shows the resolved image after the debounce and never posts a message", () => {
    const { popup, postMessage, link } = setup(() => image);
    link.hover?.(makeMouseEvent(), "[Image #1]");
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    expect(popup.showImageCalls).toHaveLength(1);
    expect(popup.showImageCalls[0].image).toBe(image);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("shows nothing when the resolver returns null", () => {
    const { popup, link } = setup(() => null);
    link.hover?.(makeMouseEvent(), "[Image #1]");
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    expect(popup.showImageCalls).toHaveLength(0);
  });

  it("does not fire if the cursor leaves before the debounce elapses", () => {
    const { popup, link } = setup(() => image);
    link.hover?.(makeMouseEvent(), "[Image #1]");
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS - 50);
    link.leave?.(makeMouseEvent(), "[Image #1]");
    vi.advanceTimersByTime(200);
    expect(popup.showImageCalls).toHaveLength(0);
  });

  // Round-1 B1: an image hover must clear stale file-preview gating state so a
  // requires-confirmation file popup can't be overridden via Cmd/Ctrl while the
  // image popup is showing, and a late file response can't render over it.
  it("clears stale file requires-confirmation state — Cmd/Ctrl over an image popup issues no file override", () => {
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });

    // 1. File hover → request in flight → host returns requires-confirmation.
    const fileLink = makeLink("/abs/file.ts", 1, 1);
    controller.attachHover(fileLink, "/abs/file.ts");
    fileLink.hover?.(makeMouseEvent(), "/abs/file.ts");
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    const reqId = (postMessage.mock.calls[0][0] as { requestId: string }).requestId;
    controller.onMessage(makeRequiresConfirmationResult(reqId));
    const callsAfterFile = postMessage.mock.calls.length;

    // 2. Move to an image placeholder hover.
    const imageLink = makeLink("[Image #1]", 1, 2);
    controller.attachImageHover(imageLink, () => image);
    imageLink.hover?.(makeMouseEvent(), "[Image #1]");
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    expect(popup.showImageCalls).toHaveLength(1);

    // 3. Pressing the platform modifier must NOT issue a file-preview override.
    const key = /Mac|iPhone|iPod|iPad/i.test(navigator.platform) ? "Meta" : "Control";
    document.dispatchEvent(new KeyboardEvent("keydown", { key }));
    expect(postMessage.mock.calls.length).toBe(callsAfterFile);
  });
});

describe("HoverPreviewController", () => {
  it("posts requestFilePreview exactly once after 300ms of continuous hover", () => {
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("src/foo.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);

    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS - 1);
    expect(postMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const sent = postMessage.mock.calls[0][0];
    expect(sent.type).toBe("requestFilePreview");
    expect(sent.sessionId).toBe("s1");
    expect(sent.path).toBe("src/foo.ts");
    expect(typeof sent.requestId).toBe("string");
  });

  it("does NOT post when hover is followed by leave before the debounce fires", () => {
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup: makePopup(),
    });

    const link = makeLink("src/foo.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS - 50);
    link.leave?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(100);

    expect(postMessage).not.toHaveBeenCalled();
  });

  it("supersedes a pending request when hover moves to a different link", () => {
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup: makePopup(),
    });

    const linkA = makeLink("a.ts", 1, 1);
    const linkB = makeLink("b.ts", 10, 1);
    controller.attachHover(linkA);
    controller.attachHover(linkB);

    linkA.hover?.(makeMouseEvent(), linkA.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS - 50);
    linkB.hover?.(makeMouseEvent(), linkB.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].path).toBe("b.ts");
  });

  it("drops a stale filePreviewResult whose requestId doesn't match", () => {
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("a.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    const liveId = postMessage.mock.calls[0][0].requestId;

    // Late response for a DIFFERENT request — must be dropped.
    controller.onMessage(makeOkResult({ requestId: "stale-id", absPath: "/x/a.ts" }));
    expect(popup.showCalls).toHaveLength(0);

    // Matching response — must be shown.
    controller.onMessage(makeOkResult({ requestId: liveId, absPath: "/x/a.ts" }));
    expect(popup.showCalls).toHaveLength(1);
    expect(popup.showCalls[0].result.requestId).toBe(liveId);
    expect(popup.showCalls[0].theme).toBe("dark");
  });

  it("silently ignores not-found results and dismisses any existing popup", () => {
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });

    const liveLink = makeLink("a.ts", 1, 1);
    controller.attachHover(liveLink, "a.ts");
    liveLink.hover?.(makeMouseEvent(), liveLink.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    const liveId = postMessage.mock.calls[0][0].requestId;
    controller.onMessage(makeOkResult({ requestId: liveId, absPath: "/x/a.ts" }));
    expect(popup.showCalls).toHaveLength(1);

    const missingLink = makeLink("missing.ts", 1, 2);
    controller.attachHover(missingLink, "missing.ts");
    missingLink.hover?.(makeMouseEvent(), missingLink.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    const missingId = postMessage.mock.calls[1][0].requestId;
    controller.onMessage({
      type: "filePreviewResult",
      path: "missing.ts",
      requestId: missingId,
      status: "not-found",
    });

    expect(popup.showCalls).toHaveLength(1);
    expect(popup.hideCalls).toBeGreaterThanOrEqual(1);
  });

  it("hides the popup on leave", () => {
    const { terminal } = makeFakeTerminal();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage: vi.fn(),
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("a.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    controller.onMessage(
      makeOkResult({ requestId: (controller as unknown as { activeRequestId: string }).activeRequestId }),
    );
    expect(popup.showCalls).toHaveLength(1);

    // leave starts the grace timer rather than dismissing immediately —
    // advance past the grace period to verify the eventual dismissal.
    link.leave?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(300);
    expect(popup.hideCalls).toBeGreaterThanOrEqual(1);
  });

  it("dismisses on mousedown anywhere in the terminal", () => {
    const { terminal, element } = makeFakeTerminal();
    const postMessage = vi.fn();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("a.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);

    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(popup.hideCalls).toBeGreaterThanOrEqual(1);
  });

  it("dismisses on Escape keydown", () => {
    const { terminal } = makeFakeTerminal();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage: vi.fn(),
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("a.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(popup.hideCalls).toBeGreaterThanOrEqual(1);
  });

  it("dispose() drops late responses, removes listeners, and disposes the popup", () => {
    const { terminal } = makeFakeTerminal();
    const popup = makePopup();
    const postMessage = vi.fn();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("a.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    const liveId = postMessage.mock.calls[0][0].requestId;

    controller.dispose();
    // Matching id arrives after dispose — must be ignored.
    controller.onMessage(makeOkResult({ requestId: liveId }));
    expect(popup.showCalls).toHaveLength(0);
    expect(popup.disposeCalls).toBe(1);
  });

  it("link.leave delays dismissal — cursor moving INTO the popup keeps it visible (grace period)", () => {
    const { terminal } = makeFakeTerminal();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage: vi.fn(),
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("a.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    controller.onMessage(
      makeOkResult({ requestId: (controller as unknown as { activeRequestId: string }).activeRequestId }),
    );
    expect(popup.showCalls).toHaveLength(1);

    // Cursor leaves the link's character range — popup should NOT dismiss yet.
    link.leave?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(50); // < grace period
    expect(popup.hideCalls).toBe(0);

    // Cursor enters the popup before the grace timer fires.
    controller.onPopupEnter();
    vi.advanceTimersByTime(500); // past grace period
    expect(popup.hideCalls).toBe(0); // still visible — cursor is over popup
  });

  it("cursor leaving the popup starts a fresh grace timer that dismisses", () => {
    const { terminal } = makeFakeTerminal();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage: vi.fn(),
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("a.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    controller.onMessage(
      makeOkResult({ requestId: (controller as unknown as { activeRequestId: string }).activeRequestId }),
    );

    // Mouse moves from link → popup → off entirely.
    link.leave?.(makeMouseEvent(), link.text);
    controller.onPopupEnter();
    vi.advanceTimersByTime(200);
    expect(popup.hideCalls).toBe(0);

    controller.onPopupLeave();
    vi.advanceTimersByTime(200); // grace expires
    expect(popup.hideCalls).toBeGreaterThanOrEqual(1);
  });

  it("wheel inside the popup does NOT dismiss (cursorOverPopup gate)", () => {
    const { terminal, element } = makeFakeTerminal();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage: vi.fn(),
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("a.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    controller.onMessage(
      makeOkResult({ requestId: (controller as unknown as { activeRequestId: string }).activeRequestId }),
    );

    // Cursor enters popup → controller knows cursorOverPopup = true.
    controller.onPopupEnter();
    // Wheel fires on the terminal element (the popup is its child — events bubble).
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    expect(popup.hideCalls).toBe(0);
  });

  it("wheel OUTSIDE the popup dismisses (terminal scrollback area)", () => {
    const { terminal, element } = makeFakeTerminal();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage: vi.fn(),
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("a.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    controller.onMessage(
      makeOkResult({ requestId: (controller as unknown as { activeRequestId: string }).activeRequestId }),
    );

    // Cursor is NOT over the popup — wheel dismisses.
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    expect(popup.hideCalls).toBeGreaterThanOrEqual(1);
  });

  it("link.leave still dismisses when cursor never reaches the popup", () => {
    const { terminal } = makeFakeTerminal();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage: vi.fn(),
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("a.ts");
    controller.attachHover(link);
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    controller.onMessage(
      makeOkResult({ requestId: (controller as unknown as { activeRequestId: string }).activeRequestId }),
    );

    // Cursor leaves link, doesn't reach popup → after grace, dismiss fires.
    link.leave?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(300);
    expect(popup.hideCalls).toBeGreaterThanOrEqual(1);
  });

  it("Cmd/Ctrl keydown during a hover re-issues the request with override=true (B1)", () => {
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink(".env");
    controller.attachHover(link, ".env");
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    // Initial request — no override flag.
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].override).toBeUndefined();

    // Host returns `requires-confirmation` — this is the ONLY state in which
    // Cmd/Ctrl is interpreted as an override gesture (round-2 B1 fix).
    const reqId = (controller as unknown as { activeRequestId: string }).activeRequestId;
    controller.onMessage(makeRequiresConfirmationResult(reqId, { path: ".env" }));

    // User presses Control — controller should re-post with override.
    // The B1 gate accepts ONLY `event.key === "Control"` (fresh modifier press),
    // NOT `ctrlKey` flag (which would also fire for unrelated Ctrl+chords).
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    expect(postMessage).toHaveBeenCalledTimes(2);
    const override = postMessage.mock.calls[1][0];
    expect(override.override).toBe(true);
    expect(override.path).toBe(".env");
    // The override request must use a NEW requestId so any in-flight result is dropped as stale.
    expect(override.requestId).not.toBe(postMessage.mock.calls[0][0].requestId);
  });

  it("Cmd/Ctrl keydown is IGNORED when no requires-confirmation result is showing (B1 round-2)", () => {
    // Hover an in-workspace path → host returns `ok` (no requires-confirmation).
    // Pressing Cmd/Ctrl must NOT trigger an override re-post; otherwise an
    // incidental modifier press during a benign hover could leak content.
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink("src/foo.ts");
    controller.attachHover(link, "src/foo.ts");
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    expect(postMessage).toHaveBeenCalledTimes(1);

    const reqId = (controller as unknown as { activeRequestId: string }).activeRequestId;
    controller.onMessage(makeOkResult({ requestId: reqId }));

    // Press Control: must be IGNORED because the popup is showing an `ok` result.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("modifier held during an unrelated key chord does NOT trigger override (B1 round-2)", () => {
    // Cmd+C / Ctrl+R etc. emit a keydown with `metaKey`/`ctrlKey: true` and
    // `key: "c"`/`"r"`. The pre-B1 gate matched on the modifier flag, which
    // meant any chord during a `requires-confirmation` popup leaked content.
    // The new gate requires `event.key === "Meta"|"Control"` exactly.
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink(".env");
    controller.attachHover(link, ".env");
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    const reqId = (controller as unknown as { activeRequestId: string }).activeRequestId;
    controller.onMessage(makeRequiresConfirmationResult(reqId, { path: ".env" }));
    expect(postMessage).toHaveBeenCalledTimes(1);

    // Cmd+C / Ctrl+C chord — modifier is held but the key is not the modifier itself.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: true }));
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("override is one-shot per hover — re-pressing Cmd/Ctrl does not re-post", () => {
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });

    const link = makeLink(".env");
    controller.attachHover(link, ".env");
    link.hover?.(makeMouseEvent(), link.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    const reqId = (controller as unknown as { activeRequestId: string }).activeRequestId;
    controller.onMessage(makeRequiresConfirmationResult(reqId, { path: ".env" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    expect(postMessage).toHaveBeenCalledTimes(2);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    // No additional posts.
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("override budget resets on new hover (different link)", () => {
    const { terminal } = makeFakeTerminal();
    const postMessage = vi.fn();
    const popup = makePopup();
    const controller = new HoverPreviewController({
      terminal: terminal as unknown as import("@xterm/xterm").Terminal,
      sessionId: "s1",
      postMessage,
      getTheme: () => "dark",
      popup,
    });

    const link1 = makeLink(".env", 1, 1);
    controller.attachHover(link1, ".env");
    link1.hover?.(makeMouseEvent(), link1.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    const reqId1 = (controller as unknown as { activeRequestId: string }).activeRequestId;
    controller.onMessage(makeRequiresConfirmationResult(reqId1, { path: ".env" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    expect(postMessage).toHaveBeenCalledTimes(2); // initial + override

    // Move to a different link — override budget MUST reset.
    const link2 = makeLink(".config", 1, 5);
    controller.attachHover(link2, ".config");
    link2.hover?.(makeMouseEvent(), link2.text);
    vi.advanceTimersByTime(HOVER_DEBOUNCE_MS);
    expect(postMessage).toHaveBeenCalledTimes(3); // new debounced request for link2

    // Host must return requires-confirmation again before override is allowed.
    const reqId2 = (controller as unknown as { activeRequestId: string }).activeRequestId;
    controller.onMessage(makeRequiresConfirmationResult(reqId2, { path: ".config" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    expect(postMessage).toHaveBeenCalledTimes(4); // override fires again for the new hover
    expect(postMessage.mock.calls[3][0].override).toBe(true);
    expect(postMessage.mock.calls[3][0].path).toBe(".config");
  });
});
