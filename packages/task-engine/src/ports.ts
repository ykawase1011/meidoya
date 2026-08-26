import type {
  AgentRunId,
  ArtifactRef,
  CheckpointChoice,
  CheckpointId,
  DomainEvent,
  EvidenceRef,
  HumanCheckpoint,
  HumanCheckpointKind,
  ModelProfile,
  ProjectAccess,
  Provider,
  StepId,
  Task,
  TaskId,
  TaskStatus,
  WorkerProfile,
  WorkspaceId,
} from "@meidoya/domain";

export type MaybePromise<T> = T | Promise<T>;

/* ------------------------------------------------------------------ *
 * Agent invocation
 * ------------------------------------------------------------------ */

export type AgentActor =
  | { role: "head-maid" | "maid" | "manager" }
  | { role: "worker"; profile: WorkerProfile };

export type AgentInvocationScope = {
  workspaceId: WorkspaceId;
  projectAccess: ProjectAccess[];
  capabilities: string[];
};

export type AgentInvocation = {
  runId: AgentRunId;
  taskId: TaskId;
  stepKey?: string;
  actor: AgentActor;
  provider: Provider;
  modelProfile: ModelProfile;
  scope: AgentInvocationScope;
  prompt: string;
  /** 08 section 10: retries must not double-apply an agent run. */
  idempotencyKey: string;
  resumeSessionId?: string;
};

export type AgentInvocationResult =
  | { status: "succeeded"; output: unknown; externalSessionId?: string }
  | { status: "failed"; errorClass: string; retryable: boolean }
  | { status: "cancelled" };

export type AgentInvocationPort = {
  invoke(invocation: AgentInvocation): MaybePromise<AgentInvocationResult>;
};

/* ------------------------------------------------------------------ *
 * Checkpoint policy (implemented by @meidoya/checkpoint-policy)
 * ------------------------------------------------------------------ */

export type CheckpointPolicyQuery = {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  kind: HumanCheckpointKind;
  risk?: "low" | "medium" | "high";
  hasFindings?: boolean;
  /** true when a mandatory security policy demands the gate. */
  securityMandated?: boolean;
  /**
   * true when the Manager (or the control plane) explicitly asked for this
   * checkpoint. `when-needed` gates only exist because someone asked; the flag
   * can raise a gate's requirement, never lower it.
   */
  requested?: boolean;
};

export type CheckpointPolicyDecision =
  | { required: false }
  | { required: true; prompt: string; choices: CheckpointChoice[] };

export type CheckpointPolicyPort = {
  evaluate(query: CheckpointPolicyQuery): MaybePromise<CheckpointPolicyDecision>;
};

/* ------------------------------------------------------------------ *
 * Execution budget (implemented by @meidoya/execution-budget)
 * ------------------------------------------------------------------ */

export type BudgetChargeKind =
  | "agent-run"
  | "verification-group"
  | "review-group"
  | "manager-replan"
  /** Loop guards (06 section 6). These consume a round, not a step. */
  | "fix-round"
  | "review-round";

export type BudgetCharge = {
  /** The task the step belongs to; may be a child of the budget owner. */
  taskId: TaskId;
  /**
   * The root task whose budget is charged. 06 section 4: `max_steps` is a ROOT
   * budget spanning child tasks and subworkflows, so splitting work into
   * children must not mint a new one. Defaults to `taskId`.
   */
  rootTaskId?: TaskId;
  kind: BudgetChargeKind;
  stepKey?: string;
};

export type BudgetLimitName =
  | "max_steps"
  | "max_step_visits"
  | "max_fix_rounds"
  | "max_review_rounds"
  | "max_no_progress_rounds"
  | "max_parallel_workers"
  | "max_model_escalations"
  | "max_consecutive_failures"
  | "max_wall_time";

export type BudgetDecision =
  | { allowed: true; stepsUsed: number }
  | { allowed: false; limit: BudgetLimitName; stepsUsed: number; message?: string };

/** 06 section 8: the budget may be extended exactly once, by a human. */
export type BudgetExtension =
  | { ok: true; maxSteps: number }
  | { ok: false; reason: "already-extended" | "unknown-budget" };

export type ExecutionBudgetPort = {
  charge(charge: BudgetCharge): MaybePromise<BudgetDecision>;
  snapshot(taskId: TaskId): MaybePromise<{ stepsUsed: number }>;
  extendOnce(taskId: TaskId): MaybePromise<BudgetExtension>;
};

/* ------------------------------------------------------------------ *
 * Interaction policy emission (implemented by @meidoya/interaction-policy)
 * ------------------------------------------------------------------ */

export type OutboxIntent = {
  workspaceId: WorkspaceId;
  conversationId?: string;
  eventId: string;
  action: "add-reaction" | "remove-reaction" | "post-thread-message" | "update-message";
  idempotencyKey: string;
  payload: Record<string, unknown>;
};

