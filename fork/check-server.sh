#!/usr/bin/env bash
# Checks a built T3 server before it is pushed to the cache.
#
# 1. Starts the shipped program (SERVER/bin/t3) and waits for it to serve
#    the web app on /.
# 2. Loads every package the server declares, with node-pty spawning a
#    shell and a keyring entry made, so the native addons the server loads
#    only on first use are loaded too.
# 3. Control: removes one package from a copy of the server and starts it.
#    It must fail to find that package, which shows the start check can
#    fail the way a package left out of the build would.
#
# Usage: fork/check-server.sh SERVER SERVER_UNWRAPPED NODE_BIN DROP_PACKAGE
#   SERVER            store path of the server output (the wrapper)
#   SERVER_UNWRAPPED  store path of the server-unwrapped output
#   NODE_BIN          the node binary the server runs on
#   DROP_PACKAGE      a .pnpm dir name prefix to remove, such as zod@
# Prints PASS or FAIL per check and exits non-zero unless all three pass.
set -euo pipefail

server=$1
unwrapped=$2
node=$3
drop=$4
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Runs the command after the tag and port until it serves the web app on /
# (it answers 503 while it starts), for at most 90 s. Prints "ready", or
# the last status code seen ("none" when nothing listened).
try_start() {
  local tag=$1 port=$2 code last=none pid
  shift 2
  mkdir -p "$work/$tag/base"
  "$@" serve --no-browser --host 127.0.0.1 --port "$port" \
    --base-dir "$work/$tag/base" > "$work/$tag.log" 2>&1 &
  pid=$!
  for _ in $(seq 90); do
    if ! kill -0 "$pid" 2> /dev/null; then
      break
    fi
    code=$(curl -s --max-time 5 -o "$work/$tag.body" -w '%{http_code}' \
      "http://127.0.0.1:$port/" || true)
    if [[ $code =~ ^[1-5][0-9][0-9]$ ]]; then
      last=$code
    fi
    if [[ $code == 200 ]] && grep -qi '<!doctype html' "$work/$tag.body"; then
      last=ready
      break
    fi
    sleep 1
  done
  kill "$pid" 2> /dev/null || true
  wait "$pid" 2> /dev/null || true
  echo "$last"
}

ok=1

code=$(try_start shipped 38731 "$server/bin/t3")
if [[ $code == ready ]]; then
  echo "PASS $server/bin/t3 serves the web app on /"
else
  echo "FAIL $server/bin/t3 answered '$code' on /; its log:"
  tail -n 40 "$work"/shipped.log
  ok=0
fi

if "$node" "$here"/check-server-deps.mjs "$unwrapped"/libexec/t3code; then
  echo "PASS every declared package loads"
else
  echo "FAIL a declared package does not load"
  ok=0
fi

cp -a "$unwrapped"/libexec/t3code "$work"/dropped
chmod -R u+w "$work"/dropped
shopt -s nullglob
victims=("$work/dropped/node_modules/.pnpm/$drop"*)
shopt -u nullglob
if [[ ${#victims[@]} -eq 0 ]]; then
  echo "FAIL control: no package matches $drop"
  ok=0
else
  rm -rf "${victims[@]}"
  code=$(try_start dropped 38732 "$node" "$work"/dropped/apps/server/dist/bin.mjs)
  # The package's name: .pnpm writes @scope/name as @scope+name.
  name=${drop%@}
  name=${name/+//}
  if [[ $code != ready ]] && grep -q 'MODULE_NOT_FOUND' "$work"/dropped.log &&
    grep -qF "'$name'" "$work"/dropped.log; then
    echo "PASS control: without ${victims[*]##*/} the server stops at start (last answer: $code)"
    grep -m 1 -F "'$name'" "$work"/dropped.log
  else
    echo "FAIL control: without $drop the server answered '$code', not a missing package; its log:"
    tail -n 20 "$work"/dropped.log
    ok=0
  fi
fi

[[ $ok == 1 ]]
