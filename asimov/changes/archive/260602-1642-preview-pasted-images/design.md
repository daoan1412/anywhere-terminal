# Design: preview-pasted-images

## Decisions

### D1: Capture the clipboard image in the webview at paste time (observe-only)

The image bytes never reach the host terminal via the PTY — every target CLI reads the OS clipboard out of band (discovery §1). The host *is* the app delivering Cmd/Ctrl+V, so the one uniform interception point is the webview's own DOM `paste` event: `ClipboardEvent.clipboardData.items`, the first item with `type.startsWith("image/")`, `item.getAsFile()` → `Blob`.

A single **document-level `paste` listener** (capture phase) is installed in `main.ts` next to the existing document-level capture handlers (e.g. the Shift+Enter handler). It routes the blob to the **active pane's** store (`factory.getPastedImageStore(getActivePaneId())`). It is strictly observe-only: it never calls `preventDefault`/`stopPropagation`, so the empty paste still flows to xterm and the CLI's own clipboard read (which prints `[Image #N]`) is unaffected.

Rejected: intercepting in `InputHandler`'s key handler — the image lands on the textarea's `paste` event, not the keydown, and the existing handler deliberately delegates V to the browser.

### D2: Per-terminal `PastedImageStore`, object URLs, disposed on every teardown path

New module `src/webview/links/PastedImageStore.ts`. Mirrors the `hoverControllers` ownership pattern: `TerminalFactory` holds `private pastedImageStores = new Map<string, PastedImageStore>()`, creates one per `createTerminal`, exposes `getPastedImageStore(id)`, and `disposePastedImageStore(id)` called from the same sites as `disposeHoverController` (`main.ts` removeTerminal L413 tab + L426 split panes; split-close L542/L550).

The store assigns a **1-based paste-order index** and creates an object URL per image. `dispose()` calls `URL.revokeObjectURL` on every cached URL and clears the map — this is the explicit disposal the body-overlay-disposal memory demands (must fire on split + tab close, not only root close).

### D3: Recency-anchored correlation rule

Placeholder numbering is not reliable across tools (Claude shares a monotonic counter with text pastes; OpenCode/Codex reset and renumber per prompt — discovery §1). The store, however, indexes images **cumulatively for the whole terminal session**. So a placeholder's absolute number is NOT its store position: after the first prompt is submitted the CLI's counter resets, and an absolute-position lookup maps `#1` to the *first image ever pasted* rather than the one just pasted.

**Correction (post-release bugfix):** the original `resolve(n)` did sole → position-`n` → most-recent, which exhibited exactly this stale-image bug (paste img1, submit, paste img2 → hovering the new `[Image #1]` showed img1). Replaced by a recency-anchored mapping owned jointly by the provider and store: the link provider parses *all* placeholders on the hovered row (= the current prompt's image batch), orders them ascending by number, and for each computes its 0-based `rank` and the `batchSize`. `store.resolveRecent(rank, batchSize)` maps that batch onto the most-recently captured `batchSize` images — the highest-numbered placeholder always resolves to the newest image. This is exact for the dominant flow (paste one image, hover it), correct for multi-image-in-one-prompt, and ignores absolute numbers entirely (so Claude's shared counter no longer matters — only relative order + count). Degrades to most-recent when the batch exceeds the cache (a missed capture) or the input wraps across rows (single-row provider undercounts the batch).

Rejected: absolute-position lookup (the released bug); parallel monotonic counter (drifts when Claude counts text pastes); reading CLI on-disk caches by `N` (Claude-only, cross-boundary fs + session discovery — Option A).

### D4: Reuse the hover controller + popup via extracted shared scaffolds (no IPC for images)

UX must match the existing terminal-hover popup, and the reuse-not-duplicate rule forbids cloning the dismissal/positioning orchestration. So both consumers (file preview, image preview) compose shared internals:

- **`HoverPreviewController`** — extract a private `scheduleHover(event, link, fire: () => void)` from the existing `onLinkHover` body (debounce bookkeeping: `activeLinkKey`, `activeAnchor`, `pendingTimer`, `ensureWindowListeners`, same-link guard). The file path's `fire` posts `requestFilePreview` (unchanged behavior, incl. override/confirmation state). New `attachImageHover(link, resolve: () => PastedImagePreview | null)` wraps `link.hover/leave` and its `fire` resolves locally and calls `popup.showImage(anchor, image, theme)` — **no `postMessage`**. All dismissal/leave-grace/window-listener machinery is shared.
- **`HoverPreviewPopup`** — extract a private `renderShell(anchor, { headerText, body, openButton? }, theme)` from `show()` containing the scaffold (root creation + z-index + flex column, header, body append, footer, SE grip, `document.body` mount, height measure, `computePosition` clamp/flip, `attachListeners`). `show()` builds the file header/body then calls it (behavior preserved). New `showImage(anchor, image, theme)` builds an `<img class="anywhere-hover-preview-image">` body (object URL) + a "Pasted image · {size}" header, then calls the same `renderShell` — inheriting drag/resize/positioning/dismiss for free.

Rejected: a standalone `ImageHoverPopup`/`ImageHoverController` — would duplicate ~150 lines of dismissal + positioning orchestration the reuse rule prohibits.

### D5: Placeholder matcher as a pure module; single-row provider mirroring SubagentLinkProvider

