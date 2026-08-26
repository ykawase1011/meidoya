#!/usr/bin/env node
import net from "node:net";

function port(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a TCP port`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65535) throw new Error(`${name} must be between 1 and 65535`);
  return parsed;
}

export function normalizePeer(address) {
  return address?.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

export function isLimaForwardedPeer(address) {
  const peer = normalizePeer(address);
  return peer === "127.0.0.1" || peer === "::1";
}

const listenHost = process.env.MEIDOYA_LIMA_PROXY_HOST ?? "0.0.0.0";
const listenPort = port("MEIDOYA_LIMA_PROXY_PORT", 17233);
const targetHost = process.env.MEIDOYA_TEMPORAL_HOST ?? "127.0.0.1";
const targetPort = port("MEIDOYA_TEMPORAL_PORT", 7233);

const server = net.createServer((client) => {
  if (!isLimaForwardedPeer(client.remoteAddress)) {
    client.destroy();
    return;
  }

  const upstream = net.createConnection({ host: targetHost, port: targetPort });
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on("error", (error) => {
  process.stderr.write(`Lima Temporal proxy failed: ${String(error)}\n`);
  process.exitCode = 1;
});

server.listen({ host: listenHost, port: listenPort }, () => {
  process.stdout.write(
    `Lima Temporal proxy ${listenHost}:${String(listenPort)} -> ${targetHost}:${String(targetPort)}\n`,
  );
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
