# pasted-image-preview Specification
## Requirements

### Requirement: Clipboard Image Capture

When a `paste` event carries a `clipboardData` item whose type begins with `image/`, the webview SHALL read that item as a `Blob` and store it in the **active pane's** pasted-image cache, and SHALL NOT call `preventDefault()` / `stopPropagation()` on the paste event.

#### Scenario: Capture must not consume the paste

- **WHEN** an image is pasted into a focused terminal
- **THEN** the image blob is added to that terminal's cache AND the native paste still propagates to xterm so the CLI's own clipboard read (which renders `[Image #N]`) proceeds unaffected.

### Requirement: Image Placeholder Detection

A terminal link provider SHALL treat a substring matching `/\[Image #?(\d+)\]/` (literal `[Image `, an optional `#`, one or more decimal digits, `]`) as a single-row hover target, emitting one xterm `ILink` per match on the row with `(\d+)` captured as the placeholder number. This covers Claude/Codex (`[Image #N]`) and OpenCode (`[Image N]`).

### Requirement: Placeholder-to-Image Correlation

A hovered placeholder's number SHALL NOT be treated as its absolute position in the cache, because the CLI restarts its `[Image #N]` counter each prompt (and Claude shares that counter with text pastes) while the cache indexes cumulatively for the terminal session. Resolution SHALL instead be anchored to recency: given the set of placeholders on the hovered input row (the current prompt's batch) ordered by ascending number, the placeholder at 0-based rank `r` within a batch of size `B` SHALL resolve to the `r`-th of the most-recently captured `B` images (so the highest-numbered placeholder resolves to the newest image). If the cache holds fewer than `B` images or the rank is out of range, resolution SHALL return the most-recently captured image; if the cache is empty, it SHALL return nothing and show no popup.

### Requirement: Hover Image Preview Rendering

Hovering a detected placeholder SHALL, after the shared hover debounce, render the resolved image in the hover-preview popup as an `<img>` that fills the popup's content width with height scaled by aspect ratio (the popup body scrolls when the image is taller than the popup), with a header line stating it is a pasted image and its byte size. The popup SHALL be re-anchored once the image finishes loading so it flips above the placeholder when there is insufficient room below it. The image SHALL be resolved and rendered entirely in the webview from the cached object URL with no extension-host round-trip, and SHALL reuse the existing popup dismissal behavior (leave-grace, scroll / mousedown / Escape / blur).

### Requirement: Content-Security-Policy Image Source

The webview HTML CSP SHALL include an `img-src` directive permitting `blob:` (and `data:`) sources so object-URL image previews render under the otherwise `default-src 'none'` policy.

### Requirement: Pasted-Image Cache Lifecycle

Each terminal SHALL own its pasted-image cache, and disposing the terminal SHALL revoke every object URL the cache created and clear it. Disposal SHALL run on every teardown path that disposes the hover controller — tab close and split-pane close — so no object URL outlives its terminal.

