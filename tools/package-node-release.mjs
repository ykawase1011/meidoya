#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return path.resolve(value);
}

function copy(source, destination) {
  if (!existsSync(source)) throw new Error(`release input is missing: ${source}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
}

if (process.platform !== "linux" || process.arch !== "arm64") {
  throw new Error("meidoya-node release artifacts must be packaged on Linux arm64");
}

const vendor = argument("--vendor");
const output = argument("--output");
const nodeRoot = path.dirname(path.dirname(process.execPath));
const scratch = mkdtempSync(path.join(os.tmpdir(), "meidoya-node-release-"));
const payload = path.join(scratch, "payload");
const archive = path.join(scratch, "payload.tar.gz");

try {
  copy(nodeRoot, path.join(payload, "node"));
  copy(vendor, path.join(payload, "vendor"));
  copy(path.join(root, "node_modules"), path.join(payload, "meidoya", "node_modules"));

  const nodeApp = path.join(root, "apps", "meidoya-node");
  for (const name of ["package.json", "dist", "node_modules"]) {
    copy(path.join(nodeApp, name), path.join(payload, "meidoya", "apps", "meidoya-node", name));
  }

  for (const entry of readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(root, "packages", entry.name);
    if (!existsSync(path.join(packageRoot, "dist"))) continue;
    for (const name of ["package.json", "dist", "node_modules"]) {
      const source = path.join(packageRoot, name);
      if (existsSync(source)) {
        copy(source, path.join(payload, "meidoya", "packages", entry.name, name));
      }
    }
  }

  execFileSync("tar", ["-czf", archive, "-C", payload, "."], { stdio: "inherit" });
  const archiveBytes = readFileSync(archive);
  const payloadSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const header = `#!/bin/sh
set -eu
state_dir=\${STATE_DIRECTORY:-/var/lib/meidoya-node}
runtime="$state_dir/runtime-${payloadSha256}"
if [ ! -f "$runtime/.ready" ]; then
  temporary="$state_dir/runtime-${payloadSha256}.new.$$"
  mkdir -p "$temporary"
  payload_line=$(awk '/^__MEIDOYA_PAYLOAD__$/ { print NR + 1; exit }' "$0")
  tail -n +"$payload_line" "$0" | gzip -dc | tar -xf - -C "$temporary"
  printf '%s\\n' '${payloadSha256}' > "$temporary/.ready"
  mv "$temporary" "$runtime"
fi
export PATH="$runtime/node/bin:$runtime/vendor/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export MEIDOYA_CODEX_BIN="$runtime/vendor/node_modules/.bin/codex"
export MEIDOYA_CLAUDE_BIN="$runtime/vendor/node_modules/.bin/claude"
if [ "\${1:-}" = "--runtime-probe" ]; then
  case "\${2:-}" in
    codex) test -x "$MEIDOYA_CODEX_BIN" ;;
    claude) test -x "$MEIDOYA_CLAUDE_BIN" ;;
    *) exit 64 ;;
  esac
  exit 0
fi
exec "$runtime/node/bin/node" "$runtime/meidoya/apps/meidoya-node/dist/main.js" "$@"
__MEIDOYA_PAYLOAD__
`;
  writeFileSync(output, Buffer.concat([Buffer.from(header, "utf8"), archiveBytes]), { mode: 0o755 });
  chmodSync(output, 0o755);
  process.stdout.write(
    `${JSON.stringify({ output, bytes: statSync(output).size, payloadSha256 })}\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
