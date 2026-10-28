{
  description = "T3 Code fork: desktop and server packages for NixOS";

  # The nixpkgs revision supplies the recipe (pkgs/by-name/t3/t3code) and the
  # toolchain (electron, node, pnpm). Moving it changes every store path, so
  # machines that take these packages download them again from the cache.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/c59305bab2065cfecc4944690d9eedbb56f3a9fa";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      inherit (pkgs) lib;
      base = lib.importJSON ./fork/base.json;

      # The build files of this fork stay out of the source, so a workflow
      # edit does not rebuild T3.
      src = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.difference ./. (
          lib.fileset.unions [
            ./.github
            ./fork
            ./flake.nix
            ./flake.lock
          ]
        );
      };

      unwrapped = pkgs.t3code.unwrapped.overrideAttrs (
        final: prev: {
          inherit (base) version;
          inherit src;
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (final)
              pname
              version
              src
              pnpmWorkspaces
              ;
            pnpm = pkgs.pnpm_11;
            fetcherVersion = 4;
            hash = base.pnpmDepsHash;
          };
          # node-pty 1.2 ships a linux-x64 prebuild, so its install script
          # skips node-gyp. The prebuild cannot find libstdc++ (the recipe
          # sets dontPatchELF), the server exits at start and the desktop
          # window never opens. Without the linux prebuilds node-pty compiles
          # into build/Release, linked against this stdenv's libstdc++.
          preBuild = ''
            rm -rf node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/linux-*
          ''
          + prev.preBuild;
        }
      );
    in
    {
      packages.${system} = {
        # The desktop app and its bundled server, with the Codex CLI on PATH
        # as nixpkgs ships it.
        desktop = pkgs.t3code.override { t3code-unwrapped = unwrapped; };
        # The same build for a headless `t3` server, without Codex.
        server = pkgs.t3code.override {
          t3code-unwrapped = unwrapped;
          enableCodex = false;
        };
        # The t3-keeper modules the server spawns Claude through when
        # T3_KEEPER_SOCKET is set, for a keeper service run beside it.
        t3-keeper-src = pkgs.runCommand "t3-keeper-src-${base.version}" { } ''
          install -D -m 644 -t "$out/src" ${./apps/server/src/t3Keeper}/*.mjs
        '';
        default = self.packages.${system}.desktop;
      };
    };
}
