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

**R1:** 0 BLOCK, 5 WARN — all accepted + fixed.
**R2 (re-review):** W1/W2/W5 confirmed resolved; W3/W4 resolved with 2 residual new findings — N1 accepted+fixed (D9 parent-ownership validation), N2 rebutted (nested load-more violates D1; non-pageable cap + true-count label is the accepted alternative).
**R3 (re-review of R2 fixes):** N1 RESOLVED (confirmed); N2 rebuttal SUSTAINED (dismissed); no further findings. **R1–R3 verdict: APPROVE — 0 BLOCK, 0 open WARN.**
**R4 (section-6 redesign + live fixes D15–D18):** new render paths reviewed (threaded `teammateTurn`, inline `teammateMessage`, markdown-lite, `cleanPromptText`/`hasContent`, CSS revert). R4-1 WARN + R4-2 SUGGEST accepted+fixed; security constraints re-verified intact (textContent-only incl. the new markdown renderer, color sanitization, view-only `:turn:`, ReDoS-safe parsing). Details: `.reviews/round-4.md`. **Final verdict: APPROVE — 0 BLOCK, 0 open WARN.**
