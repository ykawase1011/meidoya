import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const config = process.env.MEIDOYA_CONFIG ?? path.join(home, ".config", "meidoya", "config.yaml");
const nodeConfig =
  process.env.MEIDOYA_NODE_CONFIG ?? path.join(home, ".config", "meidoya", "node.yaml");
const daemonMain = path.join(root, "apps", "meidoyad", "dist", "main.js");
const nodeMain = path.join(root, "apps", "meidoya-node", "dist", "main.js");

for (const file of [
  daemonMain,
  nodeMain,
  config,
  nodeConfig,
]) {
  if (!existsSync(file)) {
    process.stderr.write(`local start prerequisite is missing: ${file}\n`);
    process.exit(1);
  }
}

const { loadControlPlaneConfig, resolveControlPlaneConfig } = await import(
  path.join(root, "apps", "meidoyad", "dist", "config.js")
);
const { nodeCredentialFilePath } = await import(
  path.join(root, "apps", "meidoyad", "dist", "client-credentials.js")
);
const { loadNodeConfig } = await import(path.join(root, "apps", "meidoya-node", "dist", "node.js"));
const controlConfig = resolveControlPlaneConfig(loadControlPlaneConfig(config));
const executionConfig = loadNodeConfig(nodeConfig);
const socket = process.env.MEIDOYA_SOCKET ?? controlConfig.socketPath;
const nodeTokenFile =
  process.env.MEIDOYA_NODE_TOKEN_FILE ??
  nodeCredentialFilePath(controlConfig.dataDir, executionConfig.config.node.id);
const nodeEnv = { ...process.env, MEIDOYA_NODE_TOKEN_FILE: nodeTokenFile };
if (controlConfig.modelMapping !== undefined) {
  for (const provider of ["codex", "claude"]) {
    for (const profile of ["high", "standard", "economy"]) {
      const key = `MEIDOYA_MODEL_${provider.toUpperCase()}_${profile.toUpperCase()}`;
      nodeEnv[key] ??= controlConfig.modelMapping[provider][profile];
    }
  }
}

const children = new Set();
let shuttingDown = false;

function start(name, script, args, env = process.env) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  child.meidoyaName = name;
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(
      `${name} exited (${signal ?? String(code ?? 1)}); stopping the local stack processes\n`,
    );
    for (const running of children) running.kill("SIGTERM");
    process.exitCode = code === 0 ? 1 : (code ?? 1);
  });
  return child;
}

async function waitForSocket(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socket)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`control-plane socket did not appear within ${String(timeoutMs)}ms: ${socket}`);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`stopping Meidoya processes (${signal})\n`);
  for (const child of children) child.kill("SIGTERM");
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const daemon = start("meidoyad", daemonMain, ["--config", config]);

try {
  await waitForSocket();
  start("meidoya-node", nodeMain, ["--config", nodeConfig], nodeEnv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  daemon.kill("SIGTERM");
  process.exitCode = 1;
}
