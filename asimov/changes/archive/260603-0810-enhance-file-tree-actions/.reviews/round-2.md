# Review: enhance-file-tree-actions (Round 2)

Date: 2026-06-03

Verdict: APPROVE

Counts:
- Blocking: 0
- Warnings: 0
- Suggestions: 1

Agents:
- data-security/logic: Mencius (`019e8c7a-d45a-7953-8131-7eb997d04131`)
- contracts: Hypatia (`019e8c7a-d49b-7a31-afda-081a5d68d188`)
- frontend: Faraday (`019e8c7a-d4d5-7a20-b0e0-d28a2c9a33a1`)

## Round 1 Finding Status

- B1 fixed: `activeFileTreeRoot` is reset on attach and Open Folder roots are adopted only after the reveal channel is ready.
- B2 fixed: active-root equality now uses the same path-relative semantics as containment.
- W1 fixed: reveal and copy handlers catch VS Code API failures and surface concise errors.
- W2 fixed: row context menus close on tree remount and actions use the generation captured when the menu opened.

## Findings

### S1: Containment rejects valid child names that begin with two dots

- ID: S1
- Severity: SUGGEST
- Confidence: HIGH
- Priority: P4
- Agent: Mencius
- File: `src/providers/fileTreeHost.ts:497`
- Status: accepted
- Evidence: `isSameOrInside()` rejected any relative path where `rel.startsWith("..")`. That rejects parent traversal, but also rejects valid children whose first relative segment is named like `..data`.
- Impact: Reveal/copy/delete actions silently fail for legitimate files or folders inside the active root if the first relative segment begins with `..`.
- Suggested Fix: Reject only actual parent traversal cases: `..`, `../...`, and `..\...`.
- Triage: Accepted. This is a small correctness fix with a straightforward regression test.

## Clean Areas

- Contracts/routing: no new findings. Message contracts still omit webview-supplied base paths and both providers route all four action messages through `FileTreeHost`.
- Frontend: no new findings. Focused frontend verification passed with 53 tests.

## Verification Before Round 2

- `pnpm run check-types` passed.
- `pnpm run lint` exited 0 with warnings.
- `pnpm run test:unit` passed with 122 test files and 2114 tests.

## Session IDs

- data-security: Mencius (`019e8c7a-d45a-7953-8131-7eb997d04131`)
- logic: Mencius (`019e8c7a-d45a-7953-8131-7eb997d04131`)
- contracts: Hypatia (`019e8c7a-d49b-7a31-afda-081a5d68d188`)
- frontend: Faraday (`019e8c7a-d4d5-7a20-b0e0-d28a2c9a33a1`)
