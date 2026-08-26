#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { installSafeTemporalRuntime } from "@meidoya/temporal-logging";
import { loadControlPlaneConfig, resolveControlPlaneConfig } from "./config.js";
import { startDaemon } from "./daemon.js";
import { createControlPlaneRuntimes } from "./runtimes.js";

const DEFAULT_CONFIG = path.join(os.homedir(), ".config", "meidoya", "config.yaml");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    process.stdout.write(
      [
        "meidoyad — Meidoya Control Plane daemon",
        "",
        "  --config <path>   config.yaml (default ~/.config/meidoya/config.yaml)",
        "",
        "Verification (plan quality gates) runs on an execution node, inside its",
        "sandbox — never on this host. Start meidoya-node on a machine bound to",
        "the workspace; a verify step with no node stays queued until one is up.",
        "",
      ].join("\n"),
    );
    return;
  }

  installSafeTemporalRuntime();
  const configFile = values.config ?? process.env["MEIDOYA_CONFIG"] ?? DEFAULT_CONFIG;
  const config = resolveControlPlaneConfig(loadControlPlaneConfig(configFile));
  const daemon = await startDaemon({
    config,
    ...(config.modelMapping === undefined
      ? {}
      : { agentRuntimes: createControlPlaneRuntimes(process.env) }),
  });

  process.stdout.write(`meidoyad listening on ${daemon.socketPath}\n`);
  if (daemon.nodeTcpAddress !== undefined) {
    process.stdout.write(`meidoyad node transport on ${daemon.nodeTcpAddress}\n`);
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`meidoyad shutting down (${signal})\n`);
    void daemon.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`shutdown failed: ${String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Node 22 terminates the process on an unhandled rejection. The control plane
  // is multi-tenant: one workspace's request must not be able to end every
  // other workspace's daemon, and a death with no line in the log is the worst
  // version of that. Individual request paths handle their own failures (see
  // ControlPlaneServer#handle); this is the floor under them, so an escape is
  // loud and survivable rather than silent and fatal.
  // An uncaughtException is NOT swallowed here: the process state after one is
  // unknown, and continuing on it is the more dangerous choice.
  process.on("unhandledRejection", (reason: unknown) => {
    process.stderr.write(
      `meidoyad: unhandled rejection, the daemon is staying up: ${String(reason)}\n`,
    );
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`meidoyad failed to start: ${String(error)}\n`);
  process.exitCode = 1;
});
