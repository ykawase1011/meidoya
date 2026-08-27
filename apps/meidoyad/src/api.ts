import { createHash, randomUUID } from "node:crypto";
import {
  ACTIVE_TASK_STATUSES,
  CLOSED_TASK_STATUSES,
  WAITING_TASK_STATUSES,
  type AdminCommand,
  type HumanCheckpoint,
  type PipelineName,
  type TaskListView,
  type TaskStatus,
} from "@meidoya/domain";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlPlaneError,
  type MethodHandlers,
  type MethodParams,
  type MethodResult,
  type ResolvedScope,
} from "@meidoya/protocol";
import { NODE_PROTOCOL_VERSION, type NodeRegistration } from "@meidoya/node-protocol";
import {
  applyCheckpointEvent,
  checkpointSignalAnswer,
  planCheckpointDelivery,
  type CheckpointEvent,
} from "@meidoya/checkpoint-policy";
import { reconcileRegistration, type LocalNodePolicy } from "@meidoya/node-runtime";
import { scheduleId as temporalScheduleId } from "@meidoya/workflows-temporal";
import { crossWorkspaceWorkflowId } from "@meidoya/workflows-temporal";
import { DelegationRegistry } from "@meidoya/workspace-scope";
import type { ResolvedControlPlaneConfig } from "./config.js";
import {
  isCheckpointConflict,
  type CheckpointDelivery,
  type SqliteTaskRepository,
} from "./repository.js";
import type { ScopeRegistry } from "./scope.js";
import { NodeCredentialStore } from "./client-credentials.js";
import type { ControlEventBus } from "./events.js";
import { OVERLAP_POLICIES, type WorkflowGateway } from "./temporal.js";

export type NodeRecord = {
  nodeId: string;
  profile: string;
  platform: string;
  status: "online" | "draining" | "offline";
  activeRunCount: number;
  maxConcurrency: number;
  allowedWorkspaces: string[];
  lastHeartbeatAt: number;
};

export type ControlPlaneServiceOptions = {
  config: ResolvedControlPlaneConfig;
  repository: SqliteTaskRepository;
  scopes: ScopeRegistry;
  gateway: WorkflowGateway;
  events: ControlEventBus;
  /**
   * Per-node registration tokens. Omitted means NO node can authenticate: the
   * node methods fail closed rather than open, so a host that forgot to
   * provision them serves nothing instead of serving everyone.
   */
  nodeCredentials?: NodeCredentialStore;
  now?: () => number;
  newId?: () => string;
  /**
   * Where operational failures are reported. Defaults to stderr; a committed
   * human answer must never be discarded without a line saying so.
   */
  log?: (message: string) => void;
};

/**
 * One answer for every way a node call can fail to prove who it is: no token,
 * a token belonging to a different node, a node the operator never configured.
 * Same reason `notFound` is uniform — a refusal must not be an oracle, here for
 * which node ids exist.
 */
const NODE_REFUSED = "node authentication failed";

function notFound(what: string): never {
  // Deliberately indistinguishable from "exists but out of scope": a caller
  // must never be able to probe for objects of another workspace.
  throw new ControlPlaneError("not_found", `${what} not found`);
}

/**
 * A signal that can never be delivered because its workflow execution is gone
 * (closed or never started). Distinguished from a transient transport failure
 * so the reconciliation sweep retires the row instead of retrying it forever.
 *
 * Matched on the TYPE and nothing else. This used to also match the error's
 * message text, which made every "not found" the transport ever phrased that
 * way — a namespace failover, a signal racing the visibility of a workflow
 * that was just started — indistinguishable from a genuinely closed execution.
 * The consequence was not a retry: it was retirement. The row was latched, and
 * a human answer that had already been committed was discarded for good.
 *
 * Even a typed `WorkflowNotFoundError` is not acted on immediately; see
 * `reconcileCheckpointDeliveries`, which requires the same verdict twice before
 * it discards anything.
 */
function isUnreachableWorkflow(error: unknown): boolean {
  return error instanceof Error && error.name === "WorkflowNotFoundError";
}

/**
 * What one reconciliation sweep did, and what is still owed.
 *
 * `scanned`/`delivered`/`failed` describe the window this sweep looked at;
 * `backlog` is the whole queue and `awaitingCorroboration` the part of it that
 * has answered "workflow gone" once and needs a second verdict before it may be
 * retired. The last two exist so a queue that is not draining is a number
 * somebody sees, rather than a silent leak.
 */
export type CheckpointReconcileResult = {
  scanned: number;
  delivered: number;
  failed: number;
  backlog: number;
  awaitingCorroboration: number;
};

export type ReceivedRequestReconcileResult = {
  scanned: number;
  submitted: number;
  failed: number;
};

type ListedTask = MethodResult<"task.list">["tasks"][number];

const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  received: "📥 受付中",
  planning: "📝 計画中",
  waiting_clarification: "❓ 追加情報待ち",
  waiting_plan_approval: "✋ 計画承認待ち",
  running: "⚙️ 実行中",
  verifying: "🧪 検証中",
  reviewing: "🔎 レビュー中",
  waiting_review_approval: "✋ 完了承認待ち",
  waiting_user_input: "💬 回答待ち",
  waiting_side_effect_approval: "⛔ 外部操作承認待ち",
  needs_attention: "⚠️ 要対応",
  completed: "✅ 完了",
  failed: "❌ 失敗",
  cancelled: "⏹️ キャンセル",
};

function taskStatusesForView(view: TaskListView): readonly TaskStatus[] | undefined {
  switch (view) {
    case "open":
      return [...ACTIVE_TASK_STATUSES, ...WAITING_TASK_STATUSES];
    case "waiting":
      return WAITING_TASK_STATUSES;
    case "closed":
      return CLOSED_TASK_STATUSES;
    case "all":
      return undefined;
  }
}

function taskListTitle(view: TaskListView): string {
  switch (view) {
    case "open":
      return "進行中のタスク";
    case "waiting":
      return "確認・対応待ちのタスク";
    case "closed":
      return "完了・終了したタスク";
    case "all":
      return "すべてのタスク";
  }
}

function taskListSummary(view: TaskListView, count: number): string {
  if (count === 0) return `${taskListTitle(view)}はありません。`;
  return `${taskListTitle(view)}は${String(count)}件です。`;
}

function taskLine(task: ListedTask): string {
  return `${TASK_STATUS_LABELS[task.status]} — ${task.title}`;
}

function taskSections(tasks: ListedTask[]): Array<{ title: string; bullets: string[] }> {
  const active = new Set<TaskStatus>(ACTIVE_TASK_STATUSES);
  const waiting = new Set<TaskStatus>(WAITING_TASK_STATUSES);
  const groups = [
    { title: "進行中", tasks: tasks.filter((task) => active.has(task.status)) },
    { title: "確認・対応待ち", tasks: tasks.filter((task) => waiting.has(task.status)) },
    {
      title: "完了・終了",
      tasks: tasks.filter((task) => !active.has(task.status) && !waiting.has(task.status)),
    },
  ];
  return groups.flatMap((group) =>
    group.tasks.length === 0
      ? []
      : [{ title: group.title, bullets: group.tasks.map((task) => taskLine(task)) }],
  );
}

