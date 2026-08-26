#!/usr/bin/env node
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ControlPlaneClient, ControlPlaneClientError, DEFAULT_SOCKET_PATH } from "./client.js";
import { readSessionCredential } from "./credentials.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { initializeLocalConfig } from "./init.js";
import { openDatabaseForAdmin } from "@meidoya/store-sqlite";
import { runLatchCommand } from "./latch.js";
import {
  attachToTask,
  checkpointVersion,
  stdinReader,
  type TaskDetail,
} from "./checkpoint.js";

const USAGE = `meidoya — Meidoya CLI

  meidoya init --project <path> [--workspace <id>] [--node <id>] [--provider codex|claude] [--codex-model <name>] [--force]
  meidoya doctor [--config <path>] [--node-config <path>] [--temporal <host:port>] [--profile <p>] [--json]
  meidoya submit "<request>" [--title <t>] [--pipeline <p>] [--project <id>...] [--target <workspace>...] [--detach]
  meidoya task list [--status <s>...] [--limit <n>]
  meidoya task get <taskId>
  meidoya task watch <taskId>
  meidoya task answer <taskId> --checkpoint <cp> "<answer>"
  meidoya task cancel <taskId> [--reason <r>]
  meidoya schedule add "<natural-language instruction>" [--project <id>...] [--detach]
  meidoya schedule create --name <n> --cron "<expr>" --summary "<s>" [--timezone <tz>] [--enabled]
  meidoya schedule list
  meidoya schedule pause|resume|run-now|delete <scheduleId>
  meidoya status
  meidoya admin revoke [--profile <p>] [--all] [--disable]
  meidoya admin latch list --db <path> [--json]
  meidoya admin latch release --db <path> --checkpoint <id> [--apply] [--force]

The workspace comes from this client's ingress binding profile (MEIDOYA_PROFILE),
never from a command-line flag.

The profile is only a claim: the session credential the daemon provisioned for
it (0600, under <data dir>/clients) is what proves it.

Environment:
  MEIDOYA_CONFIG           Control Plane config (default ~/.config/meidoya/config.yaml)
  MEIDOYA_NODE_CONFIG      Execution node config (default ~/.config/meidoya/node.yaml)
  MEIDOYA_TEMPORAL_ADDRESS Temporal address used by doctor (default 127.0.0.1:7233)
  MEIDOYA_SOCKET           Control Plane unix socket (default ${DEFAULT_SOCKET_PATH})
  MEIDOYA_PROFILE          CLI ingress profile selecting the bound workspace
  MEIDOYA_CREDENTIALS_DIR  Directory holding <profile>.secret (default <socket dir>/clients)
  MEIDOYA_CLIENT_SECRET    The session credential itself, instead of a file
`;

type Options = Record<string, string | boolean | string[] | undefined>;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function formatTask(task: {
  taskId: string;
  title: string;
  status: string;
  pipeline: string;
}): string {
  return `${task.taskId}  ${task.status.padEnd(24)} ${task.pipeline.padEnd(10)} ${task.title}`;
}

async function connect(): Promise<ControlPlaneClient> {
  const socketPath = process.env["MEIDOYA_SOCKET"] ?? DEFAULT_SOCKET_PATH;
  const client = await ControlPlaneClient.connect(socketPath);
  await client.hello(process.env["MEIDOYA_PROFILE"]);
  return client;
}

/* ---------------------------------------------------------------- commands */

async function cmdSubmit(
  positionals: string[],
  values: Options,
  interpretation: "auto" | "schedule" = "auto",
): Promise<TaskDetail | undefined> {
  const request = positionals[0];
  if (request === undefined || request.trim() === "") {
    throw new Error('submit requires a request: meidoya submit "<request>"');
  }
  const client = await connect();
  try {
    await client.subscribe();
    const projects = (values["project"] as string[] | undefined) ?? [];
    const targetWorkspaceIds = values["target"] as string[] | undefined;
    const created = (await client.scoped("task.create", {
      title: (values["title"] as string | undefined) ?? request.slice(0, 72),
      intent: { summary: request, projects, origin: "cli" },
      interpretation,
      ...(values["pipeline"] === undefined ? {} : { pipeline: values["pipeline"] as string }),
      ...(targetWorkspaceIds === undefined ? {} : { targetWorkspaceIds }),
    })) as { task: { taskId: string; status: string }; temporalWorkflowId: string };

    out(`submitted ${created.task.taskId}`);
    if (values["detach"] === true) {
      out(`follow with: meidoya task watch ${created.task.taskId}`);
      return undefined;
    }

    const reader = stdinReader();
    try {
      const task = await attachToTask({
        client,
        taskId: created.task.taskId,
        reader,
        interactive: true,
      });
      out(`task ${task.taskId} finished: ${task.status}`);
      return task;
    } finally {
      reader.close();
    }
  } finally {
    client.close();
  }
}

