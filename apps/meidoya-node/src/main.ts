#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { installSafeTemporalRuntime } from "@meidoya/temporal-logging";
import { loadNodeConfig, startNode } from "./node.js";

const DEFAULT_CONFIG = path.join(os.homedir(), ".config", "meidoya", "node.yaml");

/**
 * The full CLI surface. Node identity and the control-plane address are
 * config-file concerns (see `node.yaml` / node.example.yaml), not flags: that
 * keeps them out of `ps` output and keeps secrets and paths out of the
 * process listing. Exported so the parsing contract can be asserted directly
 * (including by meidoya-yashiki, which provisions this binary and must agree
 * with this exact interface) instead of being re-implemented in a test.
 */
export const CLI_OPTIONS = {
  config: { type: "string", short: "c" },
  help: { type: "boolean", short: "h", default: false },
} as const;

export function parseCliArgs(argv: readonly string[]): { config?: string; help: boolean } {
  const { values } = parseArgs({ args: [...argv], options: CLI_OPTIONS, allowPositionals: false });
  return values;
}

async function main(): Promise<void> {
  const values = parseCliArgs(process.argv.slice(2));

  if (values.help === true) {
    process.stdout.write(
      [
        "meidoya-node — Meidoya Execution Node daemon",
        "",
        `  --config <path>   node.yaml (default ${DEFAULT_CONFIG})`,
        "",
      ].join("\n"),
    );
    return;
  }

  installSafeTemporalRuntime();
  const configFile = values.config ?? process.env["MEIDOYA_NODE_CONFIG"] ?? DEFAULT_CONFIG;
  const node = await startNode({ resolved: loadNodeConfig(configFile) });
  process.stdout.write(`meidoya-node ${node.nodeId} on ${node.taskQueue}\n`);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`meidoya-node draining (${signal})\n`);
    void node.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`shutdown failed: ${String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stderr.write(`meidoya-node failed to start: ${String(error)}\n`);
  process.exitCode = 1;
});
