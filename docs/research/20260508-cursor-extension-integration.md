---
topic: cursor-extension-integration
created-by: planning research for support-cursor-integration
date: 2026-05-08
libraries: [Cursor, VS Code Extension API, Open VSX, node-pty]
used-by: [support-cursor-integration]
---

# Research: cursor-extension-integration

## Answers

- Cursor’s default extension path is now Open VSX: Cursor announced it switched the in-app extension library to OpenVSX, publishes/maintains some Anysphere-built replacements, and asks missing-extension maintainers to publish to OpenVSX. Cursor also allows manual `.vsix` install by dragging into the Extensions pane. Switching marketplace backends exists in v1.1.3+, but Cursor says it is not officially supported. (Cursor forum: “Extension Marketplace Changes - Transition to OpenVSX”)
- VS Marketplace is still a valid publish target for standard VS Code users, but it is not the primary distribution path for Cursor compatibility. For Cursor-first distribution, publish to Open VSX and offer a VSIX download fallback. (Cursor forum + VS Code publishing docs)
- `package.json` must declare a real `engines.vscode` floor; VS Code docs say it cannot be `*`, and it should match the oldest API level actually used. For native/desktop-only extensions, keep `main` only; only add `browser` if you truly support web extensions. Use `extensionKind` to steer desktop/remote placement, but native modules cannot run in a web extension host. (VS Code Extension Manifest + Extension Host docs)
- `node-pty` is a native module, so it brings ABI/build constraints: Electron/Node version matching, per-platform binaries, and native rebuilds. It is not web-compatible. On Windows it uses ConPTY or WinPTY; on macOS/Linux it uses `forkpty()`/`posix_spawn()`. Shipping as a VSIX with platform-specific builds is the safest path for desktop support. (DeepWiki: `microsoft/node-pty`; VS Code publishing docs)
- Testing should be split into two layers: standard VS Code extension-host integration tests via `@vscode/test-electron`/`@vscode/test-cli`, and a Cursor smoke test that installs the built VSIX into the target Cursor build. Validate install/update behavior from both Open VSX and VSIX sideloading; do not depend on the unsupported marketplace switch for release QA. (VS Code Testing Extensions docs + Cursor forum)

## Recommended Approach

- Primary distribution: Open VSX publish + GitHub release `.vsix` artifact.
- Secondary distribution: VS Marketplace for VS Code users only.
- Keep the extension desktop-only, with an accurate `engines.vscode` floor, no `browser` entry, and `extensionKind` set for Node-based desktop execution.
- For `node-pty`, build/test per OS/arch and treat it as a native dependency, not a portable JS-only package.

## Installation

- Open VSX publishing: `ovsx publish <extension.vsix>` or publish from a directory via the `ovsx` CLI. (DeepWiki: `eclipse/openvsx`)
- VS Marketplace: `vsce package` / `vsce publish`, or install a `.vsix` with **Install from VSIX...** / `code --install-extension <file>.vsix`. (VS Code publishing docs)
- Cursor fallback: drag the `.vsix` into the Extensions pane, per Cursor’s forum guidance.

## Core API

- `engines.vscode` — required compatibility floor.
- `main` — Node/Electron entry point.
- `browser` — only for web extensions; avoid for a `node-pty`-backed extension.
- `extensionKind` — choose `ui`/`workspace` preference; web is not an option for native modules.

## Platform-Specific Setup

- `node-pty` requires native builds and Electron ABI alignment; plan CI artifacts per OS/arch.
- Prefer platform-specific VSIX packaging for native binaries (`vsce --target ...`) when shipping binaries.
- Do not assume Cursor’s marketplace backend switch is a supported release mechanism.

## Usage Examples

- Cursor forum example: users can install local `.vsix` files by dragging them into the Extensions pane; maintainers should publish missing extensions to OpenVSX.
- VS Code docs example: `vsce package` generates a VSIX and `vsce publish` uploads to Marketplace; `code --install-extension my-extension.vsix` installs locally.

## Gotchas & Constraints

- Open VSX is now the default Cursor extension source, so Marketplace-only publishing can leave Cursor users unable to find the extension.
- `node-pty` is native, so web extensions are out.
- `engines.vscode` that is too new can block install in Cursor if its bundled VS Code baseline lags behind.
- Marketplace switch in Cursor is explicitly “not officially supported.”

## Gaps

- No official Cursor developer doc was found that fully documents extension publishing strategy; the strongest Cursor-specific source was the community forum announcement.
- Cursor-specific CI automation for extension testing was not found; the recommendation to smoke-test in Cursor is inferred from compatibility behavior, not a published Cursor test harness.

## Confidence

Medium-High — confirmed by Cursor forum announcement, official VS Code publishing/testing docs, and DeepWiki docs for `node-pty`, `vscode`, and Open VSX.

## Addendum: Cursor 3.2.21 / VS Code 1.105 compatibility

- Confirmed available in VS Code 1.105: `WebviewViewProvider` (introduced 1.57), `WebviewPanel` (1.39), `viewsContainers.activitybar` (1.39), and `viewsContainers.panel` (1.47). DeepWiki also confirms the desktop extension host is Node-based, so native modules are fine in the desktop host but not in web.
- Confirmed available in 1.105 by source usage: `webviewSection` in webview context data (`microsoft/vscode` examples in `extensions/notebook-renderers` and `extensions/markdown-language-features`), `FocusedViewContext` / `focusedView` in the workbench (`src/vs/workbench/browser/actions/layoutActions.ts`, `src/vs/workbench/services/views/browser/viewsService.ts`), and `env.appRoot` in desktop extensions (`extensions/tunnel-forwarding`, `extensions/git`, `microsoft/vscode-azure-account`).
- The exact command string `workbench.action.moveViewToSecondarySideBar` was not directly verified in indexed sources, but secondary-sidebar support is present in the VS Code workbench by 1.64 and view-moving actions are built around `FocusedViewContext`.
- Recommended manifest floor for the current API set: `engines.vscode: ^1.105.0` (or `>=1.105.0 <1.106.0` if the intent is to pin exactly to the Cursor 3.2.21 baseline). Keep the floor higher only if the extension also uses APIs added after 1.105.
- Caveat: `env.appRoot` and native modules are desktop/Electron assumptions; do not rely on them for a web extension host.

Sources: DeepWiki (`microsoft/vscode` extension API + webviews), GitHub code examples for `webviewSection`, `focusedView`, and `env.appRoot`, plus Cursor forum guidance captured earlier in this report.
