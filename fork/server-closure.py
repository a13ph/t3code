#!/usr/bin/env python3
# Copy the server app and only the packages it needs at run time.
#
# Usage: server-closure.py SRC_ROOT PACKAGE_JSON DST_ROOT
#        server-closure.py --dry SRC_ROOT PACKAGE_JSON
#
# SRC_ROOT is libexec/t3code of the full build, PACKAGE_JSON the server's
# package.json from the source. The packages copied are the server's
# `dependencies` and `optionalDependencies`, then every package they depend
# on, followed through pnpm's layout: a package at
# node_modules/.pnpm/<id>/node_modules/<name> has its own dependencies as
# the other entries of .pnpm/<id>/node_modules. Dev dependencies and the
# packages of the other apps stay out. Workspace packages are bundled into
# dist, so they are skipped.
#
# Prints one line per package copied and a total. Exits non-zero when a
# dependency the server declares is missing from the build.
import json
import os
import shutil
import sys

M = 1048576


def deps_of(package_json):
    with open(package_json) as f:
        d = json.load(f)
    wanted, optional = [], set()
    for field in ("dependencies", "optionalDependencies"):
        for name, spec in (d.get(field) or {}).items():
            if spec.startswith("workspace:"):
                continue
            wanted.append(name)
            if field == "optionalDependencies":
                optional.add(name)
    return wanted, optional


def entries(nm):
    # Package entries of a node_modules dir, scoped ones expanded.
    out = []
    if not os.path.isdir(nm):
        return out
    for e in sorted(os.listdir(nm)):
        if e.startswith("."):
            continue
        p = os.path.join(nm, e)
        if e.startswith("@") and not os.path.islink(p):
            out += [os.path.join(p, s) for s in sorted(os.listdir(p))]
        else:
            out.append(p)
    return out


def pnpm_id(real, pnpm_real):
    rel = os.path.relpath(real, pnpm_real)
    if rel.startswith(".."):
        return None
    return rel.split("/")[0]


def size(d):
    t = 0
    for r, _, fs in os.walk(d):
        for f in fs:
            p = os.path.join(r, f)
            if not os.path.islink(p):
                t += os.lstat(p).st_size
    return t


def main(argv):
    dry = argv[:1] == ["--dry"]
    if dry:
        argv = argv[1:]
    src, package_json = argv[0], argv[1]
    dst = None if dry else argv[2]
    pnpm = os.path.join(src, "node_modules", ".pnpm")
    pnpm_real = os.path.realpath(pnpm)
    server_nm = os.path.join(src, "apps", "server", "node_modules")

    wanted, optional = deps_of(package_json)
    ids, missing, todo = set(), [], []
    for name in wanted:
        link = os.path.join(server_nm, name)
        if not os.path.exists(link):
            if name not in optional:
                missing.append(name)
            continue
        todo.append(os.path.realpath(link))
    if missing:
        print("MISSING declared dependencies: " + " ".join(missing))
        return 1

    while todo:
        real = todo.pop()
        i = pnpm_id(real, pnpm_real)
        if i is None:
            print(f"OUTSIDE .pnpm: {real}")
            return 1
        if i in ids:
            continue
        ids.add(i)
        for sib in entries(os.path.join(pnpm, i, "node_modules")):
            if os.path.exists(sib):
                todo.append(os.path.realpath(sib))

    total = 0
    for i in sorted(ids):
        s = size(os.path.join(pnpm, i))
        total += s
        print(f"{s / M:8.1f} MiB  {i}")
    dist = size(os.path.join(src, "apps", "server", "dist"))
    print(f"{dist / M:8.1f} MiB  apps/server/dist")
    print(f"{(total + dist) / M:8.1f} MiB  total, {len(ids)} packages")
    if dry:
        return 0

    # Packages, with their sibling links as they are.
    os.makedirs(os.path.join(dst, "node_modules", ".pnpm"))
    for i in sorted(ids):
        shutil.copytree(
            os.path.join(pnpm, i),
            os.path.join(dst, "node_modules", ".pnpm", i),
            symlinks=True,
        )
    # pnpm's hidden hoisting dir, which lets a package find one it uses
    # without declaring it, cut down to the packages copied.
    hoist = os.path.join(pnpm, "node_modules")
    for link in entries(hoist):
        if not os.path.islink(link):
            continue
        if pnpm_id(os.path.realpath(link), pnpm_real) in ids:
            rel = os.path.relpath(link, hoist)
            out = os.path.join(dst, "node_modules", ".pnpm", "node_modules", rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            os.symlink(os.readlink(link), out)
    # The server app: its bundle and the links to its declared packages.
    shutil.copytree(
        os.path.join(src, "apps", "server", "dist"),
        os.path.join(dst, "apps", "server", "dist"),
        symlinks=True,
    )
    for name in wanted:
        link = os.path.join(server_nm, name)
        if not os.path.lexists(link):
            continue
        out = os.path.join(dst, "apps", "server", "node_modules", name)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        os.symlink(os.readlink(link), out)
    dangling = [
        os.path.join(r, n)
        for r, ds, fs in os.walk(dst)
        for n in ds + fs
        if os.path.islink(os.path.join(r, n)) and not os.path.exists(os.path.join(r, n))
    ]
    if dangling:
        print("DANGLING links: " + " ".join(dangling[:20]))
        return 1
    return 0



if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
