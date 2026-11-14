{
  description = "T3 Code fork: desktop and server packages for NixOS";

  # The nixpkgs revision supplies the recipe (pkgs/by-name/t3/t3code) and the
  # toolchain (electron, node, pnpm). Moving it changes every store path, so
  # machines that take these packages download them again from the cache.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/c59305bab2065cfecc4944690d9eedbb56f3a9fa";
  # Only pnpm comes from here, for a release that needs a newer one than the
  # nixpkgs above ships.
  inputs.nixpkgs-pnpm.url = "github:NixOS/nixpkgs/31ecbaca1bdefa45dffc409f0250bd8039ea0010";

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-pnpm,
    }:
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

      # The recipe's pnpm and Node, matched to the `packageManager` and
      # `engines.node` of the release in base.json. pnpm before 12.9 fails to
      # apply a patch that deletes a file without its old text (dbus-next's).
      pnpm = nixpkgs-pnpm.legacyPackages.${system}.pnpm_12;
      nodejs = pkgs.nodejs_26;

      recipe = pkgs.t3code.unwrapped.override {
        pnpm_11 = pnpm;
        inherit nodejs;
      };

      unwrapped = recipe.overrideAttrs (
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
            inherit pnpm;
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
      # The packages made from one full build. Exposed as lib.mkPackages, so
      # a caller that rebuilds `unwrapped` (with another src) gets the same
      # wrappers and server cut from this flake's nixpkgs.
      mkPackages =
        full:
        let
          # nixpkgs' resource monitor, the sidecar its wrapper points at.
          resourceMonitor = (pkgs.t3code.override { t3code-unwrapped = full; }).resourceMonitor;
          serverUnwrapped = pkgs.callPackage ./fork/server.nix {
            inherit nodejs;
            t3code-unwrapped = full;
          };
          wrap =
            u: args:
            pkgs.callPackage ./fork/wrapper.nix (
              {
                t3code-unwrapped = u;
                t3code-resource-monitor = resourceMonitor;
              }
              // args
            );
        in
        {
          inherit serverUnwrapped;
          desktop = wrap full { };
          server = wrap serverUnwrapped { enableCodex = false; };
        };
      built = mkPackages unwrapped;
    in
    {
      lib.mkPackages = mkPackages;

      packages.${system} = {
        # The desktop app and its bundled server, with the Codex CLI on PATH
        # as nixpkgs ships it.
        desktop = built.desktop;
        # A headless `t3` server, without Codex: apps/server and the
        # packages it needs at run time, cut out of the same build.
        server = built.server;
        server-unwrapped = built.serverUnwrapped;
        # The node binary the server runs on, for CI's start check.
        server-node = nodejs;
        # The t3-keeper modules the server spawns Claude through when
        # T3_KEEPER_SOCKET is set, for a keeper service run beside it.
        t3-keeper-src = pkgs.runCommand "t3-keeper-src-${base.version}" { } ''
          install -D -m 644 -t "$out/src" ${./apps/server/src/t3Keeper}/*.mjs
        '';
        default = self.packages.${system}.desktop;
      };
    };
}
