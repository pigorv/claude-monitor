#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/release.sh <patch|minor|major|x.y.z>
#
# Bumps the version in package.json, creates a git tag, and pushes
# both the commit and tag to origin. The tag push triggers the
# release workflow which publishes to npm.

if [ $# -ne 1 ]; then
  echo "Usage: $0 <patch|minor|major|x.y.z>" >&2
  exit 1
fi

version_arg="$1"

# Ensure working tree is clean
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: Working tree is dirty. Commit or stash changes first." >&2
  exit 1
fi

# Ensure we're on main
branch="$(git branch --show-current)"
if [ "$branch" != "main" ]; then
  echo "Error: Releases must be made from the main branch (currently on '$branch')." >&2
  exit 1
fi

# Pull latest to avoid divergence
git pull --ff-only origin main

# Check that CHANGELOG.md has an [Unreleased] section with content
unreleased_content="$(awk '/^## \[Unreleased\]/{found=1;next} /^## \[/{found=0} found && NF' CHANGELOG.md || true)"
if [ -z "$unreleased_content" ]; then
  echo "Error: CHANGELOG.md has no entries under [Unreleased]." >&2
  echo "Add your changes to the [Unreleased] section before releasing." >&2
  exit 1
fi

# Determine the new version (peek at what npm version would produce)
new_version="$(npm version --no-git-tag-version "$version_arg" | tr -d 'v')"
# Revert the package.json change — we'll let npm version do it properly below
git checkout -- package.json package-lock.json 2>/dev/null || git checkout -- package.json

# Update CHANGELOG.md: rename [Unreleased] section to the new version
today="$(date +%Y-%m-%d)"
sed -i '' "s/^## \[Unreleased\]/## [Unreleased]\\
\\
## [$new_version] - $today/" CHANGELOG.md

# Stage the changelog update
git add CHANGELOG.md

# npm version creates the commit (including staged changelog) and tag
npm version "$version_arg" --force

# Push the commit and the tag
git push origin main --follow-tags

echo ""
echo "Released v${new_version}"
echo "The release workflow will publish to npm shortly."
echo "Track it at: https://github.com/pigorv/claude-monitor/actions"
