import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PastedImageStore } from "./PastedImageStore";

// jsdom doesn't implement object-URL APIs — stub them. createObjectURL returns
// a deterministic URL per call so tests can assert which URL was revoked.
let urlCounter = 0;
let createSpy: ReturnType<typeof vi.fn>;
let revokeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  urlCounter = 0;
  createSpy = vi.fn(() => `blob:mock/${++urlCounter}`);
  revokeSpy = vi.fn();
  globalThis.URL.createObjectURL = createSpy as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = revokeSpy as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function pngBlob(size: number): Blob {
  return new Blob([new Uint8Array(size)], { type: "image/png" });
}

describe("PastedImageStore.add", () => {
  it("assigns 1-based paste-order indices and a blob: URL with blob metadata", () => {
    const store = new PastedImageStore();
    const a = store.add(pngBlob(10));
    const b = store.add(pngBlob(20));
    expect(a.index).toBe(1);
    expect(b.index).toBe(2);
    expect(a.url).toBe("blob:mock/1");
    expect(b.url).toBe("blob:mock/2");
    expect(a.byteSize).toBe(10);
    expect(b.mimeType).toBe("image/png");
  });
});

describe("PastedImageStore.resolveRecent (D3 — recency-anchored)", () => {
  it("returns null when the cache is empty", () => {
    expect(new PastedImageStore().resolveRecent(0, 1)).toBeNull();
  });

  it("returns the sole image", () => {
    const store = new PastedImageStore();
    const only = store.add(pngBlob(10));
    expect(store.resolveRecent(0, 1)).toBe(only);
  });

  it("maps a single placeholder to the MOST-RECENT image, not position 1", () => {
    // Regression: copy img1 → paste (submit) → copy img2 → paste. The CLI shows
    // `[Image #1]` again (counter reset), but the store is cumulative. The new
    // prompt's lone placeholder must resolve to img2 (newest), not img1.
    const store = new PastedImageStore();
    store.add(pngBlob(1)); // img1, pasted in a prior prompt
    const img2 = store.add(pngBlob(2)); // img2, pasted in the current prompt
    // batchSize 1 = the current row shows one placeholder; rank 0 = its first.
    expect(store.resolveRecent(0, 1)).toBe(img2);
  });

  it("maps a multi-image batch onto the most-recent images in order", () => {
    const store = new PastedImageStore();
    store.add(pngBlob(1)); // stale, from a prior prompt
    const img2 = store.add(pngBlob(2)); // current prompt #1
    const img3 = store.add(pngBlob(3)); // current prompt #2
    // Current row shows two placeholders (batchSize 2).
    expect(store.resolveRecent(0, 2)).toBe(img2); // lower number → older of batch
    expect(store.resolveRecent(1, 2)).toBe(img3); // higher number → newest
  });

  it("falls back to the most-recent image when rank exceeds the cache", () => {
    const store = new PastedImageStore();
    store.add(pngBlob(1));
    const last = store.add(pngBlob(2));
    // batchSize larger than the cache (e.g. a paste wasn't captured): clamp.
    expect(store.resolveRecent(5, 9)).toBe(last);
    expect(store.resolveRecent(-1, 0)).toBe(last);
  });
});

describe("PastedImageStore.dispose", () => {
  it("revokes every created object URL and clears the cache", () => {
    const store = new PastedImageStore();
    store.add(pngBlob(1));
    store.add(pngBlob(2));
    store.dispose();
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock/1");
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock/2");
    expect(revokeSpy).toHaveBeenCalledTimes(2);
    expect(store.resolveRecent(0, 1)).toBeNull();
  });

  it("is idempotent — a second dispose revokes nothing more", () => {
    const store = new PastedImageStore();
    store.add(pngBlob(1));
    store.dispose();
    store.dispose();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });
});
