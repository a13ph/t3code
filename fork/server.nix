# The headless server cut out of the full build: apps/server and only the
# packages it needs at run time (server-closure.py), without the desktop
# app, the other apps' packages or any dev tool. It copies from the full
# build, so it builds no JavaScript and takes the same source.
{
  lib,
  runCommand,
  python3,
  patchelf,
  makeBinaryWrapper,
  nodejs,
  t3code-unwrapped,
}:

runCommand "t3code-server-unwrapped-${t3code-unwrapped.version}"
  {
    inherit (t3code-unwrapped) version;
    nativeBuildInputs = [
      python3
      patchelf
      makeBinaryWrapper
    ];
    # Nothing of the full build may stay referenced, or a host that takes
    # the server downloads the whole desktop build again.
    disallowedReferences = [ t3code-unwrapped ];
    passthru = {
      inherit (t3code-unwrapped) src;
      full = t3code-unwrapped;
      # What wrapper.nix wraps.
      programs = [ "t3" ];
    };
    meta = t3code-unwrapped.meta // {
      description = "Headless T3 Code server";
      mainProgram = "t3";
    };
  }
  ''
    python3 -I ${./server-closure.py} \
      ${t3code-unwrapped}/libexec/t3code \
      ${t3code-unwrapped.src}/apps/server/package.json \
      "$out"/libexec/t3code

    # node-pty's pty.node keeps the full build's lib dir in its RUNPATH (the
    # full build skips patchelf). That dir does not exist; shrinking the
    # RUNPATH to the dirs that supply its libraries drops it.
    grep -rlF ${t3code-unwrapped} "$out" | while read -r f; do
      chmod u+w "$f"
      patchelf --shrink-rpath "$f"
    done

    makeWrapper ${lib.getExe nodejs} "$out"/bin/t3 \
      --add-flags "$out"/libexec/t3code/apps/server/dist/bin.mjs

    for d in bash-completion fish zsh; do
      if [ -d ${t3code-unwrapped}/share/"$d" ]; then
        mkdir -p "$out"/share
        cp -r --no-preserve=mode ${t3code-unwrapped}/share/"$d" "$out"/share/
      fi
    done
  ''
