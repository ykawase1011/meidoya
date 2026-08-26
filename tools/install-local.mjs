import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDirectory = path.resolve(
  process.env.MEIDOYA_BIN_DIR ?? path.join(os.homedir(), ".local", "bin"),
);

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const launchers = {
  meidoya: path.join(root, "apps", "meidoya", "dist", "main.js"),
  meidoyad: path.join(root, "apps", "meidoyad", "dist", "main.js"),
  "meidoya-node": path.join(root, "apps", "meidoya-node", "dist", "main.js"),
};

mkdirSync(binDirectory, { recursive: true });
for (const [name, script] of Object.entries(launchers)) {
  const launcher = path.join(binDirectory, name);
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(launcher, 0o755);
  process.stdout.write(`installed ${launcher}\n`);
}

if (!(process.env.PATH ?? "").split(path.delimiter).includes(binDirectory)) {
  process.stdout.write(`add ${binDirectory} to PATH to use the commands globally\n`);
}
