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

describe("PastedImageStore.resolve (D3 rule)", () => {
  it("returns null when the cache is empty", () => {
    expect(new PastedImageStore().resolve(1)).toBeNull();
  });

  it("returns the sole image regardless of N", () => {
    const store = new PastedImageStore();
    const only = store.add(pngBlob(10));
    expect(store.resolve(1)).toBe(only);
    expect(store.resolve(7)).toBe(only);
    expect(store.resolve(0)).toBe(only);
  });

  it("returns the image at paste position N when multiple are cached", () => {
    const store = new PastedImageStore();
    const first = store.add(pngBlob(1));
    const second = store.add(pngBlob(2));
    const third = store.add(pngBlob(3));
    expect(store.resolve(1)).toBe(first);
    expect(store.resolve(2)).toBe(second);
    expect(store.resolve(3)).toBe(third);
  });

  it("falls back to the most-recent image when N is out of range", () => {
    const store = new PastedImageStore();
    store.add(pngBlob(1));
    const last = store.add(pngBlob(2));
    expect(store.resolve(99)).toBe(last);
    expect(store.resolve(0)).toBe(last);
    expect(store.resolve(Number.NaN)).toBe(last);
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
    expect(store.resolve(1)).toBeNull();
  });

  it("is idempotent — a second dispose revokes nothing more", () => {
    const store = new PastedImageStore();
    store.add(pngBlob(1));
    store.dispose();
    store.dispose();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });
});
