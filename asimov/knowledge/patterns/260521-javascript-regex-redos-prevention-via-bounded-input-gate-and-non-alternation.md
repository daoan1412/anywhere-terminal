---
labels: [regex, security, performance, javascript, redos]
source: add-clickable-file-paths
summary: Prevent catastrophic backtracking in JS regexes (which lack possessive groups) by capping input length and using explicit non-alternation character classes.
---
# JavaScript regex ReDoS prevention via bounded input gate and non-alternation character classes
**Date**: 2026-05-21

## TL;DR
- JS regex lacks possessive/atomic groups, so safety from ReDoS comes from:
  1. Bounded input length gate (e.g., 2000 chars/line).
  2. Non-alternation character classes in the main path body.
  3. Explicit anchored boundaries before/after the pattern.
- Without these, even simple-looking regex can cause O(2^n) backtracking on malicious input.

## Context
JavaScript's regex engine uses backtracking. Unlike Rust or PCRE2 with possessive groups, there's no built-in way to prevent catastrophic backtracking. Terminal output is untrusted — a malicious program can print strings designed to trigger worst-case regex work.

Example failure:
```js
// VULNERABLE: nested quantifiers + alternation
const bad = /(a|ab)+b/;
bad.exec('aaaaaaaaaaaac'); // Exponential backtracking
```

## Evidence
### Anchors
- `src/webview/links/filePathParser.ts` lines 24–28 → caps: `MAX_LINE_LENGTH = 2000`, `MAX_RESULTS = 10`
- `src/webview/links/filePathParser.ts` lines 56–70 → regex builders use explicit character classes:
  - grep: `[\w./\\@~+\-]+` (Windows version adds backslash)
  - No `(a|b)*` nested alternation in path body.
- `src/webview/links/filePathParser.ts` line 60–68 → lookbehind + lookahead boundaries:
  - grep: `(?<=^|[\s'"<({\[])` and `(?=$|[\s'"<>)}\],.;])`

## Prevention Gate
When implementing string parsing from untrusted input (terminal, file content, network):
1. Bail immediately if input exceeds a safe threshold (e.g., 2000 chars for terminal lines, 64KB for file chunks).
2. Avoid nested quantifiers: `(a+)+`, `(a|b)*`, `(a*)*`.
3. Use explicit character classes instead of alternation: `[abc]` instead of `(a|b|c)`.
4. Anchor start/end or use explicit boundaries to prevent backtracking across the entire input.
5. Test with pathological inputs: strings with repeated near-matches.

## When to apply
- Parsing user-editable content, terminal output, or config files.
- Any regex matching against unbounded input.
- Performance-critical code running per-line or per-keystroke.
