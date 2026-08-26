import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { FakeChatTransport } from "@meidoya/chat-core";
import { ControlPlaneClient } from "meidoya";
import { parseControlPlaneConfig, resolveControlPlaneConfig } from "../config.js";
import { startDaemon, type StartedDaemon } from "../daemon.js";
import { ScriptedAgentPort, type ScriptedAgentOptions } from "./scripted-agent.js";

/**
 * Address of the time-skipping test server. Each daemon and node opens its own
 * connection to it: a shared NativeConnection would be torn down with the first
 * worker that shuts down, which is exactly what the restart test exercises.
 */
export function temporalAddress(env: TestWorkflowEnvironment): string {
  const address = (env.connection as unknown as { options?: { address?: string } }).options
    ?.address;
  if (address === undefined) throw new Error("test workflow environment exposes no address");
  return address;
}

export type TestGateModes = {
  clarification?: "never" | "when-needed" | "always";
  plan?: "never" | "on-risk" | "always";
  review?: "never" | "on-findings" | "before-complete" | "always";
  side_effect?: "policy" | "always";
};

export type TestWorkspaceOptions = {
  project?: string;
  default_pipeline?: "quick" | "research" | "coding" | "scheduled" | "cross-workspace";
  human_gates?: TestGateModes;
  /** The mandatory security floor (06 section 2). */
  mandatory_gates?: TestGateModes;
  /** Operator quality gates; defaults to one gate named `test` that passes. */
  quality_gates?: { name: string; command: string }[];
  limits?: Record<string, string | number>;
};

/**
 * A quality gate that really runs and really succeeds in a scratch data dir.
 * Tests and the demo must exercise the passing path of verification, not the
 * accident of `npm test` failing outside a package.
 */
export const PASSING_QUALITY_GATE = `${process.execPath} --version`;

/**
 * A quality gate that really runs and really FAILS, for the loop-limit
 * scenarios. It carries its own gate NAME (`FAILING_QUALITY_GATE_NAME`) because
 * the execution node justifies an incoming argv against its own configured
 * allowlist by name (10 section 6): one name can stand for exactly one argv, so
 * the failing gate cannot share `test` with the passing one.
 */
export const FAILING_QUALITY_GATE = `${process.execPath} --no-such-flag`;
export const FAILING_QUALITY_GATE_NAME = "typecheck";

const DEFAULT_GATES: Required<TestGateModes> = {
  clarification: "never",
  plan: "always",
  review: "never",
  side_effect: "policy",
};

function gatesBlock(key: string, gates: TestGateModes, indent: string): string {
  const entries = Object.entries(gates).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  const rows = entries.map(([k, v]) => `${indent}  ${k}: ${String(v)}`).join("\n");
  return `${indent}${key}:\n${rows}\n`;
}

function workspaceBlock(workspaceId: string, options: TestWorkspaceOptions): string {
  const project = options.project ?? `${workspaceId}-project`;
  const gates = { ...DEFAULT_GATES, ...options.human_gates };
  const qualityGates = options.quality_gates ?? [
    { name: "test", command: PASSING_QUALITY_GATE },
  ];
  const limits = options.limits ?? {};
  return (
    `  ${workspaceId}:\n` +
    `    ingress:\n      cli:\n        profile: ${workspaceId}\n` +
    `    projects:\n      ${project}:\n        workspace_ref: ${project}\n` +
    `    execution:\n      preferred_profile: lima-trusted\n` +
    `    request_policy:\n      quick_soft_deadline: 20s\n` +
    `      default_pipeline: ${options.default_pipeline ?? "coding"}\n` +
    gatesBlock("human_gates", gates, "    ") +
    (options.mandatory_gates === undefined
      ? ""
      : `    security_policy:\n${gatesBlock("mandatory_gates", options.mandatory_gates, "      ")}`) +
    (Object.keys(limits).length === 0
      ? ""
      : `    limits:\n${Object.entries(limits)
          .map(([k, v]) => `      ${k}: ${String(v)}`)
          .join("\n")}\n`) +
    `    quality_gates:\n      commands:\n` +
    qualityGates
      .map((gate) => `        - name: ${gate.name}\n          command: ${gate.command}\n`)
      .join("")
  );
}

export const DEFAULT_TEST_WORKSPACES: Record<string, TestWorkspaceOptions> = {
  "work-grammarxiv": { project: "grammarxiv" },
  "work-it": { project: "product-a" },
};

export function testConfigYaml(
  dataDir: string,
  temporalAddress = "127.0.0.1:7233",
  workspaces: Record<string, TestWorkspaceOptions> = DEFAULT_TEST_WORKSPACES,
): string {
  const ids = Object.keys(workspaces);
  return `schema_version: 1

environment:
  id: test-env
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
${Object.entries(workspaces)
  .map(([id, options]) => workspaceBlock(id, options))
  .join("")}
nodes:
  mac-main:
    profiles: [lima-trusted]
    capabilities: [repo.read, repo.write, shell]
    workspaces: [${ids.join(", ")}]
    max_concurrency: 2
`;
}

export function makeDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "meidoya-test-"));
}

export type TestDaemon = StartedDaemon & {
  agents: ScriptedAgentPort;
  transport: FakeChatTransport;
};