export type InteractionPolicyPort = {
  /**
   * Domain event in, zero or more outbox intents out. Never LLM-decided.
   *
   * Deriving intents must have no observable effect: a caller may compute them
   * and then decide not to act. `emit` used to publish to the live event bus as
   * its first statement, so a `TaskCompleted` reached every watching client
   * before `evaluateCompletion` ran — and a task whose verification had failed
   * announced completion and then went to `needs_attention`.
   */
  emit(event: DomainEvent): MaybePromise<OutboxIntent[]>;
  /**
   * Records that these intents are DURABLE — call only after the transaction
   * that enqueued them has committed.
   *
   * The ledger this keeps is what turns a repeat of a checkpoint into an EDIT
   * of the message already posted (07 section 4). `emit` used to write it
   * itself, before any transaction and in process memory: when attempt 1's
   * transaction threw (SQLITE_BUSY, or the write queue closing during
   * shutdown), Temporal retried the activity with the same event, `emit` found
   * the key already "emitted", and degraded the post into an `update-message`
   * aimed at a row that was never inserted. The operator got a reaction and no
   * explanation, and the update dead-lettered. The ledger must reflect what is
   * durable, not what was computed.
   */
  recordEmitted(intents: readonly OutboxIntent[]): MaybePromise<void>;
  /**
   * Announces the event to live subscribers. Call only after the durable write
   * that the event describes has committed, so a subscriber is never told
   * something the database does not agree with.
   */
  publish(event: DomainEvent): MaybePromise<void>;
};

/* ------------------------------------------------------------------ *
 * Task repository
 * ------------------------------------------------------------------ */

export type StepRecord = {
  id: StepId;
  taskId: TaskId;
  stepKey: string;
  stepKind: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  visitCount: number;
  attemptCount: number;
  version: number;
};

export type TaskRepositoryPort = {
  loadTask(taskId: TaskId): MaybePromise<Task | undefined>;
  /** 08 section 9: version-guarded update; false means a concurrency conflict. */
  updateTaskStatus(args: {
    taskId: TaskId;
    nextStatus: TaskStatus;
    expectedVersion: number;
    pipeline?: Task["pipeline"];
  }): MaybePromise<boolean>;
  appendTaskEvent(args: {
    taskId: TaskId;
    eventType: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): MaybePromise<void>;
  upsertStep(step: Omit<StepRecord, "id" | "version"> & { id?: StepId }): MaybePromise<StepRecord>;
  listSteps(taskId: TaskId): MaybePromise<StepRecord[]>;
  recordCheckpoint(checkpoint: HumanCheckpoint): MaybePromise<void>;
  loadCheckpoint(id: CheckpointId): MaybePromise<HumanCheckpoint | undefined>;
  saveArtifacts(taskId: TaskId, artifacts: ArtifactRef[]): MaybePromise<void>;
  listArtifacts(taskId: TaskId): MaybePromise<ArtifactRef[]>;
  enqueueNotification(intent: OutboxIntent): MaybePromise<void>;
  /**
   * All writes inside fn commit or roll back together (05 section 10).
   *
   * The body receives a HANDLE, and every write it wants inside the span must
   * be issued through it. An implementation that can tell the two apart (the
   * SQLite one does, by the body's arity) refuses ambient writes from a body
   * that took the handle, because an ambient write cannot be distinguished
   * from a callee's write silently joining someone else's transaction.
   */
  transaction<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T>;
};

/**
 * The write surface of one open transaction span.
 *
 * Reads are SYNCHRONOUS here: inside a span the connection is already held, so
 * there is nothing to await and awaiting would only widen the window.
 */
export type TransactionHandle = {
  updateTaskStatus(args: {
    taskId: TaskId;
    nextStatus: TaskStatus;
    expectedVersion: number;
    pipeline?: Task["pipeline"];
  }): MaybePromise<boolean>;
  appendTaskEvent(args: {
    taskId: TaskId;
    eventType: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): MaybePromise<void>;
  upsertStep(step: Omit<StepRecord, "id" | "version"> & { id?: StepId }): MaybePromise<StepRecord>;
  recordCheckpoint(checkpoint: HumanCheckpoint): MaybePromise<void>;
  saveArtifacts(taskId: TaskId, artifacts: ArtifactRef[]): MaybePromise<void>;
  enqueueNotification(intent: OutboxIntent): MaybePromise<void>;
  loadTask(taskId: TaskId): Task | undefined;
  loadCheckpoint(id: CheckpointId): HumanCheckpoint | undefined;
  listSteps(taskId: TaskId): StepRecord[];
};

/* ------------------------------------------------------------------ *
 * Command execution (verification)
 * ------------------------------------------------------------------ */

/**
 * What a runner is asked to execute. `name` selects an operator-configured
 * quality gate; the runner resolves the argv from its own allowlist, so nothing
 * in this spec is ever handed to a shell.
 */
export type CommandSpec = {
  name: string;
  /** @deprecated Legacy free-form command line; runners must ignore it. */
  command?: string;
  cwd?: string;
};

export type CommandExecution = {
  exitCode: number;
  durationMs: number;
  /** The allowlisted argv the runner actually executed, for evidence/display. */
  resolvedCommand?: string;
  evidence?: EvidenceRef;
  artifacts?: ArtifactRef[];
  /** Stable signature of the failure used for no-progress detection. */
  failureSignature?: string;
};

export type CommandRunnerPort = {
  run(spec: CommandSpec): MaybePromise<CommandExecution>;
};

export type ArtifactProbePort = {
  exists(path: string): MaybePromise<boolean>;
};

/* ------------------------------------------------------------------ *
 * Ambient
 * ------------------------------------------------------------------ */

export type ClockPort = { now(): number };
export type IdPort = { next(prefix: string): string };

export type TaskEnginePorts = {
  repository: TaskRepositoryPort;
  agents: AgentInvocationPort;
  checkpointPolicy: CheckpointPolicyPort;
  budget: ExecutionBudgetPort;
  interactionPolicy: InteractionPolicyPort;
  commands: CommandRunnerPort;
  artifacts: ArtifactProbePort;
  clock: ClockPort;
  ids: IdPort;
};
