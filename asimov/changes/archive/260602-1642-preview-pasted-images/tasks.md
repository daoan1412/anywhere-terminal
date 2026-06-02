# Tasks: preview-pasted-images

## 1. Foundation

- [x] 1_1 Add `img-src` to the webview CSP and image-popup CSS
  - **Deps**: none
  - **Refs**: specs/pasted-image-preview/spec.md "Content-Security-Policy Image Source"; design.md D6
  - **Scope**: `src/providers/webviewHtml.ts`, `src/providers/webviewHtml.test.ts`
  - **Acceptance**:
    - Outcome: generated webview HTML CSP contains `img-src` allowing `blob:` and `data:`; an `.anywhere-hover-preview-image` rule exists in the inline `<style>` so a previewed image scales within the popup (max-width/height 100%, object-fit contain, block).
    - Verify: unit src/providers/webviewHtml.test.ts
  - **Plan**:
    1. In the CSP `content` (L76-79), add `img-src ${webview.cspSource} blob: data:;`.
    2. Add `.anywhere-hover-preview-image { display:block; max-width:100%; max-height:100%; object-fit:contain; margin:auto; }` near the other `.anywhere-hover-preview-*` rules.
    3. Add a `webviewHtml.test.ts` assertion that the HTML includes `img-src` with `blob:`.

- [x] 1_2 Create `PastedImageStore` (per-terminal cache, object URLs, correlation, disposal)
  - **Deps**: none
  - **Refs**: specs/pasted-image-preview/spec.md "Placeholder-to-Image Correlation", "Pasted-Image Cache Lifecycle"; design.md D2, D3 (interface block)
  - **Scope**: `src/webview/links/PastedImageStore.ts`, `src/webview/links/PastedImageStore.test.ts`
  - **Acceptance**:
    - Outcome: `add(blob)` returns `{url,mimeType,byteSize,index}` with a 1-based paste-order index and a `blob:` object URL; `resolve(n)` applies the D3 rule (sole → position n → most-recent → null); `dispose()` revokes every created object URL and empties the cache.
    - Verify: unit src/webview/links/PastedImageStore.test.ts
  - **Plan**:
    1. Implement the class per design.md interface; use `URL.createObjectURL`/`URL.revokeObjectURL`.
    2. `resolve`: 1 image → that image; else `images[n-1]` if present; else last; else null.
    3. Test add/index, all four resolve branches, and that dispose revokes each URL (spy on `URL.revokeObjectURL`).

## 2. Preview UI (reuse via extraction)

- [x] 2_1 Add `showImage` to `HoverPreviewPopup` via an extracted shell
  - **Deps**: 1_1, 1_2
  - **Refs**: specs/pasted-image-preview/spec.md "Hover Image Preview Rendering"; design.md D4 (interface block)
  - **Scope**: `src/webview/links/HoverPreviewPopup.ts`, `src/webview/links/HoverPreviewController.ts` (extend `HoverPreviewPopupHost` interface only), `src/webview/links/HoverPreviewPopup.test.ts`
  - **Acceptance**:
    - Outcome: `showImage(anchor, image, theme)` mounts the popup with an `<img class="anywhere-hover-preview-image" src={image.url}>` body and a header showing "Pasted image" + formatted byte size; reuses positioning/drag/resize/dismiss; existing `show()` (file preview) behavior is unchanged. `HoverPreviewPopupHost` declares `showImage`.
    - Verify: unit src/webview/links/HoverPreviewPopup.test.ts
  - **Plan**:
    1. Extract the scaffold in `show()` into `private renderShell(anchor, parts, theme)` (root + header + body append + footer + grip + mount + measure + `computePosition` + `attachListeners`); refactor `show()` to build its header/body then call it.
    2. Add `showImage()` that builds the `<img>` body (reuse `formatBytes`) + header text and calls `renderShell`.
    3. Add `showImage` to the `HoverPreviewPopupHost` interface in `HoverPreviewController.ts`.
    4. Add tests: `showImage` renders an `<img>` with the object URL and positions like `show`; assert existing `show` tests still pass.

