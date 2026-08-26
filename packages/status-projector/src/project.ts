import {
  ACTIVE_TASK_STATUSES,
  StatusSnapshotSchema,
  WAITING_TASK_STATUSES,
  type StatusArtifact,
  type StatusSnapshot,
  type StatusTask,
} from "./model.js";
import { scrub, type ScrubOptions } from "./scrub.js";

export type ProjectionOptions = ScrubOptions & {
  title?: string;
};

/** Epoch ms -> UTC ISO minute; host timezone must not change the output. */
export function formatInstant(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function projectStatusMarkdown(
  input: StatusSnapshot,
  options: ProjectionOptions = {},
): string {
  const snapshot = StatusSnapshotSchema.parse(input);
  const clean = (text: string): string => scrub(text, options);
  const lines: string[] = [];

  lines.push(`# ${options.title ?? "Meidoya STATUS"}`);
  lines.push("");
  lines.push(`- environment: ${clean(snapshot.environmentId)}`);
  lines.push(`- generated: ${formatInstant(snapshot.generatedAt)}`);
  lines.push("");

  const workspaces = [...snapshot.workspaces].sort((a, b) =>
    a.workspaceId.localeCompare(b.workspaceId),
  );

  for (const workspace of workspaces) {
    lines.push(`## Workspace: ${clean(workspace.displayName)} (${clean(workspace.workspaceId)})`);
    lines.push("");

    const tasks = [...workspace.tasks].sort(byTask);
    const active = tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status));
    const waiting = tasks.filter((t) => WAITING_TASK_STATUSES.has(t.status));
    const closed = tasks.filter(
      (t) =>
        !ACTIVE_TASK_STATUSES.has(t.status) && !WAITING_TASK_STATUSES.has(t.status),
    );

    lines.push("### Active tasks", "");
    lines.push(...nodeAvailabilityNotice(snapshot, workspace.workspaceId, active.length, clean));
    lines.push(...taskSection(active, clean));
    lines.push("### Waiting on a human", "");
    lines.push(...taskSection(waiting, clean));
    lines.push("### Recently closed", "");
    lines.push(...taskSection(closed, clean));

    lines.push("### Schedules", "");
    const schedules = [...workspace.schedules].sort((a, b) =>
      a.scheduleId.localeCompare(b.scheduleId),
    );
    if (schedules.length === 0) {
      lines.push("_none_", "");
    } else {
      lines.push("| schedule | cron | timezone | enabled | last run | outcome |");
      lines.push("| --- | --- | --- | --- | --- | --- |");
      for (const s of schedules) {
        lines.push(
          `| ${clean(s.name)} | \`${clean(s.cron)}\` | ${clean(s.timezone)} | ${
            s.enabled ? "yes" : "no"
          } | ${s.lastRunAt === undefined ? "-" : formatInstant(s.lastRunAt)} | ${
            s.lastOutcome === undefined ? "-" : clean(s.lastOutcome)
          } |`,
        );
      }
      lines.push("");
    }
  }

  lines.push("## Execution nodes", "");
  const nodes = [...snapshot.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  if (nodes.length === 0) {
    lines.push("_none_", "");
  } else {
    lines.push("| node | profile | platform | status | running | max |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const n of nodes) {
      lines.push(
        `| ${clean(n.nodeId)} | ${clean(n.profile)} | ${clean(n.platform)} | ${n.status} | ${n.activeRunCount} | ${n.maxConcurrency} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/**
 * Tells "parked waiting for an execution node" apart from "stuck".
 *
 * Worker steps and verification are dispatched to the bound node's task queue
 * (10 sections 1-3); the control plane never runs them. So a task can sit in
 * `running`/`verifying` for hours with nothing wrong except that no node is
 * polling — which, with no marker here, looks exactly like a wedged task. The
 * distinction is a property of the WORKSPACE, not of the task row: if no online
 * node is bound to it, every active task in it is queued, not hung.
 *
 * Named nodes are listed with their status so the operator knows which machine
 * to bring back, rather than being told only that something is missing.
 */
function nodeAvailabilityNotice(
  snapshot: StatusSnapshot,
  workspaceId: string,
  activeTaskCount: number,
  clean: (text: string) => string,
): string[] {
  if (activeTaskCount === 0) return [];
  const bound = snapshot.nodes.filter((n) => n.allowedWorkspaces.includes(workspaceId));
  if (bound.some((n) => n.status === "online")) return [];
  const detail =
    bound.length === 0
      ? "no execution node is bound to this workspace"
      : `bound nodes: ${bound
          .map((n) => `${clean(n.nodeId)} (${n.status})`)
          .sort()
          .join(", ")}`;
  return [
    `> **PARKED — waiting for an execution node.** ${detail}. Worker and verification` +
      " steps are queued on the node task queue and will run as soon as a node registers" +
      " (`meidoya-node`); they are not stuck and need no human answer.",
    "",
  ];
}

function byTask(a: StatusTask, b: StatusTask): number {
  // Stable ordering by id only: updatedAt ties would otherwise reshuffle rows.
  return a.taskId.localeCompare(b.taskId);
}

function taskSection(
  tasks: StatusTask[],
  clean: (text: string) => string,
): string[] {
  if (tasks.length === 0) return ["_none_", ""];
  const lines: string[] = [];
  for (const task of tasks) {
    lines.push(`- **${clean(task.title)}** (\`${clean(task.taskId)}\`)`);
    lines.push(`  - status: ${task.status}`);
    lines.push(`  - pipeline: ${clean(task.pipeline)} / origin: ${clean(task.origin)}`);
    lines.push(`  - updated: ${formatInstant(task.updatedAt)}`);
    if (task.currentPhase !== undefined) {
      lines.push(`  - phase: ${clean(task.currentPhase)}`);
    }
    if (task.openCheckpoint !== undefined) {
      lines.push(
        `  - awaiting ${clean(task.openCheckpoint.kind)}: ${clean(task.openCheckpoint.prompt)}`,
      );
    }
    const artifacts = visibleArtifacts(task.artifacts);
    if (artifacts.length > 0) {
      lines.push("  - artifacts:");
      for (const artifact of artifacts) {
        lines.push(`    - ${renderArtifact(artifact, clean)}`);
      }
    }
  }
  lines.push("");
  return lines;
}

/** private artifacts never appear; summary artifacts show no path. */
function visibleArtifacts(artifacts: StatusArtifact[]): StatusArtifact[] {
  return artifacts
    .filter((a) => a.visibility !== "private")
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
}

function renderArtifact(
  artifact: StatusArtifact,
  clean: (text: string) => string,
): string {
  const head = `${clean(artifact.kind)} \`${clean(artifact.artifactId)}\``;
  if (artifact.visibility === "summary") {
    return artifact.summary === undefined
      ? `${head} (summary only)`
      : `${head}: ${clean(artifact.summary)}`;
  }
  return `${head}: ${clean(artifact.path)} (sha256 ${artifact.sha256.slice(0, 12)})`;
}
