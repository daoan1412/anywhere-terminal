import { describe, expect, it, vi } from "vitest";
import {
  extractImageBlobFromClipboardItems,
  forwardImagePaste,
  ImagePasteDeduper,
  isPasteShortcut,
} from "./imagePasteBridge";
import { CTRL_V_PASTE } from "../shared/imagePasteTrigger";

describe("extractImageBlobFromClipboardItems", () => {
  it("returns the first image/* item as a File", () => {
    const file = new File([new Uint8Array([1, 2])], "a.png", { type: "image/png" });
    const items = {
      length: 2,
      0: { type: "text/plain", getAsFile: () => null },
      1: { type: "image/png", getAsFile: () => file },
    } as unknown as DataTransferItemList;

    expect(extractImageBlobFromClipboardItems(items)).toBe(file);
  });

  it("returns null when no image item exists", () => {
    const items = {
      length: 1,
      0: { type: "text/plain", getAsFile: () => null },
    } as unknown as DataTransferItemList;

    expect(extractImageBlobFromClipboardItems(items)).toBeNull();
  });
});

describe("isPasteShortcut", () => {
  it("detects Ctrl+V on Linux", () => {
    const event = {
      type: "keydown",
      key: "v",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    } as KeyboardEvent;
    expect(isPasteShortcut(event, false)).toBe(true);
  });

  it("detects Cmd+V on macOS", () => {
    const event = {
      type: "keydown",
      key: "v",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
    } as KeyboardEvent;
    expect(isPasteShortcut(event, true)).toBe(true);
  });

  it("rejects Shift+Ctrl+V", () => {
    const event = {
      type: "keydown",
      key: "v",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    } as KeyboardEvent;
    expect(isPasteShortcut(event, false)).toBe(false);
  });
});

describe("forwardImagePaste", () => {
  it("posts pasteClipboardImage with base64 payload and Linux trigger", async () => {
    const postMessage = vi.fn();
    const blob = new File([new Uint8Array([0x89, 0x50])], "shot.png", { type: "image/png" });

    await forwardImagePaste(blob, "pane-1", false, postMessage);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const msg = postMessage.mock.calls[0][0];
    expect(msg.type).toBe("pasteClipboardImage");
    expect(msg.tabId).toBe("pane-1");
    expect(msg.mimeType).toBe("image/png");
    expect(msg.trigger).toBe(CTRL_V_PASTE);
    expect(typeof msg.data).toBe("string");
    expect(msg.data.length).toBeGreaterThan(0);
  });
});

describe("ImagePasteDeduper", () => {
  it("tracks handled state across reset", () => {
    const deduper = new ImagePasteDeduper();
    expect(deduper.wasHandled()).toBe(false);
    deduper.markHandled();
    expect(deduper.wasHandled()).toBe(true);
    deduper.reset();
    expect(deduper.wasHandled()).toBe(false);
  });
});