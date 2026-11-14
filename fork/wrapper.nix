# The wrapper around a T3 build: nixpkgs' own t3code wrapper recipe (the
# PATH additions and the resource-monitor default), made without its
# symlinkJoin. That join makes one link per file of the build, 82916 links
# that ext4 charges 377 MiB for. This one holds the wrapped programs in bin
# and links share whole, so the build itself is reached only through them.
# The arguments are that recipe's, so `.override` takes the same ones.
{
  lib,
  runCommand,
  makeBinaryWrapper,
  enableAzureDevOps ? false,
  azure-cli,
  azure-cli-extensions,
  enableBitbucket ? false,
  bitbucket-cli,
  enableClaude ? false,
  claude-code,
  enableCodex ? true,
  codex,
  enableCursor ? false,
  code-cursor,
  enableCursorCli ? false,
  cursor-cli,
  enableGitHub ? true,
  gh,
  enableGit ? true,
  git,
  enableGitLab ? false,
  glab,
  enableJujutsu ? false,
  jujutsu,
  enableOpencode ? false,
  opencode,
  enableResourceMonitor ? true,
  t3code-unwrapped,
  # Unlike nixpkgs' recipe this has no default made from t3code-unwrapped,
  # so `.override { t3code-unwrapped = ...; }` keeps the old monitor; pass
  # both, or make the packages again with the flake's lib.mkPackages.
  t3code-resource-monitor,
  # Extra makeWrapper arguments for one program, by its name in bin.
  extraWrapperArgs ? { },
}:

let
  runtimePackages =
    lib.optionals enableAzureDevOps [
      (azure-cli.withExtensions [ azure-cli-extensions.azure-devops ])
    ]
    ++ lib.optionals enableBitbucket [ bitbucket-cli ]
    ++ lib.optionals enableClaude [ claude-code ]
    ++ lib.optionals enableCodex [ codex ]
    ++ lib.optionals enableCursor [ code-cursor ]
    ++ lib.optionals enableCursorCli [ cursor-cli ]
    ++ lib.optionals enableGitHub [ gh ]
    ++ lib.optionals enableGit [ git ]
    ++ lib.optionals enableGitLab [ glab ]
    ++ lib.optionals enableJujutsu [ jujutsu ]
    ++ lib.optionals enableOpencode [ opencode ];

  # As in that recipe: the server checks T3CODE_RESOURCE_MONITOR_PATH before
  # any bundled location, and the desktop app's server child inherits it.
  wrapperArgs =
    lib.optionals (runtimePackages != [ ]) [
      "--prefix"
      "PATH"
      ":"
      (lib.makeBinPath runtimePackages)
    ]
    ++ lib.optionals enableResourceMonitor [
      "--set-default"
      "T3CODE_RESOURCE_MONITOR_PATH"
      (lib.getExe t3code-resource-monitor)
    ];

  wrapOne = name: ''
    makeWrapper ${t3code-unwrapped}/bin/${name} "$out"/bin/${name} --inherit-argv0 ${
      lib.escapeShellArgs (wrapperArgs ++ (extraWrapperArgs.${name} or [ ]))
    }
  '';
  # Named, not read from bin, which would build the app during evaluation.
  programs = t3code-unwrapped.passthru.programs or [
    "t3"
    "t3code-desktop"
  ];
in
runCommand "t3code-${t3code-unwrapped.version}"
  {
    pname = "t3code";
    inherit (t3code-unwrapped) version;
    nativeBuildInputs = [ makeBinaryWrapper ];

    passthru = {
      unwrapped = t3code-unwrapped;
      resourceMonitor = t3code-resource-monitor;
    }
    // t3code-unwrapped.passthru;

    meta = {
      inherit (t3code-unwrapped.meta)
        description
        homepage
        downloadPage
        changelog
        license
        maintainers
        mainProgram
        platforms
        ;
    };
  }
  ''
    mkdir -p "$out"/bin
    ${lib.concatMapStrings wrapOne programs}
    for p in ${t3code-unwrapped}/bin/*; do
      if [ ! -e "$out"/bin/"''${p##*/}" ]; then
        echo "not wrapped: $p; add it to programs" >&2
        exit 1
      fi
    done
    if [ -d ${t3code-unwrapped}/share ]; then
      ln -s ${t3code-unwrapped}/share "$out"/share
    fi
  ''
