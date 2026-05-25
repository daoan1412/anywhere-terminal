---
topic: at-file-mentions-ai-coding-tools
created-by: research request for file-mention grammar across AI coding tools
date: 2026-05-24
libraries: [claude-code, codex, opencode, cursor, aider, continue, copilot-chat, cline, zed]
used-by: []
---

# Research: at-file-mentions-ai-coding-tools

## Answers
- **Claude Code CLI** — Prefix is `@`. Official docs show `@path/to/file` in `CLAUDE.md` imports and `@file1 @file2` in custom commands. Changelog proves `@` typeahead exists, supports symlinks, and had a spaces-in-path bug. Exact regex/grammar is **not published**; the practical rule is “`@` + path token until whitespace”. `@scope/pkg` and `user@host.com` are **not explicitly documented**; `@` is stripped when resolving imports, so it is not treated as literal path text.
- **OpenAI Codex CLI** — Prefix is `@` in the composer, plus `/mention <path>` as an alternate attach path. Docs say `@` opens fuzzy file search over the workspace root; issues show `@path` exists and Windows WSL/`/`-separator bugs. Exact grammar is **not published**; the picker is the source of truth, not a regex.
- **OpenCode** — Prefix is `@`. Docs show `@packages/functions/src/...` and state `@` fuzzy-searches files in-project. Paths are project-relative in examples. Exact delimiter grammar is **not published**.
- **Cursor** — Prefix is `@` for files, folders, web, codebase, docs. Docs show examples like `@auth.ts` / `@src/components/` and then `/` to go deeper after selecting a folder. Exact parser/regex is **not published**.
- **Aider** — No inline `@` file mention syntax in docs. File attachment is via CLI args or `/add <file>` / `/drop <file>`. Use `/add`, not `@`.
- **Continue.dev** — Context provider picker is opened with `@`, then you select providers like `@Codebase`, `@Folder`, and file provider entries from the dropdown. The current docs describe a dropdown workflow, not a literal `@file:foo.ts` grammar; I could not verify that exact colon syntax.
- **GitHub Copilot Chat** — Uses `#file:foo.ts` (and `#codebase`, etc.), not `@`. `#` introduces chat variables; docs do not publish a regex, just the variable picker model.
- **Cline / Roo Cline** — Prefix is `@/`. Docs show `@/path/to/file`, `@/path/to/folder/` (trailing slash), and multi-root `@workspace-name:/path/to/file`. Source shows paths with spaces are quoted on insert. Parser logic ignores `@` if followed by whitespace and avoids URL-ish text; mentions are inserted as `<file_content>`-style context blocks.
- **Zed AI assistant** — Raw editor trigger is `@`, but the persisted mention grammar is markdown link form: `[@file.txt](file:///abs/path)`. Source parses mentions by scanning the rightmost qualifying `@` (boundary: start/whitespace/`([{"`, and next char must be non-whitespace) and converts to markdown links.

## Recommended Approach
- For your detector, treat `@` as a **context-mention introducer**, not part of the path.
- Best cross-tool default: trigger on `@` only when it is at a token boundary, then consume a path-like token until whitespace / closing punctuation, while exempting obvious emails and `@scope/pkg` only if your UX wants npm-scope compatibility.
- If you want maximal compatibility with chat UIs, prefer the safer rule set used by Cline/Zed: boundary before `@`, non-whitespace after it, and quote/escape spaces when inserting.

## Confidence
- **Medium** — strong docs + issue/changelog evidence for behavior, but only some projects publish exact parsing code; several tools expose the grammar through UI pickers rather than regex.

## Gaps
- No official regex/grammar published for Claude Code, Codex CLI, OpenCode, Cursor, Continue, or Copilot Chat.
- Exact `@scope/pkg` vs email disambiguation is often implicit in the UI, not documented as formal grammar.

## Sources
- Claude Code: https://github.com/anthropics/claude-code/issues/990, https://github.com/anthropics/claude-code/issues/5231, https://github.com/anthropics/claude-code/issues/4040, https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- Codex: https://developers.openai.com/codex/cli, https://developers.openai.com/codex/cli/features, https://developers.openai.com/codex/cli/slash-commands, https://github.com/openai/codex/issues/19296, https://github.com/openai/codex/issues/6915
- OpenCode: https://opencode.ai/docs/, https://github.com/sst/opencode/issues/8223, https://github.com/sst/opencode/issues/13732
- Cursor: https://cursor.com/help/customization/context
- Aider: https://aider.chat/docs/usage.html
- Continue: https://docs.continue.dev/customize/custom-providers, https://docs.continue.dev/reference/deprecated-codebase, https://docs.continue.dev/guides/codebase-documentation-awareness
- Copilot: https://docs.github.com/en/copilot/reference/chat-cheat-sheet
- Cline: https://docs.cline.bot/features/at-mentions/overview, https://github.com/cline/cline/blob/main/webview-ui/src/utils/context-mentions.ts, https://github.com/cline/cline/blob/main/webview-ui/src/utils/__tests__/context-mentions.test.ts
- Zed: https://zed.dev/docs/ai/agent-panel, https://github.com/zed-industries/zed/blob/main/crates/agent_ui/src/completion_provider.rs, https://github.com/zed-industries/zed/blob/main/crates/agent_ui/src/message_editor.rs
