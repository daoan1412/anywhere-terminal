---
topic: vscode-vendoring-license-attribution
created-by: research request on vendoring Microsoft/vscode tree/list UI code into anywhere-terminal
date: 2026-05-22
libraries: [microsoft/vscode]
used-by: []
---

# Research: vscode-vendoring-license-attribution

## Answers
- **Microsoft/vscode license:** the repo is **plain MIT**. `LICENSE.txt` starts with `MIT License` and the standard MIT grant/disclaimer; there is no separate modified license.
- **File headers:** the copied tree/list files use Microsoft’s standard header: `Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. See License.txt in the project root for license information.` The files I checked (`asyncDataTree.ts`, `listWidget.ts`) both use the same header block.
- **Attribution/compliance:** under MIT, you must keep the copyright + permission notice with copies/substantial portions. Best practice is to **preserve the original header in each vendored file** and also add a repo-level third-party notice/license file. Modifications are allowed. 
- **Trademark:** code license does **not** grant naming/branding rights. Microsoft’s brand rules say not to use **Visual Studio Code / VS Code** in your product/site/domain names or in ways that imply endorsement. Descriptive compatibility references are fine; don’t brand as official.
- **Best-practice examples:** Theia keeps Microsoft’s MIT header in a VS Code-derived file and adds an explicit comment that code was “copied and modified from” VS Code. That’s the pattern to emulate: keep provenance in-file and add a top-level notice.

## Recommended Approach
- Keep the upstream Microsoft header in every vendored VS Code file.
- Add `THIRD_PARTY_NOTICES.md` (or equivalent) in the repo root containing the full MIT license text and a provenance note listing the vendored VS Code paths/commit.
- Preserve a short provenance comment in vendored files when practical (e.g. `Copied and adapted from microsoft/vscode ...`).
- Avoid “VS Code”/“Visual Studio Code” in repo/product/domain branding unless used purely descriptively.

## Gotchas & Constraints
- MIT does **not** require you to keep `All rights reserved`; Microsoft’s own files still often include it, but the legal requirement is the notice/license text, not that phrase.
- Shipping only a bundled `webview.js` still counts as redistributing substantial portions of the code if the VS Code source is compiled into it.
- If you materially rewrite some files, the original notice should remain for the copied portions.

## Confidence
**High** — confirmed by the upstream MIT license file, the exact headers in the target files, Microsoft’s brand guidelines, and a real-world VS Code-derived example from Theia.

## Sources
- [Microsoft/vscode LICENSE.txt](https://github.com/microsoft/vscode/blob/main/LICENSE.txt)
- [Visual Studio Code brand guidelines](https://code.visualstudio.com/brand)
- [Visual Studio Code license page](https://code.visualstudio.com/license)
- [microsoft/vscode issue #96747](https://github.com/microsoft/vscode/issues/96747)
- [Eclipse Theia VS Code-derived file](https://github.com/eclipse-theia/theia/blob/master/packages/plugin-ext/src/main/browser/plugin-icon-theme-service.ts)
- [CodinGame/monaco-vscode-api README](https://github.com/CodinGame/monaco-vscode-api/blob/main/README.md)