async function cmdTask(positionals: string[], values: Options): Promise<void> {
  const sub = positionals[0];
  const client = await connect();
  try {
    switch (sub) {
      case "list": {
        const status = values["status"] as string[] | undefined;
        const result = (await client.scoped("task.list", {
          ...(status === undefined || status.length === 0 ? {} : { status }),
          ...(values["limit"] === undefined ? {} : { limit: Number(values["limit"]) }),
        })) as { tasks: { taskId: string; title: string; status: string; pipeline: string }[] };
        if (result.tasks.length === 0) out("no tasks");
        for (const task of result.tasks) out(formatTask(task));
        return;
      }
      case "get": {
        const taskId = requireArg(positionals[1], "task get <taskId>");
        const task = (await client.scoped("task.get", { taskId })) as TaskDetail;
        out(formatTask(task));
        out(`  intent: ${task.intentSummary}`);
        if (task.projects.length > 0) out(`  projects: ${task.projects.join(", ")}`);
        if (task.openCheckpoint !== undefined) {
          out(`  waiting: ${task.openCheckpoint.kind} (${task.openCheckpoint.checkpointId})`);
          out(`  prompt: ${task.openCheckpoint.prompt}`);
        }
        return;
      }
      case "watch": {
        const taskId = requireArg(positionals[1], "task watch <taskId>");
        await client.subscribe();
        const task = await attachToTask({ client, taskId, interactive: false });
        out(`task ${task.taskId}: ${task.status}`);
        return;
      }
      case "answer": {
        const taskId = requireArg(positionals[1], "task answer <taskId>");
        const answer = positionals[2] ?? "";
        const checkpointId = values["checkpoint"] as string | undefined;
        if (checkpointId === undefined) {
          await client.scoped("task.answer", {
            taskId,
            questionId: (values["question"] as string | undefined) ?? "default",
            answer,
          });
          out(`answered task ${taskId}`);
          return;
        }
        const version = await checkpointVersion(client, checkpointId);
        const approve = /^(a|approve|yes)$/i.test(answer.trim());
        const result = (await client.scoped("checkpoint.answer", {
          checkpointId,
          decision: approve ? "approve" : "answer",
          ...(approve ? {} : { answer }),
          expectedVersion: version,
        })) as { status: string };
        out(`checkpoint ${checkpointId}: ${result.status}`);
        return;
      }
      case "cancel": {
        const taskId = requireArg(positionals[1], "task cancel <taskId>");
        const result = (await client.scoped("task.cancel", {
          taskId,
          ...(values["reason"] === undefined ? {} : { reason: values["reason"] as string }),
        })) as { status: string };
        out(`task ${taskId}: ${result.status}`);
        return;
      }
      default:
        throw new Error(`unknown task command: ${sub ?? "(none)"}`);
    }
  } finally {
    client.close();
  }
}

async function cmdSchedule(positionals: string[], values: Options): Promise<void> {
  const sub = positionals[0];
  if (sub === "add") {
    const instruction = requireArg(positionals[1], 'schedule add "<instruction>"');
    const task = await cmdSubmit([instruction], values, "schedule");
    if (values["detach"] === true) return;
    if (task?.status !== "completed") {
      out("schedule was not registered; make the recurrence and run time explicit, then retry");
      return;
    }
    await cmdSchedule(["list"], values);
    return;
  }
  const client = await connect();
  try {
    switch (sub) {
      case "create": {
        const name = requireArg(values["name"] as string | undefined, "schedule create --name");
        const cron = requireArg(values["cron"] as string | undefined, "schedule create --cron");
        const summary = requireArg(
          values["summary"] as string | undefined,
          "schedule create --summary",
        );
        const result = (await client.scoped("schedule.create", {
          name,
          spec: { cron, timezone: (values["timezone"] as string | undefined) ?? "UTC" },
          taskTemplate: {
            title: (values["title"] as string | undefined) ?? name,
            summary,
            projects: (values["project"] as string[] | undefined) ?? [],
          },
          enabled: values["enabled"] === true,
        })) as { scheduleId: string; enabled: boolean };
        out(`schedule ${result.scheduleId} created (enabled=${String(result.enabled)})`);
        return;
      }
      case "list": {
        const result = (await client.scoped("schedule.list", {})) as {
          schedules: { scheduleId: string; name: string; spec: { cron: string }; enabled: boolean }[];
        };
        if (result.schedules.length === 0) out("no schedules");
        for (const s of result.schedules) {
          out(`${s.scheduleId}  ${s.enabled ? "enabled " : "paused  "} ${s.spec.cron}  ${s.name}`);
        }
        return;
      }
      case "pause":
      case "resume": {
        const scheduleId = requireArg(positionals[1], `schedule ${sub} <scheduleId>`);
        await client.scoped("schedule.update", { scheduleId, enabled: sub === "resume" });
        out(`schedule ${scheduleId}: ${sub === "resume" ? "enabled" : "paused"}`);
        return;
      }
      case "run-now": {
        const scheduleId = requireArg(positionals[1], "schedule run-now <scheduleId>");
        await client.scoped("schedule.trigger", { scheduleId });
        out(`schedule ${scheduleId} triggered`);
        return;
      }
      case "delete": {
        const scheduleId = requireArg(positionals[1], "schedule delete <scheduleId>");
        await client.scoped("schedule.delete", { scheduleId });
        out(`schedule ${scheduleId} deleted`);
        return;
      }
      default:
        throw new Error(`unknown schedule command: ${sub ?? "(none)"}`);
    }
  } finally {
    client.close();
  }
}

