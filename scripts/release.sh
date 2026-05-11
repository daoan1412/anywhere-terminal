#!/usr/bin/env bash
# scripts/release.sh — atomic release: bump → verify → commit → tag → publish → push
#
# Usage:
#   bash scripts/release.sh <version>          # publish to both VSCE + OVSX
#   bash scripts/release.sh <version> vsce     # publish only to VSCE
#   bash scripts/release.sh <version> ovsx     # publish only to OVSX
#
# Preconditions:
#   - Working tree is clean (no uncommitted changes)
#   - CHANGELOG.md contains a "## [<version>]" entry for the version being released
#   - Version is a valid semver in the form X.Y.Z

set -euo pipefail

VERSION="${1:-}"
TARGET="${2:-both}"

if [[ -z "$VERSION" ]]; then
  echo "error: version is required" >&2
  echo "usage: bash scripts/release.sh <version> [both|vsce|ovsx]" >&2
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be X.Y.Z (got: $VERSION)" >&2
  exit 1
fi

if [[ "$TARGET" != "both" && "$TARGET" != "vsce" && "$TARGET" != "ovsx" ]]; then
  echo "error: target must be 'both', 'vsce', or 'ovsx' (got: $TARGET)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 1. Refuse to run on a dirty working tree.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean — commit or stash first" >&2
  git status --short >&2
  exit 1
fi

# 2. Refuse to overwrite an existing tag.
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "error: tag v$VERSION already exists" >&2
  exit 1
fi

# 3. CHANGELOG must already describe this version.
if ! grep -qE "^## \[$VERSION\]" CHANGELOG.md; then
  echo "error: CHANGELOG.md is missing a '## [$VERSION]' section" >&2
  echo "       add the release notes for $VERSION before running this script" >&2
  exit 1
fi

# 4. Bump package.json without touching git.
CURRENT_VERSION=$(node -p "require('./package.json').version")
if [[ "$CURRENT_VERSION" == "$VERSION" ]]; then
  echo "info: package.json already at $VERSION — skipping bump"
else
  echo "info: bumping $CURRENT_VERSION → $VERSION"
  npm version "$VERSION" --no-git-tag-version >/dev/null
fi

# 5. Verify build before publishing anything.
echo "info: running typecheck + tests + package build"
pnpm check-types
pnpm test:unit
pnpm package

# 6. Commit the bumped package.json + CHANGELOG together.
git add package.json CHANGELOG.md
git commit -m "chore: release v$VERSION"
git tag "v$VERSION"

# 7. Package the VSIX.
rm -f anywhere-terminal-*.vsix
vsce package --no-dependencies
VSIX="anywhere-terminal-$VERSION.vsix"
if [[ ! -f "$VSIX" ]]; then
  echo "error: expected $VSIX but it was not produced" >&2
  exit 1
fi

# 8. Publish to the chosen target(s).
if [[ "$TARGET" == "both" || "$TARGET" == "vsce" ]]; then
  echo "info: publishing $VSIX to VSCE marketplace"
  vsce publish --packagePath "$VSIX"
fi
if [[ "$TARGET" == "both" || "$TARGET" == "ovsx" ]]; then
  echo "info: publishing $VSIX to Open VSX"
  ovsx publish "$VSIX"
fi

# 9. Push commit + tag last, so a failed publish doesn't leave a dangling tag remote.
echo "info: pushing commit + tag"
git push
git push origin "v$VERSION"

echo "done: released v$VERSION"
