# Review Summary — nest-workflow-team-sessions

| ID | Title | Severity | R1 | R2 | Final |
|----|-------|----------|----|----|-------|
| W1 | Team-id parser accepts non-canonical encodings | WARN | open | resolved | fixed |
| W2 | Team-member predicate window differs | WARN | open | resolved | fixed |
| W3 | Member synthesizes its own team group (peer recursion) | WARN | open | resolved* | fixed (+N1) |
| W4 | Synthetic group detail ignores limit (unbounded) | WARN | open | resolved* | fixed (+N2) |
| W5 | Workflow manifest read has no size cap | WARN | open | resolved | fixed |
| N1 | Forged `:team:` id resolves under non-owning/non-leader parent | WARN | — | new | fixed (D9) |
| N2 | Synthetic-group truncation not pageable in nested renderer | WARN | — | new | rebutted (D1/D8; node label carries true count) |
| R4-1 | Stale `pendingNested` on collapse-mid-load | WARN | — | R4 | fixed |
| R4-2 | Direction-label overflow on long peer name | SUGGEST | — | R4 | fixed |
| R5-1 | `-webkit-line-clamp` on `.vault-md` can collapse thinking to height 0 | WARN | — | R5 | fixed |
| R5-2 | Team-segment (`:turn:`) read buffers whole slice unbounded | WARN | — | R5 | fixed |
| R5-3 | Teammate-turn accumulation unbounded before timeline cap | WARN | — | R5 | fixed |
| R5-4 | Summary-only inbound teammate message dropped | WARN | — | R5 | fixed |
| R5-5 | Mixed `- `/`1. ` list markers merged into one list | WARN | — | R5 | fixed |
| R5-6 | Cache-buster mtime-only (misses mtime-preserving builds) | SUGGEST | — | R5 | fixed |
| R5-7 | Symlink in store bypasses lexical containment | SUGGEST | — | R5 | accepted (out of threat model) |
| R5-8 | `readline` no per-line byte cap | SUGGEST | — | R5 | accepted (out of threat model) |
| R5-9 | Case-sensitive folder filter (Windows) | WARN | — | R5 | out-of-scope (pre-existing) |
| R5-10 | `claudeReader.ts` (1336 lines) decomposition | SUGGEST | — | R5 | follow-up change |

**R1:** 0 BLOCK, 5 WARN — all accepted + fixed.
**R2 (re-review):** W1/W2/W5 confirmed resolved; W3/W4 resolved with 2 residual new findings — N1 accepted+fixed (D9 parent-ownership validation), N2 rebutted (nested load-more violates D1; non-pageable cap + true-count label is the accepted alternative).
**R3 (re-review of R2 fixes):** N1 RESOLVED (confirmed); N2 rebuttal SUSTAINED (dismissed); no further findings. **R1–R3 verdict: APPROVE — 0 BLOCK, 0 open WARN.**
**R4 (section-6 redesign + live fixes D15–D18):** new render paths reviewed (threaded `teammateTurn`, inline `teammateMessage`, markdown-lite, `cleanPromptText`/`hasContent`, CSS revert). R4-1 WARN + R4-2 SUGGEST accepted+fixed; security constraints re-verified intact (textContent-only incl. the new markdown renderer, color sanitization, view-only `:turn:`, ReDoS-safe parsing). Details: `.reviews/round-4.md`. **Verdict: APPROVE — 0 BLOCK, 0 open WARN.**

**R5 (full deep re-review — fail-safe / Windows / architecture + oracle, all 5 agents):** 5 WARN + 1 SUGGEST accepted and **fixed** with regression tests — robust thinking-clamp (no height-0 collapse), bounded team-segment + teammate-turn reads, summary-only message preserved, list-marker split, size-keyed cache-buster. 2 SUGGESTs accepted-not-fixed (symlink + per-line cap — out of the untrusted-content/webview-id threat model). Windows: feature runs (path-correct); the one real Windows defect (case-sensitive folder filter) is **out-of-scope pre-existing** code → follow-up. Architecture: coherent model, NOT broken; `claudeReader.ts` decomposition recommended as a separate change. Details: `.reviews/round-5.md`. **Final verdict: APPROVE — 0 BLOCK, 0 open WARN; 2 documented SUGGESTs + 2 follow-ups.**
