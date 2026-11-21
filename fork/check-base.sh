#!/usr/bin/env bash
# Checks that fork/base.json describes the upstream release this branch sits
# on: its version is the newest stable upstream tag reachable from HEAD, and
# its pnpm deps hash was taken from the pnpm-lock.yaml checked out now. A
# stale pnpmDepsHash would let Nix reuse the old base's dependencies.
# Prints the version on success.
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(jq -r .version fork/base.json)"
lock_sha="$(jq -r .pnpmLockSha256 fork/base.json)"
# The fork holds only the tags upstream had when it was forked. The tag is
# fetched, not pushed: a pushed release tag would start upstream's release.yml.
if ! git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  git fetch --quiet --no-tags https://github.com/pingdotgg/t3code "refs/tags/v$version:refs/tags/v$version"
fi
tag="$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' HEAD)"
if [[ "$tag" != "v$version" ]]; then
  echo "fork/base.json says $version, but the newest release tag under HEAD is $tag." >&2
  echo "Set version to ${tag#v}, and pnpmDepsHash to the hash nix reports for the new lockfile." >&2
  exit 1
fi
actual_sha="$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)"
if [[ "$actual_sha" != "$lock_sha" ]]; then
  echo "pnpm-lock.yaml changed since pnpmDepsHash was taken (sha256 $actual_sha)." >&2
  echo "Set pnpmLockSha256 to it and pnpmDepsHash to lib.fakeHash, then take the hash nix reports." >&2
  exit 1
fi
echo "$version"