/**
 * Revocation, reachable. `--all` widens it from this profile's own sessions to
 * every binding of the workspace (a Slack binding has no credential to present
 * here, so that is the only way its tokens can be cut). `--disable` also stops
 * the binding issuing new sessions until the daemon is restarted.
 *
 * Authenticated by the profile's session credential, not by a scope token: the
 * point of revoking is that a token may be in the wrong hands.
 */
async function cmdAdmin(positionals: string[], values: Options): Promise<number> {
  const sub = positionals[0];
  // The checkpoint-latch repair opens the SQLite file directly and never
  // touches the socket: it exists for the case where a task is wedged, which is
  // exactly when the control plane may be the thing that is wrong. See
  // `latch.ts` for why this is a CLI command rather than a daemon verb.
  if (sub === "latch") {
    return runLatchCommand(
      {
        out,
        err: (line) => process.stderr.write(`${line}\n`),
        open: openDatabaseForAdmin,
      },
      positionals.slice(1),
      values,
      process.env,
    );
  }
  if (sub !== "revoke") {
    throw new Error(`unknown admin command: ${sub ?? "(none)"}`);
  }
  const profile = (values["profile"] as string | undefined) ?? process.env["MEIDOYA_PROFILE"];
  const socketPath = process.env["MEIDOYA_SOCKET"] ?? DEFAULT_SOCKET_PATH;
  const client = await ControlPlaneClient.connect(socketPath);
  try {
    const result = (await client.request("session.revoke", {
      source: "cli",
      profile: profile ?? null,
      credential: readSessionCredential(profile, socketPath) ?? null,
      scope: values["all"] === true ? "workspace" : "session",
      disable: values["disable"] === true,
    })) as { workspaceId: string; scope: string; revoked: number };
    out(
      `revoked ${String(result.revoked)} binding(s) in ${result.workspaceId}` +
        ` (${result.scope}); outstanding scope tokens no longer verify`,
    );
    return 0;
  } finally {
    client.close();
  }
}

async function cmdStatus(): Promise<void> {
  const client = await connect();
  try {
    const status = (await client.scoped("workspace.status.read", {})) as {
      activeTasks: { taskId: string; title: string; status: string; pipeline: string }[];
      waitingTasks: { taskId: string; title: string; status: string; pipeline: string }[];
      schedules: { scheduleId: string; enabled: boolean }[];
      nodes: { nodeId: string; status: string; activeRunCount: number }[];
      workspaces?: {
        workspaceId: string;
        activeTasks: { taskId: string; title: string; status: string; pipeline: string }[];
        waitingTasks: { taskId: string; title: string; status: string; pipeline: string }[];
      }[];
    };
    out("active tasks:");
    for (const task of status.activeTasks) out(`  ${formatTask(task)}`);
    if (status.activeTasks.length === 0) out("  none");
    out("waiting on a human:");
    for (const task of status.waitingTasks) out(`  ${formatTask(task)}`);
    if (status.waitingTasks.length === 0) out("  none");
    out(`schedules: ${status.schedules.length}`);
    out("execution nodes:");
    for (const node of status.nodes) {
      out(`  ${node.nodeId}  ${node.status}  running=${String(node.activeRunCount)}`);
    }
    if (status.nodes.length === 0) out("  none");
    if (status.workspaces !== undefined) {
      out("granted workspaces:");
      for (const workspace of status.workspaces) {
        out(
          `  ${workspace.workspaceId}  active=${String(workspace.activeTasks.length)}` +
            ` waiting=${String(workspace.waitingTasks.length)}`,
        );
      }
      if (status.workspaces.length === 0) out("  none");
    }
  } finally {
    client.close();
  }
}