/**
 * Task ids are `task-<requestKey>` on both sides of the Temporal boundary
 * (RequestWorkflow derives the same id), and the request key was the caller's
 * `idempotencyKey` verbatim. That made every task id in the environment
 * predictable *and* shared across tenants: one workspace's key named another
 * workspace's task, which both collided with it and told the caller whether it
 * existed. Namespacing the key by workspace makes the two id spaces disjoint,
 * so a cross-workspace collision — and the existence oracle built on it — is no
 * longer expressible. The digest is one-way: the caller's key is not recoverable
 * from an id, and ids stay stable for the same (workspace, key) pair, which is
 * what idempotency needs.
 */
function requestKeyFor(workspaceId: string, clientKey: string): string {
  return createHash("sha256")
    .update(workspaceId)
    .update("\u0000")
    .update(clientKey)
    .digest("hex")
    .slice(0, 32);
}

export class ControlPlaneService {
  readonly #config: ResolvedControlPlaneConfig;
  readonly #repo: SqliteTaskRepository;
  readonly #scopes: ScopeRegistry;
  readonly #gateway: WorkflowGateway;
  readonly #events: ControlEventBus;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #nodePolicies: LocalNodePolicy[];
  readonly #nodeCredentials: NodeCredentialStore;
  readonly #delegations: DelegationRegistry;
  readonly #log: (message: string) => void;
  /**
   * Checkpoints whose signal has already been refused once as "workflow gone".
   * Corroboration before discarding: see `reconcileCheckpointDeliveries`.
   *
   * Bounded two ways, because the first way stops working exactly when it is
   * needed. Every sweep that sees the WHOLE backlog prunes the set back to the
   * ids in it, so an entry cannot outlive its row; but that prune is skipped on
   * a truncated scan, so a backlog that stays at or above `limit` — the
   * saturated daemon, the only case where this actually grows — never pruned at
   * all. The hard cap below covers that: entries are dropped oldest-first, and
   * dropping one is always SAFE, because it only costs the checkpoint one more
   * sweep before it can be corroborated as unreachable. Retiring an answer too
   * early is the unsafe direction, and forgetting never causes it.
   */
  readonly #unreachableOnce = new Set<string>();
  #draining = false;