New `src/webview/links/imagePlaceholderParser.ts` exports `parseImagePlaceholders(line: string): { num: number; startCol: number; endCol: number }[]` using `/\[Image #?(\d+)\]/g` over the row's `translateToString(true)`. New `ImagePlaceholderLinkProvider.ts` (an `ILinkProvider`) calls it per row and emits one `ILink` per match — single-row, no soft-wrap back-walk (placeholders are short and live on the input line), exactly like `SubagentLinkProvider`. Columns map from `match.index` (0-based) to xterm's 1-based inclusive range: `start.x = startCol + 1`, `end.x = endCol + 1`.

Column mapping assumes one cell per JS char; a wide (CJK) glyph *before* the placeholder on the same row would offset the range — a documented limitation, acceptable because the placeholder normally sits on an otherwise-ASCII prompt line (same assumption `SubagentLinkProvider` already makes).

### D6: CSP gains `img-src ... blob: data:`

`webviewHtml.ts` CSP becomes `... img-src ${webview.cspSource} blob: data:; ...`. Object URLs are `blob:`; without this, `default-src 'none'` blocks the `<img>` silently. `data:` is included for robustness/future inline use. `webviewHtml.test.ts` gains an assertion. Image popup CSS (`.anywhere-hover-preview-image`) is added to the same inline `<style>` block that already holds the hover-preview styles.

### D7: Image fills popup width; re-anchor after async load to enable flip-above

Two refinements from manual review of the live popup:

- **Fit width, auto height.** `.anywhere-hover-preview-image` is `width: 100%; height: auto` (was `max-width/height: 100%; object-fit: contain`), so the image spans the popup's content width and scales height by aspect ratio. `showImage` passes `maxPopupHeight: Infinity` to `renderShell` so the popup auto-grows to that recalculated height bounded only by the viewport (not the file preview's fixed 360 cap); only an image taller than the viewport scrolls. `positionPopup` reads the per-popup cap back off `root.style.maxHeight`. This matches the requested behavior ("fit the horizontal width; height auto-recalculates") at the cost of upscaling a very small image — an accepted trade.
- **Flip-above after load.** The `<img>` has no height until the blob decodes, so the first `offsetHeight` measure sees a near-empty popup and `computePosition` places it below the anchor without flipping — then the loaded image overflows downward and is clipped. Fixed by extracting `positionPopup(root, anchor)` from `renderShell` and re-invoking it on the image's `load` event (guarded by `this.el === root` so a stale load can't move a replaced popup). The existing flip-above branch in `computePosition` then triggers with the real height. The file path positions once at mount (its text body has height immediately), unchanged.

## Interfaces

```ts
// src/webview/links/PastedImageStore.ts
export interface PastedImagePreview {
  url: string;        // object URL (blob:)
  mimeType: string;   // e.g. "image/png"
  byteSize: number;   // blob.size
  index: number;      // 1-based paste order
}
export class PastedImageStore {
  add(blob: Blob): PastedImagePreview;                            // assigns next index, creates object URL
  resolveRecent(rank: number, batchSize: number): PastedImagePreview | null; // D3 recency-anchored
  dispose(): void;                                                // revoke all URLs + clear
}

// src/webview/links/imagePlaceholderParser.ts
export function parseImagePlaceholders(
  line: string,
): { num: number; startCol: number; endCol: number }[];

// HoverPreviewController (added)
attachImageHover(link: ILink, resolve: () => PastedImagePreview | null): void;

// HoverPreviewPopup / HoverPreviewPopupHost (added)
showImage(anchor: MouseEvent, image: PastedImagePreview, theme: HoverPreviewThemeKind): void;
```

`HoverPreviewPopupHost` (the controller's view interface) gains `showImage` so the controller stays testable with a fake.

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| `webviewHtml.ts` CSP | No `img-src` → `<img>` blocked, popup shows nothing | D6 adds `img-src ... blob: data:`; assert in `webviewHtml.test.ts` (task 1_1) |
| `PastedImageStore` | Object URLs leak across terminals | `dispose()` revokes all URLs; called from every `disposeHoverController` site incl. split-close (D2, task 3_2/3_3); unit test asserts revoke (task 1_2) |
| `main.ts` paste listener | Consuming the paste breaks the CLI's clipboard read | Observe-only, never `preventDefault`/`stopPropagation` (D1); manual verify the CLI still emits `[Image #N]` (task 4_1) |
| Correlation (`resolve`) | Wrong image when numbering resets/diverges | Recency-first fallback (D3); exact for single-image flow; documented limitation; covered by store unit tests (task 1_2) |
| `HoverPreviewController` / `HoverPreviewPopup` | Extraction regresses hardened file-preview hover (security gating) | `scheduleHover`/`renderShell` preserve the file path's behavior verbatim; re-run existing `HoverPreviewController.test.ts` + `HoverPreviewPopup.test.ts` (tasks 2_1, 2_2) |
| `ImagePlaceholderLinkProvider` | Wide-char column offset mis-ranges the link | Single-row ASCII-cell mapping mirroring `SubagentLinkProvider`; documented limitation; parser unit-tested (task 3_1) |
| Webview clipboard access | `getAsFile()` unavailable under CSP/permissions | Use synchronous `ClipboardEvent.clipboardData.items` (available in the paste handler), not the async Clipboard API; manual verify (task 4_1) |
