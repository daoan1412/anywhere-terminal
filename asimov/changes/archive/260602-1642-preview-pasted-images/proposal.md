# Proposal: preview-pasted-images

## Why
When a user pastes an image into a terminal running Claude CLI / OpenCode / Codex, the input shows only a `[Image #N]` placeholder — opaque and easy to lose track of. Hovering the placeholder should preview the actual image.

## Appetite
M (≤3d)

## Scope

### In scope
- Capture an `image/*` clipboard item in the webview at paste time into a per-terminal cache (object URL, paste-order index), without disturbing the paste the CLI relies on.
- A link provider that makes `[Image #N]` and `[Image N]` placeholders hoverable.
- Render the cached image in the existing hover-preview popup (reused), resolved entirely webview-side (no IPC).
- Correlate placeholder number → cached image with a recency-first fallback rule.
- Add `img-src blob:` to the webview CSP; dispose the cache (revoke object URLs) on every terminal teardown path.

### Out of scope
- Reading the CLIs' on-disk image caches / session files (Option A).
- Previewing image **files** referenced by path in output (that is the existing file-link hover's domain; it shows them as "binary").
- Sending image bytes over IPC to the extension host; persistence across reloads.
- Exact correlation when a CLI renumbers/resets placeholders mid-session (documented limitation).
- Non-image pastes (`[Pasted text #N]`, SVG chips).

## Capabilities

1. **pasted-image-preview** — capture pasted clipboard images per terminal and preview them on hover over the `[Image #N]` / `[Image N]` placeholder.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — a new hover popup appears over the placeholder text.
- **E2E required?** NOT REQUIRED — the project has no E2E harness (`asimov/project.md` § Commands → E2E: N/A); logic is covered by Vitest unit tests (store, parser, popup, controller) and a manual verification pass across the three CLIs.
- **Justification**: Clipboard `paste` events and real PTY image pastes can't be driven by the existing Mocha/Vitest setup; behavior is unit-tested at the seams and verified manually in the Extension Development Host.

## Risk Level
MEDIUM — touches the security-hardened, heavily-tested hover controller/popup and the webview CSP; mitigated by reuse-via-extraction (no behavior change to the file path) and existing test suites.