- [x] 2_2 Add `attachImageHover` to `HoverPreviewController` via an extracted scheduler
  - **Deps**: 2_1
  - **Refs**: specs/pasted-image-preview/spec.md "Hover Image Preview Rendering"; design.md D4
  - **Scope**: `src/webview/links/HoverPreviewController.ts`, `src/webview/links/HoverPreviewController.test.ts`
  - **Acceptance**:
    - Outcome: `attachImageHover(link, resolve)` shows the resolved image via `popup.showImage` after the debounce with NO `postMessage`; returns/shows nothing when `resolve()` is null; reuses leave-grace + scroll/mousedown/Escape/blur dismissal. Existing file-preview hover behavior (debounce, stale-drop, override gating) is unchanged.
    - Verify: unit src/webview/links/HoverPreviewController.test.ts
  - **Plan**:
    1. Extract `private scheduleHover(event, link, fire)` from `onLinkHover` (the same-link guard + cancel + `activeLinkKey`/`activeAnchor` set + `pendingTimer` debounce + `ensureWindowListeners`); have the existing file path pass a `fire` that posts `requestFilePreview`.
    2. Implement `attachImageHover` wrapping `link.hover`/`link.leave`, whose `fire` calls `resolve()` and `popup.showImage(activeAnchor, image, getTheme())` (skip if null).
    3. Test: hovering an image link calls `showImage` after `debounceMs` and never calls `postMessage`; null resolve shows nothing; leave/Escape dismiss works; re-run file-preview tests.

- [x] 2_3 Fit image to popup width + flip-above after async image load
  - **Deps**: 2_1
  - **Refs**: specs/pasted-image-preview/spec.md "Hover Image Preview Rendering"; design.md D7
  - **Scope**: `src/providers/webviewHtml.ts`, `src/webview/links/HoverPreviewPopup.ts`, `src/webview/links/HoverPreviewPopup.test.ts`
  - **Acceptance**:
    - Outcome: `.anywhere-hover-preview-image` is `width:100%; height:auto` (fills container width, body scrolls when tall); the popup re-anchors on the `<img>` `load` event via an extracted `positionPopup`, so it flips above the placeholder when there's no room below — guarded so a stale load can't move a replaced popup.
    - Verify: unit src/webview/links/HoverPreviewPopup.test.ts
  - **Plan**:
    1. CSS: image `width:100%; height:auto`.
    2. Extract `positionPopup(root, anchor)` from `renderShell`; call at mount; re-call on `img` load (and immediately if already complete) guarded by `this.el === root`.
    3. Tests: flip-above after load (force offsetHeight in jsdom); stale-load doesn't move a replaced popup.

## 3. Detection + wiring

- [x] 3_1 Create the placeholder parser + `ImagePlaceholderLinkProvider`
  - **Deps**: 1_2, 2_2
  - **Refs**: specs/pasted-image-preview/spec.md "Image Placeholder Detection"; design.md D5; src/webview/links/SubagentLinkProvider.ts (template)
  - **Scope**: `src/webview/links/imagePlaceholderParser.ts`, `src/webview/links/imagePlaceholderParser.test.ts`, `src/webview/links/ImagePlaceholderLinkProvider.ts`
  - **Acceptance**:
    - Outcome: `parseImagePlaceholders(line)` returns one `{num,startCol,endCol}` per `/\[Image #?(\d+)\]/g` match (matches both `[Image #3]` and `[Image 3]`, multiple per line, none when absent). The provider emits one underlined `ILink` per match with the correct 1-based inclusive range and wires hover via `controller.attachImageHover(link, () => store.resolve(num))`.
    - Verify: unit src/webview/links/imagePlaceholderParser.test.ts
  - **Plan**:
    1. Implement the pure parser with a fresh global regex per call (reset `lastIndex`); compute `startCol = match.index`, `endCol = match.index + match[0].length - 1`.
    2. Implement the provider mirroring `SubagentLinkProvider` (single row via `getLine(n-1).translateToString(true)`, `disposed` guard), taking `terminal`, `store: PastedImageStore`, `controller: HoverPreviewController` deps; emit a link per match and call `attachImageHover`.
    3. Test the parser: `#`-form, space-form, multiple matches, no match, column ranges.

