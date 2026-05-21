# Proposal: fix-open-file-path-resolution

## Why

Clickable file paths in the terminal fail to open in two everyday cases: (1) clicking a relative path whose first segment matches the PTY cwd's last segment (e.g. cwd `/x/y/a` + click `a/file.md` — file is at `/x/y/a/file.md`, but the join produces `/x/y/a/a/file.md`); and (2) clicking absolute paths that the user reports as plain ASCII (root cause unclear from static analysis — needs runtime reproduction).

## Appetite

M (≤3d). The fix ports the VS Code resolver algorithm (`updateLinkWithRelativeCwd`), broadens detection to VS Code parity, adds tilde + `file://` URI handling in the resolver, and adds a basename fallback in `findFiles`. Bigger than a one-day bugfix because it touches both detection and resolver layers and requires new unit + integration tests against worked examples.

## Scope

### In scope

- Port VS Code's `updateLinkWithRelativeCwd` reverse-segment algorithm into a `resolveCwdRelative(cwd, link)` helper that returns an ordered candidate list.
- Apply the fan-out per cwd source (`liveCwd`, `currentCwd`, `initialCwd`, each `workspaceFolder`) in `buildCandidates`.
- Broaden `filePathParser` bare/suffixed pathBody to accept characters VS Code's parser accepts: spaces (when quoted), `()`, `#`, `&`, non-ASCII, `~`. Keep `looksLikeFile` + URL rejection + version-string filter.
- Add tilde expansion in resolver (`~/foo` → `<os.homedir()>/foo`).
- Add `file://` URI handling in resolver — when path starts with `file:///`, decode percent-encoding and treat as absolute.
- Add basename fallback in `findFiles` step — when `<path>` contains a separator and the full glob yields 0 matches, retry with `escapeGlob(basename(path))`, then filter results whose `fsPath` ends with `<path>` (using OS-appropriate separator).
- Defensive: if `fileStat.type` reports `Directory` bit set (including symlink-to-directory), treat as directory and fall through.
- Add unit + integration tests for: cwd-suffix duplication, absolute paths, tilde, `file://`, basename fallback, symlink-to-directory.

### Out of scope

- Capability-aware per-line cwd (VS Code's `getCwdForLine(y)`). Our PTY tracking gives session-wide cwd only; per-line history would require a separate change.
- Caching resolved URIs (VS Code caches for 10s). Premature without measurement.
- New IPC message fields. The existing `{ path, sessionId, line, col }` shape is sufficient.
- Reworking the out-of-scope modal trust boundary (`currentCwd` still intentionally excluded from trust-bases).
- VS Code's broader detector parity for non-file links (URLs, etc.) — handled by `WebLinksAddon`.

## Capabilities

1. **terminal-clickable-file-paths** — extends path resolution with VS Code parity fan-out, tilde expansion, `file://` URI handling, and basename fallback. Broadens detection regex.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES (more clicks succeed; previously-failing clicks now resolve)
- **E2E required?** NOT REQUIRED (the project lists no E2E command; integration tests run via Vitest under `pnpm run test:unit`)
- **Justification**: The behavioural change is observable through unit + integration tests against the resolver and parser. Manual smoke test ("click a path in the terminal") covers the user-facing flow once tests pass.

## Risk Level

MEDIUM — security-sensitive (path resolution gates filesystem opens), and detection regex broadening risks false-positive underlines. Mitigations land in `design.md` Risk Map.