  constructor(options: ControlPlaneServiceOptions) {
    this.#config = options.config;
    this.#repo = options.repository;
    this.#scopes = options.scopes;
    this.#gateway = options.gateway;
    this.#events = options.events;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => randomUUID());
    this.#log = options.log ?? ((message) => void process.stderr.write(message));
    this.#nodeCredentials = options.nodeCredentials ?? NodeCredentialStore.fromEntries([]);
    this.#delegations = new DelegationRegistry(
      Object.entries(
        options.config.headMaid?.enabled === true ? options.config.headMaid.grants : {},
      ).map(([target, capabilities]) => ({
        source: "global" as const,
        target,
        capabilities,
      })),
    );
    this.#nodePolicies = options.config.nodePolicies.map((policy) => ({
      nodeId: policy.nodeId,
      allowedProfiles: policy.profiles,
      allowedCapabilities: policy.capabilities,
      allowedWorkspaces: policy.workspaces,
      maxConcurrencyCeiling: policy.max_concurrency,
    }));
  }

  startDraining(): void {
    this.#draining = true;
  }

  /* ------------------------------------------------------------- tasks */

  #requireTask(scope: ResolvedScope, taskId: string) {
    const task = this.#repo.loadTaskSync(taskId);
    if (task === undefined || task.workspaceId !== scope.workspaceId) notFound(`task ${taskId}`);
    return task;
  }

  /**
   * Ownership check for a caller-supplied row id on a *create* path, where
   * there is no existing object to scope the request by. Returns the id only if
   * a row with that id exists and belongs to the token's workspace.
   *
   * Unknown, dangling and foreign all fail the same way and with the same
   * message: a rejection must not tell the caller which of the three it was.
   */
  #requireOwned(
    scope: ResolvedScope,
    id: string | undefined,
    kind: "task" | "conversation",
  ): string | undefined {
    if (id === undefined) return undefined;
    const table = kind === "task" ? "tasks" : "conversations";
    const row = this.#repo.db
      .prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`)
      .get(id) as { workspace_id: string } | undefined;
    if (row === undefined || row.workspace_id !== scope.workspaceId) notFound(`${kind} ${id}`);
    return id;
  }

  #summaryOf(task: ReturnType<SqliteTaskRepository["loadTaskSync"]> & object) {
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      pipeline: task.pipeline,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  async createTask(
    scope: ResolvedScope,
    params: MethodParams<"task.create">,
  ): Promise<MethodResult<"task.create">> {
    const coordinating = scope.role === "head-maid";
    if (coordinating) {
      if (
        this.#config.headMaid?.enabled !== true ||
        this.#config.headMaid.workspaceId !== scope.workspaceId
      ) {
        notFound(`workspace ${scope.workspaceId}`);
      }
      if (params.targetWorkspaceIds === undefined) {
        throw new ControlPlaneError(
          "invalid_params",
          "a coordination task requires targetWorkspaceIds",
        );
      }
      for (const target of new Set(params.targetWorkspaceIds)) {
        if (this.#delegations.check("global", target, "task.delegate").outcome !== "granted") {
          notFound(`workspace ${target}`);
        }
        if (
          this.#delegations.check("global", target, "task-summary.read").outcome !== "granted"
        ) {
          throw new ControlPlaneError(
            "capability_denied",
            `workspace ${target} does not grant task-summary.read`,
          );
        }
      }
    } else if (params.targetWorkspaceIds !== undefined) {
      throw new ControlPlaneError(
        "invalid_params",
        "targetWorkspaceIds is only valid for coordination tasks",
      );
    }

    const allowed = new Set(this.#scopes.projectsOf(scope.workspaceId));
    for (const project of params.intent.projects) {
      if (!allowed.has(project)) {
        throw new ControlPlaneError(
          "invalid_params",
          `project ${project} is not in the bound workspace scope`,
        );
      }
    }

    // Every caller-supplied id is checked against the token's workspace before
    // it is written. `parentTaskId` in particular is not inert: the execution
    // budget is keyed on the ROOT of the parent chain (06 section 4), so a task
    // parented to a foreign task would spend that workspace's step budget, run
    // under its limits, and burn its one-time extension.
    const parentTaskId = this.#requireOwned(scope, params.parentTaskId, "task");
    const conversationId = this.#requireOwned(scope, params.conversationId, "conversation");

    const requestKey = requestKeyFor(
      scope.workspaceId,
      params.idempotencyKey ?? `req-${this.#newId()}`,
    );
    const taskId = `task-${requestKey}`;
    const existing = this.#repo.loadTaskSync(taskId);
    if (existing !== undefined) {
      // Unreachable across workspaces now that the id space is per-workspace —
      // which is the point: the caller cannot construct an id belonging to
      // another tenant, so this branch can no longer be used as an oracle for
      // whether a foreign task exists. Kept as a belt-and-braces assertion.
      if (existing.workspaceId !== scope.workspaceId) notFound(`task ${taskId}`);
      return { task: this.#summaryOf(existing), temporalWorkflowId: existing.temporalWorkflowId };
    }

    const workspace = this.#config.workspaces.find((w) => w.workspaceId === scope.workspaceId);
    const pipeline = coordinating
      ? "cross-workspace"
      : params.pipeline ?? workspace?.policy.requestPolicy.defaultPipeline ?? "coding";
    const now = this.#now();

    // Workspace comes from the verified scope token and from nothing else.
    const task = await this.#repo.createTask({
      taskId,
      workspaceId: scope.workspaceId,
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
      ...(conversationId === undefined ? {} : { conversationId }),
      origin: params.intent.origin,
      pipeline,
      title: params.title,
      intent: {
        summary: params.intent.summary,
        projects: params.intent.projects,
        origin: params.intent.origin,
      },
      temporalWorkflowId: coordinating
        ? crossWorkspaceWorkflowId(taskId)
        : `task/${taskId}`,
      now,
    });

    const messageRef = `task_event:request:${requestKey}`;
    await this.#repo.appendTaskEvent({
      taskId,
      eventType: "RequestAccepted",
      idempotencyKey: `request:${requestKey}`,
      payload: {
        title: params.title,
        summary: params.intent.summary,
        projects: params.intent.projects,
        origin: params.intent.origin,
        ...(params.interpretation === undefined
          ? {}
          : { interpretation: params.interpretation }),
      },
    });

    if (coordinating) {
      await this.#gateway.submitCoordination({
        coordinationWorkspaceId: scope.workspaceId,
        taskId,
        brief: {
          summary: params.intent.summary,
          projects: params.intent.projects,
          origin: params.intent.origin,
        },
        targetWorkspaceIds: [...new Set(params.targetWorkspaceIds ?? [])],
        ...(conversationId === undefined ? {} : { conversationId }),
      });
    } else {
      await this.#gateway.submitRequest(scope.workspaceId, {
        requestKey,
        origin: params.intent.origin,
        messageRef,
        ...(params.interpretation === undefined
          ? {}
          : { interpretation: params.interpretation }),
        ...(conversationId === undefined ? {} : { conversationId }),
      });
    }

    this.#events.publish({
      workspaceId: scope.workspaceId,
      taskId,
      type: "RequestAccepted",
      status: task.status,
      at: now,
    });

    return { task: this.#summaryOf(task), temporalWorkflowId: task.temporalWorkflowId };
  }

  getTask(scope: ResolvedScope, params: MethodParams<"task.get">): MethodResult<"task.get"> {
    const task = this.#requireTask(scope, params.taskId);
    const checkpoint = this.#repo.openCheckpointFor(task.id);
    return {
      ...this.#summaryOf(task),
      intentSummary: task.intent.summary,
      projects: task.intent.projects,
      ...(checkpoint === undefined
        ? {}
        : {
            openCheckpoint: {
              checkpointId: checkpoint.id,
              kind: checkpoint.kind,
              prompt: checkpoint.prompt,
              choices: checkpoint.choices,
            },
          }),
    };
  }

  listTasks(scope: ResolvedScope, params: MethodParams<"task.list">): MethodResult<"task.list"> {
    const tasks = this.#repo.listTasks(scope.workspaceId, {
      ...(params.status === undefined ? {} : { status: params.status }),
      limit: params.limit,
    });
    return { tasks: tasks.map((task) => this.#summaryOf(task)) };
  }

  async cancelTask(
    scope: ResolvedScope,
    params: MethodParams<"task.cancel">,
  ): Promise<MethodResult<"task.cancel">> {
    const task = this.#requireTask(scope, params.taskId);
    try {
      await this.#gateway.cancelTask(
        task.id,
        params.reason ?? "cancelled by user",
        task.temporalWorkflowId,
      );
    } catch {
      // The workflow may already be gone; the projection still has to settle.
      await this.#repo.forceTaskStatus(task.id, "cancelled");
    }
    const after = this.#repo.loadTaskSync(task.id);
    return { taskId: task.id, status: (after?.status ?? "cancelled") as TaskStatus };
  }

  async answerTask(
    scope: ResolvedScope,
    params: MethodParams<"task.answer">,
  ): Promise<MethodResult<"task.answer">> {
    const task = this.#requireTask(scope, params.taskId);
    await this.#repo.appendTaskEvent({
      taskId: task.id,
      eventType: "UserAnswered",
      idempotencyKey: `answer:${task.id}:${params.questionId}`,
      payload: { questionId: params.questionId, answer: params.answer },
    });
    const open = this.#repo.openCheckpointFor(task.id);
    if (open !== undefined) {
      await this.#resolveCheckpoint(scope, open, { type: "answer", text: params.answer }, params.answer);
      return { taskId: task.id, accepted: true };
    }

    // No OPEN checkpoint is not the same as nothing to do. A task whose answer
    // was committed but whose signal was lost has no pending checkpoint left,
    // so this path used to answer `{accepted:true}` and do nothing at all —
    // the one call a stuck operator naturally reaches for was the one call
    // that could not unstick them. Finish the delivery instead.
    const wedged = this.#repo.latestUndeliveredCheckpointFor(task.id);
    if (wedged !== undefined) {
      await this.#deliver(wedged);
      return { taskId: task.id, accepted: true };
    }
    if (CLOSED_TASK_STATUSES.includes(task.status)) {
      return { taskId: task.id, accepted: false };
    }
    try {
      await this.#gateway.addTaskInstruction(
        task.id,
        { id: params.questionId, text: params.answer },
        task.temporalWorkflowId,
      );
      return { taskId: task.id, accepted: true };
    } catch (error) {
      if (
        error instanceof Error &&
        /workflow.*(?:not found|already (?:completed|closed)|is closed)|execution.*closed/iu.test(
          error.message,
        )
      ) {
        return { taskId: task.id, accepted: false };
      }
      throw error;
    }
  }

  /* -------------------------------------------------------- checkpoints */

  /**
   * A checkpoint of the caller's own workspace, or the same refusal a
   * checkpoint id that never existed gets.
   *
   * `loadCheckpointSync` is unscoped — the checkpoint row carries no workspace
   * of its own — so the scope check has to be made through the owning task. It
   * used to be made by calling `#requireTask` directly, and that raised
   * ``task ${task.id} not found``: a caller probing a foreign checkpoint id got
   * back the FOREIGN TASK ID it belongs to, while an id that existed nowhere
   * got ``checkpoint ... not found``. Two distinguishable refusals is an
   * existence oracle, and the one that fires on a hit also hands over an
   * identifier from the other tenant — the very id `requestKeyFor` exists to
   * keep unguessable, and the input the outbox's `update-message` path needs.
   *
   * So the refusal is phrased on what the CALLER named, once, for all three
   * cases (absent, dangling, foreign). See `notFound`.
   */
  #requireCheckpoint(scope: ResolvedScope, checkpointId: string): HumanCheckpoint {
    const checkpoint = this.#repo.loadCheckpointSync(checkpointId);
    if (checkpoint === undefined) notFound(`checkpoint ${checkpointId}`);
    const task = this.#repo.loadTaskSync(checkpoint.taskId);
    if (task === undefined || task.workspaceId !== scope.workspaceId) {
      notFound(`checkpoint ${checkpointId}`);
    }
    return checkpoint;
  }

  /** Daemon-local extension: exposes the version `checkpoint.answer` demands. */
  getCheckpoint(scope: ResolvedScope, checkpointId: string): HumanCheckpoint {
    return this.#requireCheckpoint(scope, checkpointId);
  }

  async answerCheckpoint(
    scope: ResolvedScope,
    params: MethodParams<"checkpoint.answer">,
  ): Promise<MethodResult<"checkpoint.answer">> {
    const checkpoint = this.#requireCheckpoint(scope, params.checkpointId);

    // Recovery comes BEFORE the version guard, because the client that has to
    // retry is the one whose signal failed: it re-sends the version it read
    // originally, which the successful compare-and-swap has already moved past.
    // Refusing it on the stale version — as this method used to — is exactly
    // what made a single transport error unrecoverable.
    const recovered = await this.#redeliverIfUndelivered(params.checkpointId);
    if (recovered !== undefined) return recovered;

    if (checkpoint.version !== params.expectedVersion) {
      throw new ControlPlaneError(
        "conflict",
        `checkpoint ${checkpoint.id} is at version ${checkpoint.version}`,
      );
    }

    const event: CheckpointEvent =
      params.decision === "approve"
        ? { type: "approve" }
        : params.decision === "reject"
          ? { type: "reject" }
          : {
              type: "answer",
              ...(params.choiceId === undefined ? {} : { choiceId: params.choiceId }),
              ...(params.answer === undefined ? {} : { text: params.answer }),
            };

    return this.#resolveCheckpoint(scope, checkpoint, event, params.answer);
  }

  async #resolveCheckpoint(
    scope: ResolvedScope,
    checkpoint: HumanCheckpoint,
    event: CheckpointEvent,
    text: string | undefined,
  ): Promise<MethodResult<"checkpoint.answer">> {
    const transition = applyCheckpointEvent(checkpoint, event);
    if (!transition.ok) {
      throw new ControlPlaneError("conflict", `checkpoint rejected: ${transition.error}`);
    }
    const next = transition.checkpoint;
    // The read above is only a fast path. The authoritative concurrency check is
    // the version-guarded UPDATE: if another answer landed between the read and
    // here, this throws and we must not signal the workflow a second time.
    try {
      await this.#repo.resolveCheckpoint(next, { decision: next.status, text });
    } catch (error) {
      if (isCheckpointConflict(error)) {
        throw new ControlPlaneError(
          "conflict",
          `checkpoint ${next.id} was already answered${
            error.currentStatus === undefined ? "" : ` (${error.currentStatus})`
          }`,
        );
      }
      throw error;
    }

    // The answer is committed now. From here on the only correct behaviour is
    // to keep trying to deliver it: `#deliver` is idempotent, and anything it
    // throws leaves the row flagged undelivered so a retry or the sweep
    // finishes the job.
    await this.#deliver({
      checkpointId: next.id,
      taskId: next.taskId,
      workspaceId: scope.workspaceId,
      status: next.status,
      version: next.version,
      signalled: false,
      ...(text === undefined ? {} : { text }),
    });

    return {
      checkpointId: next.id,
      status: next.status as "approved" | "rejected" | "answered" | "expired",
      version: next.version,
    };
  }

  /**
   * Hands a committed answer to the workflow and only then latches the row as
   * delivered. The order is the whole point: a crash or a transport error
   * between the two leaves the latch open, so the answer is delivered again
   * rather than lost. TaskWorkflow consumes at most one answer per checkpoint
   * id and discards the rest, so the duplicate is inert.
   */
  async #deliver(delivery: CheckpointDelivery): Promise<void> {
    const answer = checkpointSignalAnswer(delivery.status);
    if (answer === undefined) {
      // Nothing the workflow can be told (an expired checkpoint learns its own
      // fate from a timer). Latch it so the sweep stops reconsidering the row.
      await this.#repo.markCheckpointSignalled(delivery.checkpointId);
      return;
    }
    const task = this.#repo.loadTaskSync(delivery.taskId);
    await this.#gateway.answerCheckpoint(
      delivery.taskId,
      {
        checkpointId: delivery.checkpointId,
        answer,
        ...(delivery.text === undefined ? {} : { text: delivery.text }),
      },
      task?.temporalWorkflowId,
    );
    const latched = await this.#repo.markCheckpointSignalled(delivery.checkpointId);

    // Delivery is at-least-once by design (a retry may race the sweep), but the
    // EVENT is once: the latch answers true exactly for the call that flipped
    // it, so a re-delivery after a crash does not tell every `task watch`
    // client that the checkpoint was resolved a second time.
    if (!latched) return;
    this.#events.publish({
      workspaceId: delivery.workspaceId,
      taskId: delivery.taskId,
      type: "CheckpointResolved",
      payload: { checkpointId: delivery.checkpointId, status: delivery.status },
      at: this.#now(),
    });
  }

  /**
   * The retry half of the recovery. Returns the committed resolution when the
   * checkpoint was answered but never signalled — having (re-)sent the signal
   * first — and `undefined` when there is nothing to recover, so the caller
   * proceeds normally.
   *
   * The answer that gets delivered is the COMMITTED one, never the one the
   * retrying caller is holding: the compare-and-swap already picked a winner
   * and that decision is final.
   */
  async #redeliverIfUndelivered(
    checkpointId: string,
  ): Promise<MethodResult<"checkpoint.answer"> | undefined> {
    const delivery = this.#repo.loadCheckpointDeliverySync(checkpointId);
    if (delivery === undefined) return undefined;
    const plan = planCheckpointDelivery({
      status: delivery.status,
      signalled: delivery.signalled,
    });
    if (plan.action !== "redeliver") return undefined;
    await this.#deliver(delivery);
    if (delivery.status === "expired") {
      // Nothing was signalled and nothing will be: an expired checkpoint is
      // resolved by its own timer, not by an answer. Reporting
      // `{accepted, status:"expired"}` made lateness look like acceptance, so
      // a client that answered a heartbeat too late believed it had been
      // heard. It is a conflict, and it says which kind.
      throw new ControlPlaneError(
        "conflict",
        `checkpoint ${delivery.checkpointId} expired before it was answered`,
      );
    }
    return {
      checkpointId: delivery.checkpointId,
      status: delivery.status as "approved" | "rejected" | "answered" | "expired",
      version: delivery.version,
    };
  }

  /**
   * Re-delivers every answer that was committed but never signalled. A client
   * may simply never retry — it may be a CLI process that exited on the error —
   * so the guarantee that a committed answer eventually reaches the workflow
   * cannot rest on the client alone. Run this at daemon startup and on a timer.
   *
   * Idempotent by construction: a row leaves the backlog only once its signal
   * has landed, and re-running the sweep over an empty backlog does nothing.
   *
   * The backlog is bounded and reported, not merely drained. A row leaves it by
   * one of exactly two routes — delivered, or retired after a corroborated
   * "workflow gone" — so an unreachable workflow costs at most two sweeps, and
   * `backlog`/`awaitingCorroboration` in the result make a queue that is NOT
   * shrinking visible instead of silent.
   */
  async reconcileCheckpointDeliveries(
    options: { limit?: number } = {},
  ): Promise<CheckpointReconcileResult> {
    const limit = options.limit ?? 100;
    const backlog = this.#repo.listUndeliveredCheckpoints(limit);
    // Prune first: an id can leave the backlog without either `delete` below
    // running (a repair retires it, its task is deleted). Bounding the set to
    // what is actually outstanding keeps it from growing for the process's life.
    // Only safe when this scan saw the WHOLE backlog — a truncated window says
    // nothing about the rows beyond it, and pruning on it would throw away a
    // corroboration the next sweep is about to need.
    if (backlog.length < limit) {
      const outstanding = new Set(backlog.map((record) => record.checkpointId));
      for (const id of this.#unreachableOnce) {
        if (!outstanding.has(id)) this.#unreachableOnce.delete(id);
      }
    }
    let delivered = 0;
    let failed = 0;
    for (const record of backlog) {
      try {
        await this.#deliver(record);
        this.#unreachableOnce.delete(record.checkpointId);
        delivered += 1;
      } catch (error) {
        failed += 1;
        if (isUnreachableWorkflow(error) && this.#unreachableOnce.has(record.checkpointId)) {
          // Corroborated: a SECOND sweep, separated from the first by the sweep
          // interval, agrees the execution is gone. Only now is retrying
          // pointless. One observation is not enough — a namespace failover or
          // a signal racing workflow visibility answers "not found" too, and
          // retiring on that discards a human answer that was already
          // committed.
          this.#unreachableOnce.delete(record.checkpointId);
          // `'discarded'`, not `'signal'`: the row is latched because we gave
          // up, not because the workflow heard the answer. Migration 0007 keeps
          // the two apart so the loss is auditable in the database and not only
          // in a log line somebody has to still have.
          await this.#repo.markCheckpointSignalled(record.checkpointId, "discarded");
          // Discarding an answer a human gave is never silent.
          this.#log(
            `meidoyad: DISCARDED a committed checkpoint answer: ${record.checkpointId}` +
              ` (task ${record.taskId}, ${record.status}) — its workflow no longer exists` +
              ` (${String(error)})\n`,
          );
          this.#events.publish({
            workspaceId: record.workspaceId,
            taskId: record.taskId,
            type: "CheckpointAnswerDiscarded",
            payload: {
              checkpointId: record.checkpointId,
              status: record.status,
              reason: "workflow-unreachable",
            },
            at: this.#now(),
          });
          continue;
        }
        if (isUnreachableWorkflow(error)) this.#unreachableOnce.add(record.checkpointId);
        // Anything else is presumed transient: the row stays in the backlog and
        // the next sweep tries again. It is still reported — a backlog that
        // never drains used to be a number nobody ever saw.
        this.#log(
          `meidoyad: checkpoint delivery failed, will retry: ${record.checkpointId}` +
            ` (task ${record.taskId}): ${String(error)}\n`,
        );
      }
    }
    // The cap the prune above cannot provide. A backlog that never drops below
    // `limit` skips that prune on every sweep, so the memo would grow for the
    // life of the process in the one situation where it fills up. `Set`
    // iterates in insertion order, so this drops the oldest corroborations —
    // the ones least likely to still matter — and dropping one only costs an
    // extra sweep before that checkpoint can be retired.
    // Four windows' worth: comfortably more than the `limit` ids one sweep can
    // add, so nothing this sweep learned is forgotten before the next one can
    // use it, and still a constant.
    const memoCap = limit * 4;
    for (const id of this.#unreachableOnce) {
      if (this.#unreachableOnce.size <= memoCap) break;
      this.#unreachableOnce.delete(id);
    }
    return {
      scanned: backlog.length,
      delivered,
      failed,
      // The whole queue, not just the window this sweep scanned: a backlog
      // larger than `limit` is exactly the case a per-sweep count hides.
      backlog: this.#repo.countUndeliveredCheckpoints(),
      awaitingCorroboration: this.#unreachableOnce.size,
    };
  }

  async reconcileReceivedRequests(
    options: { limit?: number; minAgeMs?: number } = {},
  ): Promise<ReceivedRequestReconcileResult> {
    const limit = options.limit ?? 100;
    const minAgeMs = options.minAgeMs ?? 5_000;
    const cutoff = this.#now() - minAgeMs;
    const candidates = this.#config.workspaces
      .flatMap((workspace) =>
        this.#repo.listTasks(workspace.workspaceId, { status: ["received"], limit }),
      )
      .filter(
        (task) =>
          task.updatedAt <= cutoff &&
          task.pipeline !== "cross-workspace" &&
          (task.origin === "chat" || task.origin === "cli"),
      )
      .slice(0, limit);
    let submitted = 0;
    let failed = 0;
    for (const task of candidates) {
      if (!task.id.startsWith("task-")) continue;
      const requestKey = task.id.slice("task-".length);
      const accepted = this.#repo
        .listTaskEvents(task.id)
        .find((event) => event.eventType === "RequestAccepted");
      const interpretation =
        accepted?.payload !== null &&
        typeof accepted?.payload === "object" &&
        "interpretation" in accepted.payload &&
        (accepted.payload.interpretation === "auto" ||
          accepted.payload.interpretation === "schedule")
          ? accepted.payload.interpretation
          : undefined;
      try {
        await this.#gateway.submitRequest(task.workspaceId, {
          requestKey,
          origin: task.origin,
          messageRef: `task_event:request:${requestKey}`,
          ...(interpretation === undefined ? {} : { interpretation }),
          ...(task.conversationId === undefined ? {} : { conversationId: task.conversationId }),
        });
        submitted += 1;
      } catch (error) {
        failed += 1;
        this.#log(
          `meidoyad: received request recovery failed for ${task.id} (will retry): ${String(error)}\n`,
        );
      }
    }
    return { scanned: candidates.length, submitted, failed };
  }

  /* --------------------------------------------------------- schedules */

  async executeAdministrativeCommand(input: {
    workspaceId: string;
    taskId?: string;
    command: AdminCommand;
    conversationId?: string;
  }): Promise<{
    title?: string;
    summary: string;
    bullets?: string[];
    sections?: Array<{ title: string; bullets: string[] }>;
  }> {
    const scope: ResolvedScope = {
      workspaceId: input.workspaceId,
      role: this.#scopes.roleFor(input.workspaceId),
      capabilities: [],
    };
    const command = input.command;
    switch (command.kind) {
      case "task.list": {
        const view = command.view ?? "open";
        const statuses = taskStatusesForView(view);
        const result = this.listTasks(scope, {
          ...(statuses === undefined ? {} : { status: [...statuses] }),
          limit: 50,
        });
        const tasks = result.tasks.filter(
          (task) => input.taskId === undefined || task.taskId !== input.taskId,
        );
        const sections = taskSections(tasks);
        return {
          title: taskListTitle(view),
          summary: taskListSummary(view, tasks.length),
          ...(sections.length === 0 ? {} : { sections }),
        };
      }
      case "task.get": {
        const task = this.getTask(scope, { taskId: command.taskId });
        return {
          title: task.title,
          summary: `${TASK_STATUS_LABELS[task.status]}です。`,
          bullets: [task.intentSummary],
        };
      }
      case "task.cancel": {
        const task = this.getTask(scope, { taskId: command.taskId });
        const result = await this.cancelTask(scope, {
          taskId: command.taskId,
          reason: "Cancelled by natural-language administrative request",
        });
        return {
          summary:
            result.status === "cancelled"
              ? `タスク「${task.title}」をキャンセルしました。`
              : `タスク「${task.title}」は${TASK_STATUS_LABELS[result.status]}です。`,
        };
      }
      case "schedule.list": {
        const result = this.listSchedules(scope, { includeDisabled: true });
        return {
          summary: `Found ${result.schedules.length} schedule(s).`,
          bullets: result.schedules.map(
            (schedule) =>
              `${schedule.enabled ? "enabled" : "paused"}  ${schedule.spec.cron}  ${schedule.spec.timezone}  ${schedule.name}`,
          ),
        };
      }
      case "schedule.create": {
        const result = await this.createSchedule(
          scope,
          {
            name: command.name,
            spec: { cron: command.cron, timezone: command.timezone },
            taskTemplate: {
              title: command.title,
              summary: command.summary,
              projects: command.projects,
              pipeline: "scheduled",
            },
            delivery: command.delivery,
            overlap: command.overlap,
            enabled: command.enabled,
          },
          input.conversationId === undefined
            ? undefined
            : { conversationId: input.conversationId },
        );
        return {
          summary: `Schedule ${result.name} was created ${result.enabled ? "and enabled" : "in a paused state"}.`,
          bullets: [
            `${result.spec.cron} (${result.spec.timezone})`,
            command.summary,
          ],
        };
      }
      case "schedule.pause": {
        const result = await this.updateSchedule(scope, {
          scheduleId: command.scheduleId,
          enabled: false,
        });
        return { summary: `Schedule ${result.name} was paused.` };
      }
      case "schedule.resume": {
        const result = await this.updateSchedule(scope, {
          scheduleId: command.scheduleId,
          enabled: true,
        });
        return { summary: `Schedule ${result.name} was resumed.` };
      }
    }
  }

  maidWorkspaceContext(input: { workspaceId: string; taskId: string }): {
    activeTaskCount: number;
    waitingTaskCount: number;
    enabledScheduleCount: number;
    openTasks: Array<{ taskId: string; title: string; status: TaskStatus }>;
  } {
    const tasks = this.#repo
      .listTasks(input.workspaceId, {
        status: [...ACTIVE_TASK_STATUSES, ...WAITING_TASK_STATUSES],
        limit: 1_000,
      })
      .filter((task) => task.id !== input.taskId);
    const active = new Set<TaskStatus>(ACTIVE_TASK_STATUSES);
    const waiting = new Set<TaskStatus>(WAITING_TASK_STATUSES);
    return {
      activeTaskCount: tasks.filter((task) => active.has(task.status)).length,
      waitingTaskCount: tasks.filter((task) => waiting.has(task.status)).length,
      enabledScheduleCount: this.#scheduleRows(input.workspaceId).filter(
        (schedule) => schedule.enabled,
      ).length,
      openTasks: tasks.slice(0, 5).map((task) => ({
        taskId: task.id,
        title: task.title,
        status: task.status,
      })),
    };
  }

  async materializeScheduledRequest(input: {
    workspaceId: string;
    requestKey: string;
    messageRef: string;
    conversationId?: string;
  }): Promise<{ taskId: string; pipeline: PipelineName }> {
    if (!input.messageRef.startsWith("schedule:")) {
      throw new ControlPlaneError("invalid_params", "scheduled request has an invalid message reference");
    }
    const scheduleId = input.messageRef.slice("schedule:".length);
    const row = this.#repo.db
      .prepare(
        "SELECT workspace_id, task_template_json FROM schedules WHERE id = ?",
      )
      .get(scheduleId) as
      | { workspace_id: string; task_template_json: string }
      | undefined;
    if (row === undefined || row.workspace_id !== input.workspaceId) notFound(`schedule ${scheduleId}`);

    const template = JSON.parse(row.task_template_json) as {
      title: string;
      summary: string;
      projects: string[];
      pipeline: PipelineName;
    };
    const taskId = `task-${input.requestKey}`;
    const existing = this.#repo.loadTaskSync(taskId);
    if (existing !== undefined) {
      if (existing.workspaceId !== input.workspaceId) notFound(`task ${taskId}`);
      return { taskId, pipeline: existing.pipeline };
    }

    const now = this.#now();
    const task = await this.#repo.createTask({
      taskId,
      workspaceId: input.workspaceId,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      origin: "schedule",
      pipeline: template.pipeline,
      title: template.title,
      intent: { summary: template.summary, projects: template.projects, origin: "schedule" },
      temporalWorkflowId: `task/${taskId}`,
      now,
    });
    await this.#repo.appendTaskEvent({
      taskId,
      eventType: "RequestAccepted",
      idempotencyKey: `request:${input.requestKey}`,
      payload: {
        title: template.title,
        summary: template.summary,
        projects: template.projects,
        origin: "schedule",
      },
    });
    this.#events.publish({
      workspaceId: input.workspaceId,
      taskId,
      type: "RequestAccepted",
      status: task.status,
      at: now,
    });
    return { taskId, pipeline: template.pipeline };
  }

  /**
   * Refuses to touch a schedule row owned by another workspace. Absent is fine
   * (that is a create); present-and-foreign is `not_found`, the same answer as
   * every other cross-tenant probe, so it cannot be used to learn that another
   * workspace has a schedule by this name.
   */
  #requireOwnedSchedule(scope: ResolvedScope, scheduleId: string): void {
    const row = this.#repo.db
      .prepare("SELECT workspace_id FROM schedules WHERE id = ?")
      .get(scheduleId) as { workspace_id: string } | undefined;
    if (row !== undefined && row.workspace_id !== scope.workspaceId) {
      notFound(`schedule ${scheduleId}`);
    }
  }

  async createSchedule(
    scope: ResolvedScope,
    params: MethodParams<"schedule.create">,
    context?: { conversationId?: string },
  ): Promise<MethodResult<"schedule.create">> {
    const allowed = new Set(this.#scopes.projectsOf(scope.workspaceId));
    for (const project of params.taskTemplate.projects) {
      if (!allowed.has(project)) {
        throw new ControlPlaneError(
          "invalid_params",
          `project ${project} is not in the bound workspace scope`,
        );
      }
    }
    const id = temporalScheduleId(scope.workspaceId, params.name);
    const now = this.#now();
    // The id is `schedule/<workspace>/<name>`, so it is only unambiguous while
    // the name carries no separator — which the params schema now enforces.
    // The upsert below still gets an explicit owner check and an owner
    // predicate: an id space that several workspaces share must never be
    // writable across the boundary on the strength of one validation alone.
    this.#requireOwnedSchedule(scope, id);
    await this.#repo.transaction(async () => {
      this.#repo.db
        .prepare(
          `INSERT INTO schedules (id, workspace_id, name, temporal_schedule_id, spec_json,
              task_template_json, delivery_policy, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             spec_json = excluded.spec_json,
             task_template_json = excluded.task_template_json,
             delivery_policy = excluded.delivery_policy,
             enabled = excluded.enabled,
             updated_at = excluded.updated_at
           WHERE schedules.workspace_id = excluded.workspace_id`,
        )
        .run(
          id,
          scope.workspaceId,
          params.name,
          id,
          JSON.stringify({ ...params.spec, overlap: params.overlap }),
          JSON.stringify(params.taskTemplate),
          params.delivery,
          params.enabled ? 1 : 0,
          now,
          now,
        );
    });

    await this.#gateway.createSchedule({
      workspaceId: scope.workspaceId,
      environmentId: this.#config.environmentId,
      name: params.name,
      spec: { kind: "cron", expressions: [params.spec.cron], timezone: params.spec.timezone },
      overlap: OVERLAP_POLICIES[params.overlap] ?? "SKIP",
      messageRef: `schedule:${id}`,
      ...(context?.conversationId === undefined
        ? {}
        : { conversationId: context.conversationId }),
      paused: !params.enabled,
    });

    return {
      scheduleId: id,
      name: params.name,
      spec: params.spec,
      delivery: params.delivery,
      overlap: params.overlap,
      enabled: params.enabled,
      updatedAt: now,
    };
  }

  async updateSchedule(
    scope: ResolvedScope,
    params: MethodParams<"schedule.update">,
  ): Promise<MethodResult<"schedule.update">> {
    const row = this.#scheduleRow(scope, params.scheduleId);
    const now = this.#now();
    const spec = params.spec ?? { cron: row.spec.cron, timezone: row.spec.timezone };
    const enabled = params.enabled ?? row.enabled;
    const delivery = params.delivery ?? row.delivery;
    const overlap = params.overlap ?? row.overlap;

    await this.#repo.transaction(async () => {
      this.#repo.db
        .prepare(
          "UPDATE schedules SET spec_json = ?, delivery_policy = ?, enabled = ?, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify({ ...spec, overlap }), delivery, enabled ? 1 : 0, now, row.scheduleId);
    });

    if (enabled !== row.enabled) {
      if (enabled) await this.#gateway.resumeSchedule(scope.workspaceId, row.name);
      else await this.#gateway.pauseSchedule(scope.workspaceId, row.name);
    }

    return { scheduleId: row.scheduleId, name: row.name, spec, delivery, overlap, enabled, updatedAt: now };
  }

  async deleteSchedule(
    scope: ResolvedScope,
    params: MethodParams<"schedule.delete">,
  ): Promise<MethodResult<"schedule.delete">> {
    const row = this.#scheduleRow(scope, params.scheduleId);
    await this.#repo.transaction(async () => {
      this.#repo.db.prepare("DELETE FROM schedules WHERE id = ?").run(row.scheduleId);
    });
    try {
      await this.#gateway.deleteSchedule(scope.workspaceId, row.name);
    } catch {
      // Already deleted upstream; the projection is what the user reads.
    }
    return { scheduleId: row.scheduleId, deleted: true };
  }

  listSchedules(
    scope: ResolvedScope,
    params: MethodParams<"schedule.list">,
  ): MethodResult<"schedule.list"> {
    return {
      schedules: this.#scheduleRows(scope.workspaceId).filter(
        (s) => params.includeDisabled || s.enabled,
      ),
    };
  }

  /** Daemon-local extension: `run-now` has no method in the core registry. */
  async triggerSchedule(scope: ResolvedScope, scheduleId: string): Promise<{ triggered: true }> {
    const row = this.#scheduleRow(scope, scheduleId);
    await this.#gateway.triggerSchedule(scope.workspaceId, row.name);
    return { triggered: true };
  }

  #scheduleRows(workspaceId: string): MethodResult<"schedule.create">[] {
    const rows = this.#repo.db
      .prepare("SELECT * FROM schedules WHERE workspace_id = ? ORDER BY name ASC")
      .all(workspaceId) as {
      id: string;
      name: string;
      spec_json: string;
      delivery_policy: string;
      enabled: number;
      updated_at: number;
    }[];
    return rows.map((row) => {
      const spec = JSON.parse(row.spec_json) as {
        cron: string;
        timezone: string;
        overlap?: string;
      };
      return {
        scheduleId: row.id,
        name: row.name,
        spec: { cron: spec.cron, timezone: spec.timezone },
        delivery: row.delivery_policy as "always" | "on-change",
        overlap: (spec.overlap ?? "skip") as "skip" | "buffer-one" | "allow",
        enabled: row.enabled === 1,
        updatedAt: row.updated_at,
      };
    });
  }

  #scheduleRow(scope: ResolvedScope, scheduleId: string): MethodResult<"schedule.create"> {
    const found = this.#scheduleRows(scope.workspaceId).find((s) => s.scheduleId === scheduleId);
    if (found === undefined) notFound(`schedule ${scheduleId}`);
    return found;
  }

  /* ------------------------------------------------------ workspace status */

  readWorkspaceStatus(
    scope: ResolvedScope,
    params: MethodParams<"workspace.status.read">,
  ): MethodResult<"workspace.status.read"> {
    const waiting = new Set<TaskStatus>([
      "waiting_clarification",
      "waiting_plan_approval",
      "waiting_review_approval",
      "waiting_user_input",
      "waiting_side_effect_approval",
      "needs_attention",
    ]);
    const active = new Set<TaskStatus>([
      "received",
      "planning",
      "running",
      "verifying",
      "reviewing",
    ]);
    const statusFor = (
      workspaceId: string,
      options: { includeSchedules: boolean; includeTaskSummaries: boolean },
    ) => {
      const tasks = options.includeTaskSummaries
        ? this.#repo.listTasks(workspaceId, { limit: 200 })
        : [];
      return {
        workspaceId,
        activeTasks: tasks.filter((task) => active.has(task.status)).map((task) => this.#summaryOf(task)),
        waitingTasks: tasks
          .filter((task) => waiting.has(task.status))
          .map((task) => this.#summaryOf(task)),
        schedules: options.includeSchedules ? this.#scheduleRows(workspaceId) : [],
        nodes: this.listNodes()
          .filter((node) => node.allowedWorkspaces.includes(workspaceId))
          .map((node) => ({
            nodeId: node.nodeId,
            profile: node.profile,
            status: node.status,
            activeRunCount: node.activeRunCount,
          })),
      };
    };
    const own = statusFor(scope.workspaceId, {
      includeSchedules: params.includeSchedules,
      includeTaskSummaries: true,
    });
    const workspaces =
      scope.role !== "head-maid"
        ? undefined
        : this.#delegations
            .visibleTargets("global")
            .filter(
              (workspaceId) =>
                this.#delegations.check("global", workspaceId, "status.read").outcome ===
                "granted",
            )
            .map((workspaceId) =>
              statusFor(workspaceId, {
                includeSchedules:
                  params.includeSchedules &&
                  this.#delegations.check("global", workspaceId, "schedule.manage").outcome ===
                    "granted",
                includeTaskSummaries:
                  this.#delegations.check("global", workspaceId, "task-summary.read").outcome ===
                  "granted",
              }),
            );
    return {
      generatedAt: this.#now(),
      activeTasks: own.activeTasks,
      waitingTasks: own.waitingTasks,
      schedules: own.schedules,
      nodes: own.nodes,
      ...(workspaces === undefined ? {} : { workspaces }),
    };
  }

  /* ------------------------------------------------------------- nodes */

  /**
   * Proves the caller IS the node it names, before anything it says is acted
   * on. `nodeId` is otherwise a bare selector, and both node methods write
   * through it: a registration rewrites that node's whole workspace binding set
   * and a heartbeat flips its status for every workspace bound to it. Neither
   * call carries a workspace scope token — a node holds no ingress binding — so
   * the per-node registration token in the params is the ONLY thing standing
   * between "the operator's node re-registering" and "any process that can
   * reach the socket unbinding another workspace's node".
   *
   * Reconciliation against local policy (10 section 6) answers a different
   * question — what this node may DO — and cannot answer this one, because it
   * consults the very self-report being authenticated.
   */
  #authenticateNode(nodeId: string, credential: string | undefined): void {
    if (!this.#nodeCredentials.verify(nodeId, credential)) {
      throw new ControlPlaneError("unauthorized_scope", NODE_REFUSED);
    }
  }

  async registerNode(
    registration: MethodParams<"node.register">,
  ): Promise<MethodResult<"node.register">> {
    this.#authenticateNode(registration.nodeId, registration.credential);
    const result = reconcileRegistration(registration as NodeRegistration, this.#nodePolicies);
    const policy = this.#config.nodePolicies.find((p) => p.nodeId === registration.nodeId);
    const heartbeatIntervalMs = policy?.heartbeatIntervalMs ?? 15_000;

    if (result.accepted && result.node !== undefined) {
      const node = result.node;
      await this.#repo.transaction(async () => {
        this.#repo.db
          .prepare(
            `INSERT INTO execution_nodes (id, protocol_version, platform, architecture, profile,
                capabilities_json, max_concurrency, status, last_heartbeat_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?, 0)
             ON CONFLICT(id) DO UPDATE SET
               protocol_version = excluded.protocol_version,
               platform = excluded.platform,
               architecture = excluded.architecture,
               profile = excluded.profile,
               capabilities_json = excluded.capabilities_json,
               max_concurrency = excluded.max_concurrency,
               status = 'online',
               last_heartbeat_at = excluded.last_heartbeat_at,
               version = execution_nodes.version + 1`,
          )
          .run(
            node.id,
            node.protocolVersion,
            node.platform,
            node.architecture,
            node.profile,
            JSON.stringify(node.capabilities),
            node.maxConcurrency,
            this.#now(),
          );
        this.#repo.db.prepare("DELETE FROM node_workspace_bindings WHERE node_id = ?").run(node.id);
        const bind = this.#repo.db.prepare(
          "INSERT OR IGNORE INTO node_workspace_bindings (node_id, workspace_id) VALUES (?, ?)",
        );
        // OPERATOR POLICY, not the node's claim. `node.allowedWorkspaces` is
        // the INTERSECTION of the two, and this statement pair rewrites the
        // whole binding set — so registering with a shorter `workspaceBindings`
        // list used to silently unbind every workspace left out of it. That is
        // narrowing, and reconciliation only ever guarded WIDENING: adding a
        // workspace needs an operator's config edit, and so, now, does removing
        // one. What the node advertises still decides what it may RUN
        // (`grantedWorkspaces` below); it does not decide what it is bound to.
        for (const workspaceId of policy?.workspaces ?? []) bind.run(node.id, workspaceId);
      });
    }

    return {
      accepted: result.accepted,
      grantedCapabilities: result.grantedCapabilities,
      grantedWorkspaces: result.grantedWorkspaces,
      maxConcurrency: Math.max(1, result.maxConcurrency),
      heartbeatIntervalMs,
      rejections: result.rejections,
    };
  }

  async heartbeatNode(
    heartbeat: MethodParams<"node.heartbeat">,
  ): Promise<MethodResult<"node.heartbeat">> {
    this.#authenticateNode(heartbeat.nodeId, heartbeat.credential);
    const known = this.#repo.db
      .prepare("SELECT id FROM execution_nodes WHERE id = ?")
      .get(heartbeat.nodeId) as { id: string } | undefined;
    if (known === undefined) {
      return { acknowledged: true, directive: "re-register" };
    }
    await this.#repo.transaction(async () => {
      this.#repo.db
        .prepare("UPDATE execution_nodes SET status = ?, last_heartbeat_at = ? WHERE id = ?")
        .run(heartbeat.status, heartbeat.timestamp, heartbeat.nodeId);
    });
    return { acknowledged: true, directive: this.#draining ? "drain" : "continue" };
  }

  listNodes(): NodeRecord[] {
    const rows = this.#repo.db
      .prepare("SELECT * FROM execution_nodes ORDER BY id ASC")
      .all() as {
      id: string;
      platform: string;
      profile: string;
      max_concurrency: number;
      status: string;
      last_heartbeat_at: number;
    }[];
    return rows.map((row) => ({
      nodeId: row.id,
      profile: row.profile,
      platform: row.platform,
      status: row.status as NodeRecord["status"],
      activeRunCount: 0,
      maxConcurrency: row.max_concurrency,
      allowedWorkspaces: (
        this.#repo.db
          .prepare("SELECT workspace_id FROM node_workspace_bindings WHERE node_id = ?")
          .all(row.id) as { workspace_id: string }[]
      ).map((b) => b.workspace_id),
      lastHeartbeatAt: row.last_heartbeat_at,
    }));
  }

  /** Version handshake used by the CLI and by meidoya-node before it starts. */
  systemInfo(): {
    controlProtocolVersion: number;
    nodeProtocolVersion: number;
    environmentId: string;
  } {
    return {
      controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
      nodeProtocolVersion: NODE_PROTOCOL_VERSION,
      environmentId: this.#config.environmentId,
    };
  }
}

export function createMethodHandlers(service: ControlPlaneService): MethodHandlers {
  return {
    "task.create": (scope, params) => service.createTask(scope, params),
    "task.get": async (scope, params) => service.getTask(scope, params),
    "task.list": async (scope, params) => service.listTasks(scope, params),
    "task.cancel": (scope, params) => service.cancelTask(scope, params),
    "task.answer": (scope, params) => service.answerTask(scope, params),
    "checkpoint.answer": (scope, params) => service.answerCheckpoint(scope, params),
    "schedule.create": (scope, params) => service.createSchedule(scope, params),
    "schedule.update": (scope, params) => service.updateSchedule(scope, params),
    "schedule.delete": (scope, params) => service.deleteSchedule(scope, params),
    "schedule.list": async (scope, params) => service.listSchedules(scope, params),
    "workspace.status.read": async (scope, params) => service.readWorkspaceStatus(scope, params),
    "node.register": (params) => service.registerNode(params),
    "node.heartbeat": (params) => service.heartbeatNode(params),
  };
}
