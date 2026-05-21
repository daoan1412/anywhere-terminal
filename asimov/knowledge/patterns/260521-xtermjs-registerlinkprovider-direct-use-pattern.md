---
labels: [xtermjs, link-provider, webview, architecture]
source: add-clickable-file-paths
summary: Call registerLinkProvider directly when you own both the call site and provider logic, instead of wrapping in an addon class.
---
# xterm.js registerLinkProvider direct-use pattern
**Date**: 2026-05-21

## TL;DR
- Use `terminal.registerLinkProvider(provider)` directly when you own the provider code.
- Avoids addon-class indirection; simpler when logic is tightly integrated.
- Mirrors `WebLinksAddon` structural pattern but without wrapper boilerplate.

## Context
xterm.js provides two ways to add link detection:
1. Use a pre-built addon (e.g., `WebLinksAddon` for HTTP/HTTPS).
2. Implement `ILinkProvider` directly and register via `terminal.registerLinkProvider()`.

When implementing custom link detection (e.g., file paths), the direct approach is cleaner if the logic is tightly bound to a single provider.

## Evidence
### Anchors
- `src/webview/links/FilePathLinkProvider.ts` → class `FilePathLinkProvider implements ILinkProvider`
- `src/webview/terminal/TerminalFactory.ts` lines 184–191 → registration without addon wrapper
  - grep: `terminal.registerLinkProvider(new FilePathLinkProvider`

## Pattern
1. Create a class implementing `ILinkProvider` (from `@xterm/xterm`).
2. Accept dependencies via constructor (terminal, sessionId, postMessage, platform).
3. Implement `provideLinks(bufferLineNumber, callback)` to detect and return `ILink[]`.
4. Register directly in TerminalFactory: `terminal.registerLinkProvider(new Provider({...}))`.
5. No addon lifecycle overhead — simple and composable.

## When to apply
- Adding custom link detection beyond built-in URL patterns.
- Logic is specific to one provider and not reusable elsewhere.
- Avoid: if the provider might be toggled on/off or shared across multiple terminals.
