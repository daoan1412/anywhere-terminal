# Proposal: add-hover-file-preview

## Why

Today, file-path links in the terminal can only be activated by clicking, which interrupts the user's flow and replaces or stacks editor tabs. Hovering should instead surface a quick, nicely-formatted preview of the file's content (with VSCode-grade syntax highlighting and rendered markdown) so users can glance at referenced files without leaving the terminal.

## Appetite

M (≤3d) — single capability with a contained scope, bounded by a fine-grained Shiki bundle and lazy-loaded grammars. Two well-isolated layers (webview popup + host file-read), reusing the existing path-resolution chain.

## Scope

### In scope

- xterm.js `ILink.hover`/`leave` integration for file-path links — 300 ms debounce, dismissal on leave/scroll/blur.
- A new floating popup attached as a child of `terminal.element` with class `xterm-hover` (xterm's documented integration point for DOM tooltips).
- A new IPC request/response pair (`requestFilePreview` / `filePreviewResult`, correlated by `requestId`).
- A host-side first-hit-only path resolver derived from the existing `buildCandidates` chain — no quickPick, no "File not found" toast on hover.
- A host-side file-read helper with hard caps (binary detection, byte/line limits).
- Shiki-based syntax highlighting in the popup; markdown previews use markdown-it with our Shiki renderer wired via its `highlight` callback (no `@shikijs/markdown-it` — see design.md D12).
- Theme bridge mapping VSCode `colorTheme.kind` to a Shiki theme.
- Lazy-loaded grammars: base bundle ships only a minimal core; first hover of a new language dynamic-imports its grammar.
- Tests: hover state-machine unit, IPC contract unit, first-hit resolver unit, popup-render smoke.

### Out of scope

- Showing a popup for non-file links (URLs continue to use `WebLinksAddon`).
- Inline editing or any interactive controls inside the popup (read-only preview only).
- Image / PDF / non-text file rendering (binary placeholder only).
- Bytecode/symbol/document-symbol info inside the popup (no language services).
- Replacing or modifying the existing click-to-open flow or its quickPick / modal-confirm UX.
- A configurable disable switch — landing as an always-on feature for v1; settings can be added later if needed.

## Capabilities

1. **file-link-hover-preview** — When the user hovers a detected file-path link in the terminal for ≥300 ms, a floating popup appears showing the file's content with VSCode-grade syntax highlighting (or rendered markdown for `.md` files), positioned near the cursor, dismissed on `leave`, scroll, blur, or a new hover.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — a new floating popup over the terminal area; new mouse-hover interaction on existing underlined file links.
- **E2E required?** NOT REQUIRED for this change.
- **Justification**: This repo has no E2E harness (`asimov/project.md` § Commands → E2E: N/A). Verification is unit tests (parser/IPC/resolver/popup state) plus a documented manual smoke checklist (verify hover triggers popup, dismiss triggers, syntax highlighting renders, markdown renders, binary placeholder, out-of-workspace previews silently). Adding an E2E harness is outside the change's appetite.

## Risk Level

MEDIUM — new cross-boundary IPC, new webview-side rendering pipeline, new runtime dependency (Shiki), and a CSP-sensitive bundle pipeline. No production data, no security-privileged operations beyond what `openFile` already does; the existing path resolver caps blast radius.
