# Releasing

Single atomic command — `scripts/release.sh` bumps, verifies, commits, tags, publishes, and pushes. It refuses to run on a dirty tree, on a duplicate tag, or without a matching `CHANGELOG.md` entry, so you can't half-release.

## Steps

1. **Write the CHANGELOG entry first.** Open `CHANGELOG.md` and add a section header with the version you're about to release. The header must match `## [X.Y.Z]` exactly — the script greps for it:

   ```markdown
   ## [0.9.0] — 2026-MM-DD

   ### Added
   - ...

   ### Fixed
   - ...
   ```

2. **Commit anything pending.** The script refuses to run if `git status` is not clean.

   ```bash
   git add -A && git commit -m "feat: ..."
   ```

3. **Run the release.** The version is an explicit argument — no `npm version minor` auto-bump, no surprises.

   ```bash
   pnpm release 0.9.0              # publish to VSCE + Open VSX (default)
   pnpm release 0.9.0 vsce         # publish only to VSCE
   pnpm release 0.9.0 ovsx         # publish only to Open VSX
   ```

   The script will, in order:
   1. Validate the version format and refuse if tag `v0.9.0` already exists.
   2. Verify the CHANGELOG section is present.
   3. Bump `package.json` (only if it isn't already at the target version).
   4. Run `pnpm check-types`, `pnpm test:unit`, `pnpm package`.
   5. Commit `package.json + CHANGELOG.md` as `chore: release v0.9.0` and create the `v0.9.0` tag.
   6. Build the VSIX and publish to the chosen marketplace(s).
   7. Push the release commit and the tag (only after publish succeeds, so a failed publish does not leave a dangling remote tag).

## If something fails mid-release

- **Pre-publish failures** (typecheck, tests, build) — fix locally and re-run. Nothing was committed yet (the commit happens after build passes).
- **Publish failure after commit/tag** — the commit and tag exist locally but were not pushed yet. Either re-run the script (it will skip the bump since the version already matches) or `git reset --hard HEAD~1 && git tag -d v0.9.0` to undo and start over.
- **Already pushed but only one marketplace published** — re-run with the marketplace-specific target (`pnpm release 0.9.0 ovsx`) to fill the gap.

## Don't do this

- Don't manually run `vsce publish` or `ovsx publish` without going through the script — you'll skip the CHANGELOG/tag/commit guarantees.
- Don't manually edit the `version` field in `package.json` and then run the release script unless you pass the exact same version as the argument. The script will detect the mismatch via the CHANGELOG check, but it's clearer to leave the bump to the script.
