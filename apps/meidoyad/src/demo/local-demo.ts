#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { startTimeSkippingEnv } from "@meidoya/temporal-test-env";
import { FakeChatTransport } from "@meidoya/chat-core";
import { installSafeTemporalRuntime } from "@meidoya/temporal-logging";
import { parseControlPlaneConfig, resolveControlPlaneConfig } from "../config.js";
import { startDaemon } from "../daemon.js";
import { ScriptedAgentPort } from "../testing/scripted-agent.js";
import { startTestNode } from "../testing/node-harness.js";
import { PASSING_QUALITY_GATE, temporalAddress } from "../testing/harness.js";

const require = createRequire(import.meta.url);

export function demoConfigYaml(dataDir: string, temporalAddress: string): string {
  return `schema_version: 1

environment:
  id: local-demo
  timezone: UTC
  data_dir: ${dataDir}

control_plane:
  listen:
    unix_socket: ${path.join(dataDir, "meidoya.sock")}
  sqlite:
    path: ${path.join(dataDir, "meidoya.sqlite")}
  temporal:
    address: ${temporalAddress}
    namespace: default
    control_task_queue: meidoya/control

workspaces:
  work-grammarxiv:
    ingress:
      cli:
        profile: work-grammarxiv
    projects:
      grammarxiv:
        workspace_ref: grammarxiv
    request_policy:
      quick_soft_deadline: 20s
      default_pipeline: coding
    human_gates:
      clarification: never
      plan: always
      review: never
      side_effect: policy
    # The operator owns every argv that can reach a process (10 section 2).
    # The demo's data dir is a scratch directory with no package.json, so its
    # gate is one that genuinely runs and genuinely passes there.
    quality_gates:
      commands:
        - name: test
          command: ${PASSING_QUALITY_GATE}

nodes:
  mac-main:
    profiles: [mac-restricted]
    capabilities: [repo.read, repo.write, shell, test]
    workspaces: [work-grammarxiv]
    max_concurrency: 2
`;
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * One-command offline vertical slice: CLI -> Maid -> Manager -> Worker with a
 * plan gate answered on stdin. No Codex/Claude binary, no chat token, no
 * external Temporal server.
 */
export async function runLocalDemo(): Promise<number> {
  installSafeTemporalRuntime();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "meidoya-demo-"));
  log(`data dir: ${dataDir}`);

  log("starting time-skipping Temporal test environment…");
  const env = await startTimeSkippingEnv();

  const configFile = path.join(dataDir, "config.yaml");
  writeFileSync(configFile, demoConfigYaml(dataDir, temporalAddress(env)));
  const config = resolveControlPlaneConfig(parseControlPlaneConfig(readFileSync(configFile, "utf8")));

  const agents = new ScriptedAgentPort();
  const transport = new FakeChatTransport();

  const daemon = await startDaemon({
    config,
    agents,
    chatTransport: transport,
    statusIntervalMs: 500,
  });
  log(`meidoyad listening on ${daemon.socketPath}`);

  const node = await startTestNode({
    dataDir,
    temporalAddress: temporalAddress(env),
    workspaces: ["work-grammarxiv"],
  });
  log(`meidoya-node ${node.nodeId} registered for ${node.grantedWorkspaces.join(", ")}`);

  const cliEntry = require.resolve("meidoya/dist/main.js");
  const exitCode = await runCli(cliEntry, daemon.socketPath, dataDir);

  const tasks = daemon.repository.listTasks("work-grammarxiv", { limit: 10 });
  const task = tasks[0];
  log("");
  log(`tasks: ${tasks.map((t) => `${t.id}=${t.status}`).join(", ")}`);
  log(`control-plane agent invocations: ${agents.invocations.length} (all offline)`);
  log(`node worker runs: ${node.runtime.requests.length} in ${node.runtime.workdirs.join(", ")}`);
  log(`chat transport calls: ${transport.calls.length}`);
  daemon.status.projectOnce();
  log(`STATUS.md: ${daemon.status.filePath}`);

  await node.stop();
  await daemon.stop();
  await env.teardown();

  if (task?.status !== "completed" || exitCode !== 0) {
    log(`demo FAILED (cli exit ${exitCode}, task ${task?.status ?? "missing"})`);
    return 1;
  }
  log("demo OK: task completed through a plan gate");
  rmSync(dataDir, { recursive: true, force: true });
  return 0;
}

/** Drives the real CLI binary, answering the plan gate with `A` on stdin. */
function runCli(cliEntry: string, socketPath: string, dataDir: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(
      process.execPath,
      [cliEntry, "submit", "Add a README section describing the demo"],
      {
        stdio: ["pipe", "pipe", "inherit"],
        env: {
          ...process.env,
          MEIDOYA_SOCKET: socketPath,
          MEIDOYA_PROFILE: "work-grammarxiv",
          MEIDOYA_DATA_DIR: dataDir,
        },
      },
    );
    let answered = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      process.stdout.write(chunk);
      if (!answered && chunk.includes("is waiting for")) {
        answered = true;
        child.stdin.write("A\n");
      }
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry).endsWith(path.join("demo", "local-demo.js"))) {
  runLocalDemo().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`demo failed: ${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
