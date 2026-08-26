import path from "node:path";
import type { MeidoyaDatabase } from "@meidoya/store-sqlite";
import { writeStatusFile, type StatusSnapshot, type StatusTask } from "@meidoya/status-projector";
import type { ResolvedControlPlaneConfig } from "./config.js";
import type { ControlPlaneService } from "./api.js";

type TaskRow = {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  pipeline: string;
  origin: string;
  updated_at: number;
};

/** Reads the SQLite projection into the deterministic STATUS.md snapshot shape. */
export function buildStatusSnapshot(
  db: MeidoyaDatabase,
  config: ResolvedControlPlaneConfig,
  service: ControlPlaneService,
  now: number = Date.now(),
): StatusSnapshot {
  const tasks = db
    .prepare(
      "SELECT id, workspace_id, title, status, pipeline, origin, updated_at FROM tasks ORDER BY id ASC",
    )
    .all() as TaskRow[];

  // Polled every few seconds on the writer connection, so it must never scan
  // the full (unbounded, append-only) checkpoints table: migration 0002 adds
  // the partial index `checkpoints_pending_idx ... WHERE status = 'pending'`,
  // which bounds this to the open checkpoints only. Keep the predicate exactly
  // matching that index.
  const checkpoints = db
    .prepare(
      "SELECT task_id, kind, prompt FROM checkpoints WHERE status = 'pending' ORDER BY task_id ASC, created_at ASC",
    )
    .all() as { task_id: string; kind: string; prompt: string }[];
  // Rows arrive oldest-first per task, so the last one written into the map is
  // the newest pending checkpoint — the same one `openCheckpointFor` returns.
  const openByTask = new Map(checkpoints.map((c) => [c.task_id, c]));

  const schedules = db
    .prepare("SELECT id, workspace_id, name, spec_json, delivery_policy, enabled FROM schedules")
    .all() as {
    id: string;
    workspace_id: string;
    name: string;
    spec_json: string;
    delivery_policy: string;
    enabled: number;
  }[];

  return {
    environmentId: config.environmentId,
    generatedAt: now,
    workspaces: config.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      displayName: workspace.displayName,
      tasks: tasks
        .filter((t) => t.workspace_id === workspace.workspaceId)
        .map((t): StatusTask => {
          const open = openByTask.get(t.id);
          return {
            taskId: t.id,
            title: t.title,
            status: t.status,
            pipeline: t.pipeline,
            origin: t.origin,
            updatedAt: t.updated_at,
            ...(open === undefined
              ? {}
              : { openCheckpoint: { kind: open.kind, prompt: open.prompt } }),
            artifacts: [],
          };
        }),
      schedules: schedules
        .filter((s) => s.workspace_id === workspace.workspaceId)
        .map((s) => {
          const spec = JSON.parse(s.spec_json) as { cron: string; timezone: string };
          return {
            scheduleId: s.id,
            name: s.name,
            cron: spec.cron,
            timezone: spec.timezone,
            enabled: s.enabled === 1,
            delivery: s.delivery_policy,
          };
        }),
    })),
    nodes: service.listNodes().map((node) => ({
      nodeId: node.nodeId,
      profile: node.profile,
      platform: node.platform,
      status: node.status,
      activeRunCount: node.activeRunCount,
      maxConcurrency: node.maxConcurrency,
      allowedWorkspaces: node.allowedWorkspaces,
    })),
  };
}

export type StatusProjectorOptions = {
  db: MeidoyaDatabase;
  config: ResolvedControlPlaneConfig;
  service: ControlPlaneService;
  intervalMs?: number;
  now?: () => number;
};

/**
 * Internal progress lives here (07 section 3): STATUS.md, SQLite and logs get
 * every step; chat gets only what the interaction policy allows.
 */
export class StatusProjector {
  readonly #options: StatusProjectorOptions;
  readonly #filePath: string;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: StatusProjectorOptions) {
    this.#options = options;
    this.#filePath = path.join(options.config.dataDir, "STATUS.md");
  }

  get filePath(): string {
    return this.#filePath;
  }

  projectOnce(): void {
    const now = this.#options.now?.() ?? Date.now();
    writeStatusFile(
      this.#filePath,
      buildStatusSnapshot(this.#options.db, this.#options.config, this.#options.service, now),
      { title: `Meidoya STATUS (${this.#options.config.environmentId})` },
    );
  }

  start(): void {
    this.stop();
    this.projectOnce();
    this.#timer = setInterval(() => {
      try {
        this.projectOnce();
      } catch {
        // A projection failure must never take the control plane down.
      }
    }, this.#options.intervalMs ?? 5_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}
