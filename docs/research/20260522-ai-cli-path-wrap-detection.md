---
topic: ai-cli-path-wrap-detection
created-by: research for anywhere-terminal wrapped file-path hover bug
date: 2026-05-22
libraries: [microsoft/vscode, xtermjs/xterm.js, sst/opencode, google-gemini/gemini-cli, continuedev/continue, cline/cline, RooCodeInc/Roo-Code]
used-by: []
---

# Research: ai-cli-path-wrap-detection

## Answers
- **How AI CLIs wrap paths in practice:** public evidence is mixed. Cline avoids wrap in its VS Code UI and truncates long paths with ellipsis (`whitespace-nowrap overflow-hidden text-ellipsis [direction: rtl]`). Gemini CLI uses **Ink** + `string-width`, and its UI tests show long content soft-wraps/indents. Continue and Roo Code mostly render file refs as clickable UI elements/markdown links; they do not expose a terminal-style hard-wrap scheme. OpenCode uses a TUI (`opentui`), but I could not verify a path-specific wrap algorithm from docs. Public evidence for Claude Code / Codex / aider path wrapping was not verified.
- **How VS Code terminal handles wrap-aware links:** official terminal code walks wrapped lines using `isWrapped` and reconstructs text with `translateToString(!isWrapped)`. The adapter expands backward/forward over wrapped buffer rows, and multi-line detectors explicitly skip wrapped rows when scanning for a new logical record.
- **How xterm.js exposes the underlying data:** `BufferLine.isWrapped` marks the continuation row, not the source row. `translateToString(false)` preserves trailing space cells; `translateToString(true)` trims right. For precise end-of-written-text vs padding, cell APIs (`getCell`, `getChars`, `getWidth`) are the only reliable source.

## Relevant patterns
```ts
// VS Code: join wrapped output by reading the next line's wrap flag
const isWrapped = buffer.getLine(y + 1)?.isWrapped;
currentLine += line.translateToString(!isWrapped);
```

```ts
// xterm.js: trim behavior differs by flag
line.translateToString(false) // keeps trailing spaces
line.translateToString(true)  // trims right
```

```tsx
// Cline: avoid wrapping altogether
<span className="whitespace-nowrap overflow-hidden text-ellipsis [direction: rtl]">
```

```ts
// Gemini CLI: width-aware rendering utilities
import stringWidth from 'string-width';
```

## Recommended Approach
- **Drop the “no trailing whitespace” requirement** for explicit-newline continuations. That signal is unreliable because xterm stores padded cells even when the app did not soft-wrap.
- **Use a two-part join rule:** a strong continuation marker on row 2 (`· lines`, `lines 12`, leading path chars after indent) OR a strong path-bearing context on row 1 (`Read(`/`Edit(`/`Update(`/absolute path token). This matches the current provider’s safer logic and covers padded rows.
- **Prefer cell-aware boundary checks** when row 1 ends ambiguously: inspect the last non-empty cell instead of `trimEnd()` alone, then join only if row 2 begins with path-safe chars or an explicit continuation marker.

## Gotchas & Constraints
- False positives are most likely in dense tabular output (`ls -la`, `ps`, logs with timestamps) where row 1 may be full-width and row 2 starts with alphanumerics. Require tool-call prefixes or absolute-path roots to avoid joining these.
- Do not join across arbitrary wrapped prose; cap span length/rows aggressively.
- `isWrapped` alone is insufficient for app-emitted `\n` + indent cases because xterm leaves it `false`.

## Gaps
- I did not verify public repos for Claude Code, Codex CLI, or aider path wrapping directly.
- OpenCode’s exact path continuation algorithm was not surfaced in the available docs.
- Continue/Roo Code/Cline mostly expose UI path rendering, not terminal-output continuation heuristics.

## Confidence
**High** for VS Code/xterm behavior (official code + tests). **Medium** for AI CLI wrapping patterns (mixed public evidence; several repos only show UI truncation/rendering, not terminal continuation logic).
