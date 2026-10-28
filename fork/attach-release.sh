#!/usr/bin/env bash
# Attaches files to the GitHub Release of this commit, making the Release
# first if no workflow has yet. Each fork workflow attaches its own artifacts
# to the same Release, so it ends up holding all of them.
# Usage: attach-release.sh <tag> <version> <file>...
set -euo pipefail
tag="$1"
version="$2"
shift 2
if ! gh release view "$tag" >/dev/null 2>&1; then
  notes="T3 Code $version with this fork's patches, built from $GITHUB_SHA on the fork-release branch."
  # A second workflow may make it between the check and here.
  gh release create "$tag" --target "$GITHUB_SHA" --title "T3 Code $version ($tag)" --notes "$notes" \
    || gh release view "$tag" >/dev/null
fi
gh release upload "$tag" --clobber "$@"
gh release view "$tag" --json assets --jq '.assets[] | "\(.name) \(.size)"'
