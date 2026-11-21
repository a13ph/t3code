# Fork release builds

Each `fork-release-<version>` branch is an upstream release tag with
this fork's `public/*` branches merged on top, plus the files that
build it. A push to any `fork-release*` branch runs the workflows:

- `flake.nix`: the `desktop`, `server` (no Codex) and `t3-keeper-src`
  packages for NixOS, from nixpkgs' T3 Code recipe.
- `.github/workflows/fork-nix.yml`: builds them and pushes them to the
  `a13ph-t3code` Cachix cache.
- `.github/workflows/fork-android.yml`: the signed arm64 APK.
- `.github/workflows/fork-windows.yml`: the unsigned Windows x64
  installer, packaged by upstream's `release-desktop.yml`.

The APK and the installer go to one GitHub Release per commit of the
branch, tagged `t3-<version>-<commit>`.

# Moving to a new upstream release

1. Make a new `fork-release-<version>` branch from the new tag and
   merge the rebased `public/*` branches onto it.
2. Bring this commit's files over.
3. In `fork/base.json`, set `version` to the tag without its `v`, and
   `pnpmLockSha256` to the `sha256sum` of `pnpm-lock.yaml`.
4. When the release moves pnpm or Node in `package.json`
   (`packageManager`, `engines.node`), move `pnpm` and `nodejs` in
   `flake.nix` with it. pnpm may come from the newer `nixpkgs-pnpm`
   input when the main nixpkgs ships too old a one.
5. Set `pnpmDepsHash` to `lib.fakeHash`'s value, run
   `nix build .#desktop`, and take the hash it reports.

`fork/check-base.sh` runs first in every workflow. It fails when
`base.json` does not match the tag or the lockfile.