- [x] 3_2 Wire the store + provider into `TerminalFactory` and dispose them
  - **Deps**: 1_2, 2_2, 3_1
  - **Refs**: design.md D2, D5; src/webview/terminal/TerminalFactory.ts L246-370 (hover wiring), L606-616 (`disposeHoverController`)
  - **Scope**: `src/webview/terminal/TerminalFactory.ts`
  - **Acceptance**:
    - Outcome: each `createTerminal` builds a `PastedImageStore`, registers it in a `pastedImageStores` map, and registers an `ImagePlaceholderLinkProvider` (wired to that store + the terminal's `hoverController`). `getPastedImageStore(id)` returns it; `disposePastedImageStore(id)` calls `store.dispose()` and removes the entry; called inside `disposeHoverController(id)` so it fires on every existing teardown path.
    - Verify: manual create a terminal, paste an image, hover `[Image #N]` → preview appears
  - **Plan**:
    1. Add `private readonly pastedImageStores = new Map<string, PastedImageStore>()`; in `createTerminal` create the store, `set(id, store)`, and register the new provider after `SubagentLinkProvider` (L365-370).
    2. Add `getPastedImageStore(id)` and `disposePastedImageStore(id)` (dispose + delete); call the latter from `disposeHoverController` (L606-616) so all teardown paths cover it.

- [x] 3_3 Install the document-level paste-capture listener in `main.ts`
  - **Deps**: 3_2
  - **Refs**: specs/pasted-image-preview/spec.md "Clipboard Image Capture"; design.md D1; src/webview/main.ts (document-level capture handlers; `getActivePaneId` L217)
  - **Scope**: `src/webview/main.ts`
  - **Acceptance**:
    - Outcome: a capture-phase `document` `paste` listener finds the first `image/*` `clipboardData` item, reads it via `getAsFile()`, and calls `factory.getPastedImageStore(getActivePaneId())?.add(blob)`; it never calls `preventDefault`/`stopPropagation`, so the native paste still reaches xterm. No active pane / no image item → no-op.
    - Verify: manual paste image into a CLI; confirm `[Image #N]` still renders AND the preview store received the blob
  - **Plan**:
    1. Near the existing document-level capture listeners, add `document.addEventListener("paste", handler, true)`.
    2. Handler: guard `event.clipboardData`, find an item with `type.startsWith("image/")`, `getAsFile()`; if present, route to the active pane's store; return without mutating the event.

## 4. Validation

- [ ] 4_1 Manual end-to-end verification across the three CLIs
  - **Deps**: 3_2, 3_3, 2_1, 1_1
  - **Refs**: proposal.md "UI Impact & E2E"; design.md Risk Map
  - **Scope**: none (manual)
  - **Acceptance**:
    - Outcome: in the Extension Development Host, for Claude CLI (`[Image #N]`), Codex (`[Image #N]`) and OpenCode (`[Image N]`): pasting an image still produces the placeholder, and hovering it shows the pasted image after the hover delay; moving away / scrolling / Escape dismisses it; closing the tab and closing a split pane leave no console errors and no retained object URLs.
    - Verify: manual paste + hover + dismiss + teardown across Claude/OpenCode/Codex
  - **Plan**:
    1. Build, launch the Extension Development Host, and exercise paste→hover→dismiss→close for each CLI; confirm single-image exactness and recency fallback with two images.