function requireArg<T>(value: T | undefined, usage: string): T {
  if (value === undefined) throw new Error(`missing argument: ${usage}`);
  return value;
}

function cmdInit(values: Options): number {
  const projects = (values["project"] as string[] | undefined) ?? [];
  if (projects.length !== 1) throw new Error("init requires exactly one --project <path>");
  const provider = values["provider"] as string | undefined;
  if (provider !== undefined && provider !== "codex" && provider !== "claude") {
    throw new Error("--provider must be codex or claude");
  }
  const result = initializeLocalConfig({
    projectPath: projects[0] as string,
    ...(values["workspace"] === undefined ? {} : { workspaceId: values["workspace"] as string }),
    ...(values["project-id"] === undefined ? {} : { projectId: values["project-id"] as string }),
    ...(values["node"] === undefined ? {} : { nodeId: values["node"] as string }),
    ...(values["config-dir"] === undefined ? {} : { configDir: values["config-dir"] as string }),
    ...(values["data-dir"] === undefined ? {} : { dataDir: values["data-dir"] as string }),
    ...(provider === undefined ? {} : { provider }),
    ...(values["codex-model"] === undefined
      ? {}
      : { codexModel: values["codex-model"] as string }),
    force: values["force"] === true,
  });
  out(`created ${result.configFile}`);
  out(`created ${result.nodeConfigFile}`);
  out(`profile ${result.profile}; runtime ${result.provider}; node ${result.nodeId}`);
  out(`next: export MEIDOYA_PROFILE=${result.profile}`);
  out("next: pnpm local:start");
  return 0;
}

async function cmdDoctor(values: Options): Promise<number> {
  const home = process.env["HOME"] ?? "";
  const report = await runDoctor({
    configFile:
      (values["config"] as string | undefined) ??
      process.env["MEIDOYA_CONFIG"] ??
      path.join(home, ".config", "meidoya", "config.yaml"),
    nodeConfigFile:
      (values["node-config"] as string | undefined) ??
      process.env["MEIDOYA_NODE_CONFIG"] ??
      path.join(home, ".config", "meidoya", "node.yaml"),
    ...(values["temporal"] === undefined
      ? {}
      : { temporalAddress: values["temporal"] as string }),
    ...(values["profile"] === undefined ? {} : { profile: values["profile"] as string }),
  });
  if (values["json"] === true) out(JSON.stringify(report, null, 2));
  else out(formatDoctorReport(report));
  return report.exitCode;
}

/* -------------------------------------------------------------------- main */

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      title: { type: "string" },
      pipeline: { type: "string" },
      project: { type: "string", multiple: true },
      workspace: { type: "string" },
      "project-id": { type: "string" },
      node: { type: "string" },
      provider: { type: "string" },
      "codex-model": { type: "string" },
      config: { type: "string" },
      "node-config": { type: "string" },
      "config-dir": { type: "string" },
      "data-dir": { type: "string" },
      temporal: { type: "string" },
      target: { type: "string", multiple: true },
      status: { type: "string", multiple: true },
      limit: { type: "string" },
      checkpoint: { type: "string" },
      question: { type: "string" },
      reason: { type: "string" },
      name: { type: "string" },
      cron: { type: "string" },
      timezone: { type: "string" },
      summary: { type: "string" },
      enabled: { type: "boolean" },
      profile: { type: "string" },
      all: { type: "boolean" },
      disable: { type: "boolean" },
      detach: { type: "boolean" },
      db: { type: "string" },
      json: { type: "boolean" },
      apply: { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];
  if (values["help"] === true || command === undefined || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const rest = positionals.slice(1);
  try {
    switch (command) {
      case "init":
        return cmdInit(values as Options);
      case "doctor":
        return await cmdDoctor(values as Options);
      case "submit":
        await cmdSubmit(rest, values as Options);
        return 0;
      case "task":
        await cmdTask(rest, values as Options);
        return 0;
      case "schedule":
        await cmdSchedule(rest, values as Options);
        return 0;
      case "status":
        await cmdStatus();
        return 0;
      case "admin":
        return await cmdAdmin(rest, values as Options);
      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    const message =
      error instanceof ControlPlaneClientError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