/** Boots a daemon against the injected time-skipping Temporal environment. */
export async function startTestDaemon(options: {
  env: TestWorkflowEnvironment;
  dataDir: string;
  agent?: ScriptedAgentOptions;
  agents?: ScriptedAgentPort;
  workspaces?: Record<string, TestWorkspaceOptions>;
  /** Long by default so a test can tell the startup sweep from the timer. */
  checkpointReconcileIntervalMs?: number;
}): Promise<TestDaemon> {
  const configFile = path.join(options.dataDir, "config.yaml");
  const yaml = testConfigYaml(
    options.dataDir,
    temporalAddress(options.env),
    options.workspaces ?? DEFAULT_TEST_WORKSPACES,
  );
  writeFileSync(configFile, yaml);
  const config = resolveControlPlaneConfig(parseControlPlaneConfig(yaml));

  const agents = options.agents ?? new ScriptedAgentPort(options.agent ?? {});
  const transport = new FakeChatTransport();
  const daemon = await startDaemon({
    config,
    agents,
    chatTransport: transport,
    statusIntervalMs: 60_000,
    checkpointReconcileIntervalMs: options.checkpointReconcileIntervalMs ?? 60_000,
    outboxIntervalMs: 200,
    // The time-skipping test server never advances past a sticky workflow task
    // left behind by a stopped worker, so tests run without the sticky cache.
    maxCachedWorkflows: 0,
  });
  return Object.assign(daemon, { agents, transport });
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.what ?? "condition"}`);
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 100));
  }
}

/* ---------------------------------------------------- control-plane client */

export type TaskDetail = {
  taskId: string;
  status: string;
  openCheckpoint?: { checkpointId: string; kind: string };
};

export async function cliSession(
  daemon: TestDaemon,
  profile: string,
): Promise<{ client: ControlPlaneClient; workspaceId: string }> {
  const client = await ControlPlaneClient.connect(daemon.socketPath);
  const session = await client.hello(profile);
  await client.subscribe();
  return { client, workspaceId: session.workspaceId };
}

export async function submitTask(client: ControlPlaneClient, summary: string): Promise<string> {
  const created = (await client.scoped("task.create", {
    title: summary.slice(0, 40),
    intent: { summary, projects: [], origin: "cli" },
  })) as { task: { taskId: string } };
  return created.task.taskId;
}

export async function getTask(client: ControlPlaneClient, taskId: string): Promise<TaskDetail> {
  return (await client.scoped("task.get", { taskId })) as TaskDetail;
}

export async function waitForCheckpoint(
  client: ControlPlaneClient,
  taskId: string,
  options: { kind?: string; notId?: string; timeoutMs?: number } = {},
): Promise<{ checkpointId: string; kind: string }> {
  return waitFor(
    async () => {
      const open = (await getTask(client, taskId)).openCheckpoint;
      if (open === undefined) return undefined;
      if (options.kind !== undefined && open.kind !== options.kind) return undefined;
      if (options.notId !== undefined && open.checkpointId === options.notId) return undefined;
      return open;
    },
    {
      what: `${options.kind ?? "an"} open checkpoint on ${taskId}`,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  );
}

export async function waitForTaskStatus(
  client: ControlPlaneClient,
  taskId: string,
  status: string,
  options: { timeoutMs?: number } = {},
): Promise<TaskDetail> {
  let seen = "unknown";
  try {
    return await waitFor(
      async () => {
        const task = await getTask(client, taskId);
        seen = task.status;
        return task.status === status ? task : undefined;
      },
      {
        what: `${taskId} to reach ${status}`,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
    );
  } catch (error) {
    throw new Error(`${(error as Error).message} (last status: ${seen})`);
  }
}

export async function answerCheckpoint(
  client: ControlPlaneClient,
  checkpointId: string,
  decision: "approve" | "reject" = "approve",
): Promise<void> {
  const checkpoint = (await client.scoped("checkpoint.get", { checkpointId })) as {
    version: number;
  };
  await client.scoped("checkpoint.answer", {
    checkpointId,
    decision,
    expectedVersion: checkpoint.version,
  });
}

/**
 * Answers a checkpoint that expects a choice rather than an approval
 * (clarification, limit-exceeded). The choice id also travels as the answer
 * text, which is what reaches the workflow.
 */
export async function chooseCheckpoint(
  client: ControlPlaneClient,
  checkpointId: string,
  choiceId: string,
): Promise<void> {
  const checkpoint = (await client.scoped("checkpoint.get", { checkpointId })) as {
    version: number;
  };
  await client.scoped("checkpoint.answer", {
    checkpointId,
    decision: "answer",
    choiceId,
    answer: choiceId,
    expectedVersion: checkpoint.version,
  });
}

/** Checkpoint kinds recorded for a task, oldest first. Read straight from SQLite. */
export function checkpointKinds(daemon: TestDaemon, taskId: string): string[] {
  return (
    daemon.db
      .prepare("SELECT kind FROM checkpoints WHERE task_id = ? ORDER BY created_at, rowid")
      .all(taskId) as { kind: string }[]
  ).map((row) => row.kind);
}
