# Discovery: redesign-vault-panel-ui

Goal: redesign the AI Vault webview panel to match `docs/research/vault.html`, and replace the placeholder codicon agent badges with real brand icons.

## Workstreams

| Workstream | Status | Source |
|---|---|---|
| Memory recall | done | `asm memory search` — archived change `260529-0303-add-ai-coding-vault` |
| Architecture snapshot (current vault) | done | finder subagent |
| Real agent icons | done | explore subagent + direct reads of warp/opencode SVGs |
| External research | n/a | no new library/API needed — all changes are internal webview + small host commands |

## Current implementation (what exists today)

- **Host layer** `src/vault/`: `VaultService.list()` aggregates 3 per-agent readers → `VaultListResult { entries, unreadable }`. `registry.ts` holds data-driven agent records (id, displayName, detect, sessionStore, resume/fork templates). `VaultLauncher` + `LaunchBuilder` build resume/fork specs.
- **Readers** stop early: `claudeReader` streams jsonl, reads only first user msg (title) + first assistant msg (model); `codexReader`/`opencodeReader` query SQLite for id/title/cwd/model/updated. **No per-session detail / transcript is read.**
- **Entry shape** `VaultSessionEntry` (`src/vault/types.ts:75`): `id, agent, sessionId, title (≤120 chars), cwd, modified(ms), flags{model,permissionMode,approval,sandbox,reasoningEffort,agent}, canFork`.
- **IPC** `src/types/messages.ts:332-349,820-823`: `requestVaultSessions` → `vaultSessionsResponse`; `vaultResume` / `vaultFork` (entryId = `<agent>:<sessionId>`).
- **Host handlers** `src/providers/TerminalViewProvider.ts:320-374`: list + launch (spawns terminal via `sessionManager.createSession`).
- **Webview** `src/webview/vault/VaultPanel.ts` (render: flat list, badge=codicon, title, cwd, relative time, resume + conditional fork; client-side search; "this folder only"; empty + N-unreadable notice) and `src/webview/vault/vaultPanel.css`.
- Vault is a **collapsible section stacked above the file tree** (design D11), composed in `src/webview/main.ts`.

## Real agent icons (verified, ready to lift)

All three exist as **single-path, monochrome SVGs** → inline in webview, normalize to `fill="currentColor"` so each inherits its badge accent (matches mockup's per-agent oklch accents).

| Agent | Source file | viewBox | fill | Action |
|---|---|---|---|---|
| Claude | `…/warp/app/assets/bundled/svg/claude.svg` | `0 0 24 24` | `#FF0000` | → `currentColor` |
| Codex (OpenAI) | `…/opencode/packages/ui/src/assets/icons/provider/openai.svg` | `0 0 40 40` | `currentColor` | use as-is |
| OpenCode | `…/warp/app/assets/bundled/svg/opencode.svg` | `0 0 24 24` | `#FF0000` | → `currentColor` |

(cmux ships only raster PNGs in `Assets.xcassets`; warp/opencode SVGs are the usable source. Logos are brand glyphs used nominatively to identify each agent — note attribution, not a blocker.)

## Mockup features vs. current state (gap analysis)

| Mockup feature | Exists? | Layer | Notes |
|---|---|---|---|
| Real agent icons in badge | ✗ (codicons today) | webview + assets | inline currentColor SVGs |
| Single-line row: badge \| title \| cwd-chip \| time | partial | webview | re-layout to CSS grid per mockup |
| Grouping modes: Recent / Agent / Folder | ✗ (flat only) | webview | pure client-side over loaded list; folder mode = collapsible groups, cwd dropped from rows |
| Hover/focus icon-only Resume overlay | partial | webview | gradient fade overlay |
| **Fork removed from UI** | fork shown today | webview (+spec) | mockup renders no fork; registry/launcher fork capability stays |
| Right-click row context menu | ✗ | webview + host | Resume in New Tab, Open, Reveal in Finder, Copy File Path, Copy Resume Command, Open Working Directory |
| Unreadable-sessions notice w/ "Details" | partial (count exists) | webview | restyle to tinted inline notice |
| Empty / no-match states | exists | webview | restyle to match mockup |
| **Floating preview overlay** (first prompt, recent activity timeline of tool/subagent calls, latest assistant msg, activity stats) | ✗ | **host + IPC + readers + webview** | needs NEW per-agent transcript/detail reader; renders message bodies |

## Key tension — preview pane reverses a prior decision

The archived MVP design explicitly chose **"read only metadata … never render message bodies"** (discovery §5 of `260529-0303-add-ai-coding-vault`). The mockup's preview pane renders message bodies: first prompt text, tool-call args (file paths, bash commands), subagent prompts, and the latest assistant reply, plus computed stats (msg/token/tool/subagent counts).

This is the one part of the mockup that:
- adds a **new host capability** (per-agent transcript/detail reader — fragile, format differs per agent: jsonl tail for Claude, SQLite message tables for Codex/OpenCode),
- adds a **new IPC contract** (request session detail → detail response),
- **reverses the metadata-only scoping** (mild privacy weight — it is the user's own local data shown back to the same user; the real cost is parsing fragility + scope).

Everything else in the mockup is webview re-layout plus a handful of small host commands for context-menu items.

## Options

| Option | Scope | Layers touched | Appetite | Risk |
|---|---|---|---|---|
| **A — Full mockup** | All visual changes **+ content preview overlay** (transcript read) | webview + IPC + new per-agent detail readers + host | L (~1.5–2w) | MED — fragile per-agent transcript parsing; reverses metadata-only |
| **B — Visual redesign only (Recommended)** | Real icons, grid rows, 3 grouping modes, hover-resume, fork removal, context menu, notice/empty/no-match. **No preview overlay.** | webview + small host commands | M (~2–3d) | LOW — no data-layer change |
| **C — Visual redesign + metadata details card** | Everything in B, plus a preview overlay that shows only **already-available metadata** (full first-prompt/title, full cwd, modified, agent, model/permission/branch) — no transcript "recent activity"/"latest message" sections | webview + small host commands | M–L (~3–4d) | LOW — no new reader; deviates from mockup's content sections |

Recommendation: **B now** (delivers the entire visual redesign + real icons + interactions with no fragile data work), and treat the content-rich preview (A's delta) as a clean fast-follow change once the shell is in place. C is the compromise if a preview overlay is wanted immediately without transcript parsing.

## Risks

- **R1** Per-agent transcript parsing (only in A) is fragile and format-divergent → highest source of breakage.
- **R2** Fork removal is a behavior + spec change (`vault-panel` spec currently mandates fork action) → must update spec.
- **R3** Context-menu host commands (reveal in finder / open wd / copy resume command / open file) need new IPC messages + handlers.
- **R4** Inlined brand SVGs must be sanitized/static (no remote refs) and themable via `currentColor`.

## Open questions (Gate 1)

1. **Preview pane scope** — A (full transcript preview), B (no preview), or C (metadata-only details card)?
2. Confirm **fork removed from the row UI** (capability retained in registry) — matches mockup.
