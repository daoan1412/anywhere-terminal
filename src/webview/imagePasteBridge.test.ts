import { describe, expect, it, vi } from "vitest";
import {
  base64ToBlob,
  blobToBase64,
  ensurePngBlob,
  extractImageBlobFromClipboardItems,
  forwardImagePaste,
  ImagePasteDeduper,
  isPasteShortcut,
} from "./imagePasteBridge";

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

  it("detects Ctrl+V on macOS (OpenCode/Codex paste; no native paste event)", () => {
    const event = {
      type: "keydown",
      key: "v",
      ctrlKey: true,
      metaKey: false,
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
  it("posts pasteClipboardImage with a base64 payload (host resolves the trigger)", async () => {
    const postMessage = vi.fn();
    const blob = new File([new Uint8Array([0x89, 0x50])], "shot.png", { type: "image/png" });

    await forwardImagePaste(blob, "pane-1", postMessage);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const msg = postMessage.mock.calls[0][0];
    expect(msg.type).toBe("pasteClipboardImage");
    expect(msg.tabId).toBe("pane-1");
    expect(msg.mimeType).toBe("image/png");
    expect(msg).not.toHaveProperty("trigger");
    expect(typeof msg.data).toBe("string");
    expect(msg.data.length).toBeGreaterThan(0);
  });
});

describe("ensurePngBlob", () => {
  it("returns a PNG blob unchanged (no re-encode)", async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    expect(await ensurePngBlob(png)).toBe(png);
  });

  it("falls back to the original blob when canvas APIs are unavailable / fail", async () => {
    // The test env lacks createImageBitmap/OffscreenCanvas; a real webview
    // re-encodes, but here the guarded fallback must return the input untouched.
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
    expect(await ensurePngBlob(jpeg)).toBe(jpeg);
  });
});

describe("base64ToBlob", () => {
  it("round-trips bytes with blobToBase64 and preserves the mime type", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const b64 = await blobToBase64(new Blob([bytes]));
    const blob = base64ToBlob(b64, "image/png");
    expect(blob?.type).toBe("image/png");
    const out = new Uint8Array(await (blob as Blob).arrayBuffer());
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });

  it("defaults the mime type to image/png", () => {
    expect(base64ToBlob("", "")?.type).toBe("image/png");
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