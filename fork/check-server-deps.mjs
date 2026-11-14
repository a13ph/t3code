// Loads every package the server declares, as the server would find it,
// and uses the native addons the server loads only on first use.
// Usage: node fork/check-server-deps.mjs <libexec/t3code dir of the server>
// Prints one line per package and exits non-zero when any fails to load.
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const nm = join(root, "apps", "server", "node_modules");
const require = createRequire(join(root, "apps", "server", "dist", "bin.mjs"));

const names = [];
for (const e of readdirSync(nm)) {
  if (e.startsWith(".")) continue;
  if (e.startsWith("@")) {
    for (const s of readdirSync(join(nm, e))) names.push(`${e}/${s}`);
  } else {
    names.push(e);
  }
}

let failed = 0;
for (const name of names.sort()) {
  try {
    require(name);
    console.log(`ok   ${name}`);
  } catch (err) {
    // A package with no main entry point (only subpath exports) is found
    // but cannot be loaded by its bare name; that is not a missing one.
    if (err.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      console.log(`ok   ${name} (subpath exports only)`);
      continue;
    }
    console.log(`FAIL ${name}: ${err.code ?? ""} ${err.message.split("\n")[0]}`);
    failed++;
  }
}

try {
  const pty = require("node-pty");
  const p = pty.spawn("/bin/sh", ["-c", "exit 0"], {});
  const code = await new Promise((resolve) => p.onExit((e) => resolve(e.exitCode)));
  if (code !== 0) throw new Error(`shell exited ${code}`);
  console.log("ok   node-pty spawned a shell");
} catch (err) {
  console.log(`FAIL node-pty: ${err.message}`);
  failed++;
}

try {
  const { Entry } = require("@napi-rs/keyring");
  new Entry("t3code-check", "nobody");
  console.log("ok   @napi-rs/keyring made an entry");
} catch (err) {
  console.log(`FAIL @napi-rs/keyring: ${err.message}`);
  failed++;
}

process.exit(failed ? 1 : 0);
