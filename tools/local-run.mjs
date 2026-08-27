import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
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
let temporalMonitor;

function stopChildren() {
  if (temporalMonitor !== undefined) {
    clearInterval(temporalMonitor);
    temporalMonitor = undefined;
  }
  for (const child of children) child.kill("SIGTERM");
}

function startCommand(name, command, args, env = process.env) {
  const child = spawn(command, args, {
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
    stopChildren();
    process.exitCode = code === 0 ? 1 : (code ?? 1);
  });
  child.once("error", (error) => {
    process.stderr.write(`${name} failed to start: ${error.message}\n`);
  });
  return child;
}

function start(name, script, args, env = process.env) {
  return startCommand(name, process.execPath, [script, ...args], env);
}

function temporalEndpoint(address) {
  const separator = address.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const host = address.slice(0, separator).replace(/^\[|\]$/g, "");
  const port = Number(address.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { host, port };
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

async function waitForPort(host, port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Temporal did not become available within ${String(timeoutMs)}ms: ${host}:${String(port)}`,
  );
}

async function startLocalTemporal(endpoint) {
  const temporalBin = process.env.MEIDOYA_TEMPORAL_BIN ?? "temporal";
  const database = process.env.MEIDOYA_TEMPORAL_DB ?? path.join(controlConfig.dataDir, "temporal.db");
  process.stdout.write(
    `Temporal is unavailable at ${controlConfig.temporal.address}; starting a local server\n`,
  );
  startCommand("temporal", temporalBin, [
    "server",
    "start-dev",
    "--ip",
    endpoint.host,
    "--port",
    String(endpoint.port),
    "--ui-port",
    process.env.MEIDOYA_TEMPORAL_UI_PORT ?? "8080",
    "--db-filename",
    database,
  ]);
  await waitForPort(endpoint.host, endpoint.port);
}

async function ensureLocalTemporal() {
  if (process.env.MEIDOYA_MANAGE_LOCAL_TEMPORAL === "0") return undefined;
  const endpoint = temporalEndpoint(controlConfig.temporal.address);
  if (endpoint === undefined) return undefined;
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(endpoint.host)) return undefined;
  if (!(await canConnect(endpoint.host, endpoint.port))) await startLocalTemporal(endpoint);
  return endpoint;
}

function monitorLocalTemporal(endpoint) {
  let checking = false;
  temporalMonitor = setInterval(async () => {
    if (shuttingDown || checking) return;
    checking = true;
    try {
      if (!(await canConnect(endpoint.host, endpoint.port))) {
        await startLocalTemporal(endpoint);
      }
    } catch (error) {
      process.stderr.write(
        `local Temporal recovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      checking = false;
    }
  }, 5_000);
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
  stopChildren();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  const localTemporal = await ensureLocalTemporal();
  if (localTemporal !== undefined) monitorLocalTemporal(localTemporal);
  const daemon = start("meidoyad", daemonMain, ["--config", config]);
  await waitForSocket();
  start("meidoya-node", nodeMain, ["--config", nodeConfig], nodeEnv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  shuttingDown = true;
  stopChildren();
  process.exitCode = 1;
}
