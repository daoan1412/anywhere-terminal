---
topic: file-tree-webview-libraries
created-by: research request for a VS Code webview file explorer component
date: 2026-05-22
libraries: [@vscode-elements/elements, react-complex-tree, rc-tree, react-arborist, @blueprintjs/core, react-aria-components, chonky, react-folder-tree]
used-by: []
---

# Research: file-tree-webview-libraries

## Answers
- There is no obvious first-party VS Code standalone tree widget package in the official webview toolkit docs; the closest standalone tree UI is the community package `@vscode-elements/elements`.
- Best direct fit for the requirements is `react-complex-tree`: it supports a custom async `TreeDataProvider`, lazy loading, keyboard nav, multi-select, DnD, renaming, and custom renderers.
- Best mature ecosystem choice is `rc-tree`: it has async `loadData`/`onLoad`, virtual rendering, DnD, and very high adoption.
- Best CSP-safe non-React option is `@vscode-elements/elements` (`<vscode-tree>`): it is a Lit web component and works in constrained CSP environments, but it expects the full tree data up front.
- Best lightweight React fallback is `react-arborist`: strong tree UX, virtualization, DnD, and rename support, but no built-in async child loader/data adapter.

## Ranked shortlist
| Rank | Package | v | wkly dl | last commit | gzip | async adapter | render | rec |
|---|---|---:|---:|---|---:|---|---|---|
| 1 | `react-complex-tree` | 2.6.1 | 65k | 2026-03-26 | 16.9k | yes (`TreeDataProvider`) | React | Best overall match for a lazy-loaded file tree. |
| 2 | `rc-tree` | 5.13.1 | 2.73M | 2026-03-29 | 28.0k | yes (`loadData`) | React | Most proven ecosystem option; great if you want a conventional tree. |
| 3 | `@vscode-elements/elements` | 2.5.1 | 26k | 2026-05-20 | 49.6k | no (data upfront) | web component (Lit) | Best if CSP/web-component compatibility matters most. |
| 4 | `react-arborist` | 3.7.0 | 347k | 2026-05-17 | 29.6k | no built-in loader | React | Good UX and size, but you must own lazy loading/data orchestration. |
| 5 | `@blueprintjs/core` | 6.15.0 | 376k | 2026-05-21 | 90.6k | no built-in loader | React | Only worth it if Blueprint is already in the stack; otherwise too heavy. |

## Not shortlisted
- `chonky`: file-browser app style, large bundle (125k gzip), and the repo is stale (last commit 2022). Good for a full file manager UI, not ideal for a slim embedded tree.
- `react-folder-tree`: tiny bundle, but stale (last commit 2022) and no credible lazy-loading story.
- `react-aria-components`: accessible headless primitives, but not a turnkey tree/file-manager component and the bundle is very large.

## Recommendation
- Use `react-complex-tree` if you want the closest match to a VS Code-style explorer with async loading and rich interactions.
- Use `rc-tree` if you want the safest, most battle-tested React tree with async loading and broad adoption.
- Use `@vscode-elements/elements` only if minimizing framework coupling/CSP friction is the top priority and you can hydrate children yourself.

## Confidence
High — based on npm metadata, Bundlephobia size data, GitHub commit dates, and DeepWiki/README docs for the shortlisted libraries.
