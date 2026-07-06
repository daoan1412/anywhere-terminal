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
  /**
   * Cap on retained entries. Each pins its blob (via the object URL) until
   * revoked, so an uncapped store grows webview memory for the whole session.
   * `resolveRecent` only ever maps into the most-recent batch, so evicting the
   * oldest beyond this window preserves hover-preview behavior.
   */
  private static readonly MAX_ENTRIES = 16;

  private readonly images: PastedImagePreview[] = [];
  private nextIndex = 1;
  private disposed = false;

  /** Capture a pasted image; assigns the next 1-based index + a blob: URL. */
  add(blob: Blob): PastedImagePreview {
    const entry: PastedImagePreview = {
      url: URL.createObjectURL(blob),
      mimeType: blob.type || "image/png",
      byteSize: blob.size,
      index: this.nextIndex++,
    };
    this.images.push(entry);
    while (this.images.length > PastedImageStore.MAX_ENTRIES) {
      const evicted = this.images.shift();
      if (evicted) {
        try {
          URL.revokeObjectURL(evicted.url);
        } catch {
          // Best-effort — revoke must not throw out of add().
        }
      }
    }
    return entry;
  }

  /**
   * Resolve a placeholder to a cached image, anchored to recency (D3).
   *
   * A placeholder's number is NOT its position in this store: the CLI restarts
   * its `[Image #N]` counter every prompt (and Claude even shares the counter
   * with text pastes), while this store indexes cumulatively for the whole
   * terminal session. Using the absolute number would always map `#1` to the
   * first image ever pasted — the wrong image after the first prompt.
   *
   * Instead the caller passes the placeholder's `rank` (0-based, ascending by
   * number) within the current prompt's `batchSize` placeholders — the set the
   * link provider parsed off the input row. Those map onto the most-recently
   * pasted `batchSize` images in order, so the newest placeholder always
   * resolves to the newest image. Out-of-range → most-recent.
   *
   * @param rank      0-based position within the current row's ascending batch.
   * @param batchSize count of placeholders on the current input row (≥ 1).
   */
  resolveRecent(rank: number, batchSize: number): PastedImagePreview | null {
    const len = this.images.length;
    if (len === 0) {
      return null;
    }
    if (rank < 0) {
      return this.images[len - 1];
    }
    const batch = batchSize > 0 ? batchSize : 1;
    const start = Math.max(0, len - batch);
    return this.images[start + rank] ?? this.images[len - 1];
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
