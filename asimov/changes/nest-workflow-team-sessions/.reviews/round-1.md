# Review: nest-workflow-team-sessions — Round 1

- **Date:** 2026-05-29
- **Reviewable lines:** ~712 (claudeChildIds.ts 123 + claudeReader.ts ~545 + detail.ts 44)
- **Agents spawned:** data-security, logic, contracts (frontend skipped — webview unchanged)
- **Verdict:** WARN
- **Counts:** BLOCK 0 · WARN 5 · SUGGEST 0

## Findings

### W1 — Team-id parser accepts non-canonical / over-segmented encodings
- **severity:** WARN · **confidence:** HIGH · **priority:** P2 · **agent:** logic + contracts (merged L2+C4)
- **file:** src/vault/readers/claudeChildIds.ts (team branch, ~line 72)
- **evidence:** The `:team:` branch decodes any suffix; `parent:team:a:b` → `{teamName:"a:b"}` and `%3a` vs `%3A` alias to the same name. The formatter comment promises a canonical, colon-free encoding.
- **impact:** Same team resolves through multiple distinct entryIds → weakens the webview stale-guard / nested cache keying; violates the stated grammar contract.
- **suggestedFix:** After decode, require `encoded === encodeURIComponent(teamName)` (rejects raw `:`, non-canonical % case, empty).
- **status:** accepted · **triage:** Real contract gap, 1-line fix. Fix.

### W2 — Team-member predicate window differs between exclusion and grouping
- **severity:** WARN · **confidence:** HIGH · **priority:** P2 · **agent:** logic + contracts (merged L1+C3)
- **file:** src/vault/readers/claudeReader.ts (`parseClaudeFile` head-bounded vs `readTeamMemberInfo` scans to EOF)
- **evidence:** `parseClaudeFile` stops at first user+assistant; `readTeamMemberInfo` reads until it finds both agentName+firstMessage (EOF for a non-member). A session gaining agentName+teamName LATE could be listed (not excluded) AND grouped.
- **impact:** Possible double-appearance (top-level + nested); non-member siblings read to EOF (perf). Design D5 says the predicates MUST match.
- **suggestedFix:** Bound both to the identity record (first user record): membership = first user record carries both agentName+teamName. Stop `readTeamMemberInfo` at the first user record.
- **status:** accepted · **triage:** Honor D5 contract + bound the scan. Fix + consistency test.

### W3 — A member's own detail synthesizes its own team group (peer recursion)
- **severity:** WARN · **confidence:** HIGH · **priority:** P2 · **agent:** contracts (C1)
- **file:** src/vault/readers/claudeReader.ts (`readClaudeDetail` parent path always calls `listClaudeTeamStubs`)
- **evidence:** A non-lead member is still a resolvable `claude:<id>`; opened directly it collects its own teamName and lists its PEERS as a Team group → A→team→B→team→A nesting.
- **impact:** Drifts from spec "surfaced under their leader"; ambiguous ownership; confusing recursive expansion.
- **suggestedFix:** Detect if the current session is itself a non-lead member (first user record predicate, during the same stream) and skip `listClaudeTeamStubs` for it — team groups are leader-only.
- **status:** accepted · **triage:** Fix (gate the team scan on not-self-member).

### W4 — Synthetic group detail ignores `limit` → unbounded timeline over IPC
- **severity:** WARN · **confidence:** HIGH · **priority:** P3 · **agent:** contracts (C2)
- **file:** src/vault/readers/detail.ts (`synthesizeGroupDetail`); claudeReader.ts (`readClaudeChildDetail` doesn't pass `limit` to workflow/team branches)
- **evidence:** `synthesizeGroupDetail` maps every child into `timeline` with no bound; the detail channel is designed bounded (`boundTimeline`/`truncated`).
- **impact:** A workflow/team with very many children sends an arbitrarily large timeline over postMessage.
- **suggestedFix:** Thread `limit` into the workflow/team branches + `synthesizeGroupDetail`; apply `boundTimeline` + set `truncated`.
- **status:** accepted · **triage:** Fix (bound the synthetic timeline).

### W5 — Workflow manifest read has no size cap; runs per detail-open
- **severity:** WARN · **confidence:** MEDIUM · **priority:** P4 · **agent:** data-security (DS1)
- **file:** src/vault/readers/claudeReader.ts (`listClaudeWorkflowStubs` ~649, `readClaudeWorkflowDetail` ~518)
- **evidence:** `fs.readFile(wf_*.json, "utf8")` + `JSON.parse` with no size guard, once per manifest on each parent-detail open; transcripts use a bounded buffer but manifests don't.
- **impact:** Large/many manifests fully materialize + parse synchronously per open (perf/memory debt; local store, not a clear exploit).
- **suggestedFix:** `stat` + skip when over a cap (e.g. 2 MB) before `readFile`/`JSON.parse`.
- **status:** accepted · **triage:** Fix (cheap size guard).

## Verification question answers (summary)
- Path traversal: NONE — all 4 new resolvers validate id segments then `path.relative`-containment-check under `projectsDir`, matching `resolveClaudeSubagentPath`.
- Synthetic ids non-launchable: CONFIRMED — marker ids contain `:`, rejected by `isSafeSessionId` in the launch path.
- `coerceTimestamp`: correct for numeric-string / ISO / number / empty / garbage.
- Streams closed in `finally`; per-file failures isolated.
- `buildClaudeEntry` shape change propagated to both callers with no non-team regression.
- `synthesizeGroupDetail` satisfies the `VaultSessionDetail` interface; entryId echoed for nested routing.
- No session-derived value reaches a path/shell/HTML/SVG; text bounded before the textContent-only webview.

## Session IDs
- data-security: review-nest-workflow-team-sessions-data-security (a70325b47b4ab590c)
- logic: review-nest-workflow-team-sessions-logic (a92a2f889fd04d84f)
- contracts: review-nest-workflow-team-sessions-contracts (a9cb0e98492628f5d)
- frontend: not-spawned (webview unchanged)
