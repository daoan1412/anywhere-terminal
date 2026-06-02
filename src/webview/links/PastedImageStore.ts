// src/webview/links/PastedImageStore.ts — Per-terminal cache of images pasted
// into this terminal. The bytes never traverse the PTY (the CLI reads the OS
// clipboard out of band); we capture them from the webview paste event and keep
// them here so a `[Image #N]` placeholder can be previewed on hover.
//
// See: asimov/changes/preview-pasted-images/design.md D2, D3

/** A single cached pasted image. `url` is a `blob:` object URL. */
export interface PastedImagePreview {
  /** Object URL (blob:) rendered directly as `<img src>`; revoked on dispose. */
  url: string;
  mimeType: string;
  byteSize: number;
  /** 1-based position in paste order within this terminal. */
  index: number;
}

/**
 * One per terminal. Owns the object URLs it creates and revokes them all on
 * dispose — disposal must fire on every terminal teardown path (tab + split
 * close), not only the root close.
 */
export class PastedImageStore {
  private readonly images: PastedImagePreview[] = [];
  private disposed = false;

  /** Capture a pasted image; assigns the next 1-based index + a blob: URL. */
  add(blob: Blob): PastedImagePreview {
    const entry: PastedImagePreview = {
      url: URL.createObjectURL(blob),
      mimeType: blob.type || "image/png",
      byteSize: blob.size,
      index: this.images.length + 1,
    };
    this.images.push(entry);
    return entry;
  }

  /**
   * Resolve placeholder number `n` to a cached image (D3): sole image →
   * image at paste position `n` → most-recent → null. The sole-image and
   * recency fallbacks absorb the cross-CLI numbering differences (Claude
   * shares its counter with text pastes; OpenCode/Codex reset per prompt).
   */
  resolve(n: number): PastedImagePreview | null {
    if (this.images.length === 0) {
      return null;
    }
    if (this.images.length === 1) {
      return this.images[0];
    }
    return this.images[n - 1] ?? this.images[this.images.length - 1];
  }

  /** Revoke every object URL and clear the cache. Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const img of this.images) {
      try {
        URL.revokeObjectURL(img.url);
      } catch {
        // Best-effort — revoke must not throw out of disposal.
      }
    }
    this.images.length = 0;
  }
}
