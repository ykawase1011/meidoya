import type {
  AdminCommand,
  DomainEventType,
  ExecutionPlan,
  HumanCheckpointKind,
  MaidDecision,
  ManagerDecision,
  ModelProfile,
  PipelineName,
  ProjectAccess,
  Provider,
  RuntimeProfile,
  ReviewFindings,
  TaskBrief,
  TaskId,
  TaskStatus,
  VerificationPlan,
  WorkerCapability,
  WorkerProfile,
  WorkerResult,
  WorkspaceId,
  WorkspacePolicy,
} from "@meidoya/domain";
import type {
  AgentInvocationPort,
  ArtifactProbePort,
  CheckpointPolicyPort,
  ClockPort,
  CommandRunnerPort,
  ExecutionBudgetPort,
  IdPort,
  InteractionPolicyPort,
  TaskRepositoryPort,
  VerificationResult,
} from "@meidoya/task-engine";
import { withHeartbeat, type HeartbeatOptions } from "./heartbeat.js";
import {
  buildCheckpoint,
  completeTask as completeTaskInEngine,
  getPipeline,
  runVerification as runVerificationInEngine,
  type CompletionCondition,
  type QualityGateCatalog,
} from "@meidoya/task-engine";

/**
 * 07 section 2: every checkpoint reaches a human as a rendered, scrubbed
 * message for its own event type — never as raw prompt text on the outbox.
 */
const CHECKPOINT_EVENT_TYPE: Readonly<Record<HumanCheckpointKind, DomainEventType>> = {
  clarification: "WaitingClarification",
  "plan-approval": "WaitingPlanApproval",
  "review-approval": "WaitingReviewApproval",
  "side-effect-approval": "WaitingSideEffectApproval",
  "limit-exceeded": "TaskNeedsAttention",
};

/* ------------------------------------------------------------------ *
 * Activity input / output types (all JSON-serializable)
 * ------------------------------------------------------------------ */

export type TaskContext = {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  pipeline: PipelineName;
  status: TaskStatus;
  version: number;
  policy: WorkspacePolicy;
  conversationId?: string;
};

export type AssessRequestInput = {
  workspaceId: WorkspaceId;
  requestKey: string;
  origin: TaskBrief["origin"];
  /** Body stays in SQLite; the workflow only passes the reference (08 section 3). */
  messageRef: string;
  interpretation?: "auto" | "schedule";
  idempotencyKey: string;
};

export type MaidWorkspaceContext = {
  activeTaskCount: number;
  waitingTaskCount: number;
  enabledScheduleCount: number;
  openTasks: Array<{ title: string; status: TaskStatus }>;
};

export type PlanTaskInput = {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  brief: TaskBrief;
  stepKey: string;
  attempt: number;
  idempotencyKey: string;
  /** Child summaries supplied only for the cross-workspace aggregate step. */
  delegationResults?: {
    workspaceId: WorkspaceId;
    status: "completed" | "failed" | "cancelled";
    summary: string;
  }[];
};

export type PlanTaskOutput =
  | { status: "planned"; plan: ExecutionPlan }
  | { status: "needs-clarification"; question: string }
  | { status: "failed"; errorClass: string; retryable: boolean };

export type WorkerStepInput = {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  brief: TaskBrief;
  stepKey: string;
  stepKind: string;
  attempt: number;
  workerProfile: WorkerProfile;
  provider: Provider;
  modelProfile: ModelProfile;
  /**
   * The AUTHORITATIVE capability grant for this run, decided by the control
   * plane (10 section 7). It is what a human approved at the side-effect gate,
   * narrowed to this step. The execution node intersects it with its own local
   * policy and can only narrow it further; nothing widens it.
   *
   * Required on purpose: a run that arrives without a grant is refused by the
   * node rather than silently given whatever the node happens to hold.
   */
  capabilities: WorkerCapability[];
  /** Authoritative project access for this run, from the approved plan. */
  projectAccess: ProjectAccess[];
  executionPlan?: ExecutionPlan;
  /** Node routing is a task-queue concern; the profile travels in the input. */
  idempotencyKey: string;
};

export type VerificationInput = {
  taskId: TaskId;
  /** Selects the workspace's operator-configured quality-gate catalog. */
  workspaceId: WorkspaceId;
  stepKey: string;
  plan: VerificationPlan;
  cwd?: string;
  expectedArtifacts?: string[];
  /**
   * The operator's quality-gate catalog, as the control plane loaded it
   * (`loadGatePolicy`). It travels WITH the activity because verification runs
   * on the execution node, which holds no workspace configuration and has no
   * RPC to fetch any: a node that receives no catalog fails closed rather than
   * inventing one. Required for that reason — an empty catalog is a decision,
   * an absent one is a bug.
   */
  qualityGates: { name: string; argv: string[] }[];
  /**
   * The project the commands run in. Optional: the node infers it when the
   * workspace binds exactly one project, and refuses to guess otherwise.
   */
  projectId?: string;
};

export type ReviewInput = {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  brief: TaskBrief;
  stepKey: string;
  attempt: number;
  provider: Provider;
  modelProfile: ModelProfile;
  capabilities: WorkerCapability[];
  projectAccess: ProjectAccess[];
  executionPlan?: ExecutionPlan;
  verification?: VerificationResult;
  idempotencyKey: string;
};

export type ManagerDecisionInput = {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  findings: ReviewFindings;
  verification?: VerificationResult;
  idempotencyKey: string;
};

export type ResolveWorkerRuntimeInput = {
  workspaceId: WorkspaceId;
  workerProfile: WorkerProfile;
};

export type ResolveWorkerRuntimeOutput = {
  runtime: RuntimeProfile;
  allowedRuntimes: RuntimeProfile[];
};

export type RecordStatusInput = {
  taskId: TaskId;
  status: TaskStatus;
  expectedVersion: number;
  eventType: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
};

export type RecordStatusOutput = { applied: boolean; version: number };

export type CreateCheckpointInput = {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  kind: HumanCheckpointKind;
  prompt: string;
  version: number;
  conversationId?: string;
  /** Gate context (06 section 1). Omitting a fact makes the gate fail CLOSED. */
  risk?: "low" | "medium" | "high";
  hasFindings?: boolean;
  securityMandated?: boolean;
  /** The Manager (or a control-plane rule) explicitly asked for this gate. */
  requested?: boolean;
};

export type CreateCheckpointOutput = { checkpointId: string; version: number; required: boolean };

/** 06 section 5: the four things that cost one step of the root budget. */
export type ChargeBudgetInput = {
  taskId: TaskId;
  /** Root task that owns the budget; children charge their root. */
  rootTaskId?: TaskId;
  kind: "agent-run" | "verification-group" | "review-group" | "manager-replan" | "fix-round" | "review-round";
  stepKey?: string;
};

export type ChargeBudgetOutput =
  | { allowed: true; stepsUsed: number }
  | { allowed: false; limit: string; stepsUsed: number; message?: string };

/**
 * 08 section 8: execution nodes never write SQLite, so the control plane records
 * what each pipeline step did. The completion check reads these back, and a step
 * nobody recorded is a step that cannot be evidence of anything.
 */
export type StepOutcomeInput = {
  taskId: TaskId;
  stepKey: string;
  stepKind: string;
  status: "succeeded" | "failed";
};

export type ExtendBudgetInput = { taskId: TaskId };
export type ExtendBudgetOutput =
  | { ok: true; maxSteps: number }
  | { ok: false; reason: "already-extended" | "unknown-budget" };

/**
 * The gate facts the workflow needs but must not take from an agent: the
 * mandatory security floor and the operator's quality-gate allowlist.
 */
export type GatePolicyOutput = {
  mandatoryGates: Partial<WorkspacePolicy["humanGates"]>;
  /**
   * The workspace's gates with the mandatory floor already applied. A workspace
   * that configured a weaker gate than the security policy demands runs with
   * the stronger one; it does not get to run with the weaker one.
   */
  effectiveGates: WorkspacePolicy["humanGates"];
  /**
   * The operator's quality-gate allowlist, or ABSENT when this deployment has
   * no gate policy wired at all.
   *
   * Absent is not empty and neither is a default: a built-in fallback made
   * "nobody configured anything" indistinguishable from "the operator chose
   * `test`", so a task could pass a gate no operator ever approved. The
   * workflow refuses to verify without a catalog, and the execution node
   * refuses a run that arrives without one.
   */
  qualityGates?: QualityGateCatalog;
};

export type EmitEventInput = {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
  conversationId?: string;
};

export type CompleteTaskInput = {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  pipeline: PipelineName;
  expectedVersion: number;
  eventId: string;
  summary: string;
  verificationRequired: boolean;
  verification?: VerificationResult;
  findings?: ReviewFindings;
  reviewGateSatisfied: boolean;
  requiredArtifactPaths: string[];
  conversationId?: string;
};

export type CompleteTaskOutput =
  | { status: "completed" }
  | { status: "rejected"; unmet: CompletionCondition[] }
  | { status: "conflict" };

export type DelegationInput = {
  environmentId: string;
  parentTaskId: TaskId;
  coordinationWorkflowId: string;
  targetWorkspaceId: WorkspaceId;
  brief: TaskBrief;
  idempotencyKey: string;
};

export type DelegationOutput = {
  childTaskId: TaskId;
  maidWorkflowId: string;
};

export type CompareInput = { taskId: TaskId; workspaceId: WorkspaceId; resultHash: string };
export type CompareOutput = { changed: boolean };

export type AdministrativeCommandInput = {
  workspaceId: WorkspaceId;
  taskId: TaskId;
  command: AdminCommand;
  conversationId?: string;
};

export type AdministrativeCommandResult = {
  title?: string;
  summary: string;
  bullets?: string[];
  sections?: Array<{ title: string; bullets: string[] }>;
};

export type FinalizeIntakeRequestInput = AdministrativeCommandResult & {
  workspaceId: WorkspaceId;
  taskId: TaskId;
  status: "completed" | "failed";
  eventId: string;
  conversationId?: string;
  presentation?: "result" | "reply";
};

export type MaterializeScheduledRequestInput = {
  workspaceId: WorkspaceId;
  requestKey: string;
  messageRef: string;
  conversationId?: string;
};

export type MaterializeScheduledRequestOutput = {
  taskId: TaskId;
  pipeline: PipelineName;
};

export type Activities = {
  loadTaskContext(input: { taskId: TaskId }): Promise<TaskContext>;
  assessRequest(input: AssessRequestInput): Promise<MaidDecision>;
  executeAdministrativeCommand(
    input: AdministrativeCommandInput,
  ): Promise<AdministrativeCommandResult>;
  finalizeIntakeRequest(input: FinalizeIntakeRequestInput): Promise<void>;
  materializeScheduledRequest(
    input: MaterializeScheduledRequestInput,
  ): Promise<MaterializeScheduledRequestOutput>;
  planTask(input: PlanTaskInput): Promise<PlanTaskOutput>;
  runWorkerStep(input: WorkerStepInput): Promise<WorkerResult>;
  runVerification(input: VerificationInput): Promise<VerificationResult>;
  runReview(input: ReviewInput): Promise<ReviewFindings>;
  decideNextAction(input: ManagerDecisionInput): Promise<ManagerDecision>;
  resolveWorkerRuntime(input: ResolveWorkerRuntimeInput): Promise<ResolveWorkerRuntimeOutput>;
  recordTaskStatus(input: RecordStatusInput): Promise<RecordStatusOutput>;
  createCheckpoint(input: CreateCheckpointInput): Promise<CreateCheckpointOutput>;
  chargeBudget(input: ChargeBudgetInput): Promise<ChargeBudgetOutput>;
  recordStepOutcome(input: StepOutcomeInput): Promise<void>;
  extendBudget(input: ExtendBudgetInput): Promise<ExtendBudgetOutput>;
  loadGatePolicy(input: { workspaceId: WorkspaceId }): Promise<GatePolicyOutput>;
  emitDomainEvent(input: EmitEventInput): Promise<void>;
  completeTask(input: CompleteTaskInput): Promise<CompleteTaskOutput>;
  createDelegation(input: DelegationInput): Promise<DelegationOutput>;
  compareWithPreviousResult(input: CompareInput): Promise<CompareOutput>;
  loadWorkspacePolicy(input: { workspaceId: WorkspaceId }): Promise<{
    policy: WorkspacePolicy;
    revision: number;
  }>;
};

/* ------------------------------------------------------------------ *
 * Implementation wiring
 * ------------------------------------------------------------------ */

export type PromptBuilder = {
  planning(input: PlanTaskInput): string;
  worker(input: WorkerStepInput): string;
  review(input: ReviewInput): string;
  managerDecision(input: ManagerDecisionInput): string;
  maidAssessment(input: AssessRequestInput, context?: MaidWorkspaceContext): string;
};

/**
 * A workspace-scoped command runner. Quality gates are per workspace, so the
 * runner is chosen by workspace rather than shared, and one workspace's
 * allowlist can never execute in another's name.
 */
export type CommandRunnerResolver = (workspaceId: WorkspaceId) => CommandRunnerPort;

export type ActivityDependencies = {
  repository: TaskRepositoryPort;
  agents: AgentInvocationPort;
  checkpointPolicy: CheckpointPolicyPort;
  budget: ExecutionBudgetPort;
  interactionPolicy: InteractionPolicyPort;
  commands: CommandRunnerPort | CommandRunnerResolver;
  artifacts: ArtifactProbePort;
  clock: ClockPort;
  ids: IdPort;
  prompts: PromptBuilder;
  policies: {
    load(workspaceId: WorkspaceId): Promise<{ policy: WorkspacePolicy; revision: number }>;
    /**
     * The mandatory security floor and quality-gate allowlist. Separate from
     * `load` because these are the facts a plan is validated AGAINST; they must
     * never be reachable from anything an agent produced.
     */
    gatePolicy?(workspaceId: WorkspaceId): Promise<GatePolicyOutput> | GatePolicyOutput;
  };
  /** Trusted project ids from control-plane configuration, never agent output. */
  workspaceProjects?: (workspaceId: WorkspaceId) => readonly string[];
  delegations: {
    create(input: DelegationInput): Promise<DelegationOutput>;
  };
  scheduledResults: {
    compare(input: CompareInput): Promise<CompareOutput>;
  };
  administration?: {
    execute(input: AdministrativeCommandInput): Promise<AdministrativeCommandResult>;
    context?(input: {
      workspaceId: WorkspaceId;
      taskId: TaskId;
    }): Promise<MaidWorkspaceContext> | MaidWorkspaceContext;
    materializeScheduledRequest(
      input: MaterializeScheduledRequestInput,
    ): Promise<MaterializeScheduledRequestOutput>;
  };
  /**
   * Heartbeating for the long-running activities (agent runs, verification).
   *
   * `MANAGER_ACTIVITY_OPTIONS` declares a `heartbeatTimeout`, which Temporal
   * enforces: without these beats every Manager call longer than a minute is
   * killed and retried to exhaustion. Injectable so a test can watch the beats;
   * production leaves it alone and gets the Activity Context's own.
   */
  heartbeat?: HeartbeatOptions;
  /** Parses an agent's structured output; throws on malformed payloads. */
  parse: {
    maidDecision(output: unknown): MaidDecision;
    plan(output: unknown): ExecutionPlan;
    workerResult(output: unknown): WorkerResult;
    reviewFindings(output: unknown): ReviewFindings;
    managerDecision(output: unknown): ManagerDecision;
  };
  routing?: {
    role(
      workspaceId: WorkspaceId,
      role: "head-maid" | "maid" | "manager",
    ): RuntimeProfile;
    worker(workspaceId: WorkspaceId, workerProfile: WorkerProfile): ResolveWorkerRuntimeOutput;
  };
};

/**
 * Every side effect of the control plane lives here: agent runs, SQLite writes,
 * command execution and chat delivery (08 section 2).
 */
export function createActivities(deps: ActivityDependencies): Activities {
  const commandsFor = (workspaceId: WorkspaceId): CommandRunnerPort =>
    typeof deps.commands === "function" ? deps.commands(workspaceId) : deps.commands;

  const beating = <T>(work: () => Promise<T>): Promise<T> =>
    withHeartbeat(work, deps.heartbeat ?? {});

  const roleRuntime = (
    workspaceId: WorkspaceId,
    role: "head-maid" | "maid" | "manager",
  ): RuntimeProfile =>
    deps.routing?.role(workspaceId, role) ?? { provider: "codex", modelProfile: "high" };

  const workerRuntime = (
    workspaceId: WorkspaceId,
    workerProfile: WorkerProfile,
  ): ResolveWorkerRuntimeOutput =>
    deps.routing?.worker(workspaceId, workerProfile) ?? {
      runtime: { provider: "codex", modelProfile: "standard" },
      allowedRuntimes: [{ provider: "codex", modelProfile: "standard" }],
    };

  const requestedRuntime = (
    input: unknown,
    fallback: RuntimeProfile,
  ): RuntimeProfile => {
    if (typeof input !== "object" || input === null) return fallback;
    const candidate = input as { provider?: unknown; modelProfile?: unknown };
    const provider = candidate.provider;
    const modelProfile = candidate.modelProfile;
    return (provider === "codex" || provider === "claude") &&
      (modelProfile === "high" || modelProfile === "standard" || modelProfile === "economy")
      ? { provider, modelProfile }
      : fallback;
  };

  const invokeAgent = async (
    invocation: Parameters<AgentInvocationPort["invoke"]>[0],
  ): Promise<unknown> => {
    // An agent run is the longest thing this process does and reports no
    // progress of its own, so the beat runs for as long as the run does.
    const result = await beating(async () => deps.agents.invoke(invocation));
    if (result.status !== "succeeded") {
      const error = new Error(
        result.status === "failed" ? `agent failed: ${result.errorClass}` : "agent cancelled",
      );
      throw error;
    }
    return result.output;
  };

  return {
    async loadTaskContext({ taskId }) {
      const task = await deps.repository.loadTask(taskId);
      if (!task) throw new Error(`unknown task ${taskId}`);
      const { policy } = await deps.policies.load(task.workspaceId);
      const context: TaskContext = {
        taskId: task.id,
        workspaceId: task.workspaceId,
        pipeline: task.pipeline,
        status: task.status,
        version: task.version,
        policy,
      };
      if (task.conversationId !== undefined) context.conversationId = task.conversationId;
      return context;
    },

    async assessRequest(input) {
      const runtime = roleRuntime(input.workspaceId, "maid");
      const context = await deps.administration?.context?.({
        workspaceId: input.workspaceId,
        taskId: `task-${input.requestKey}`,
      });
      const output = await invokeAgent({
        runId: deps.ids.next("run"),
        taskId: input.requestKey,
        actor: { role: "maid" },
        provider: runtime.provider,
        modelProfile: runtime.modelProfile,
        scope: { workspaceId: input.workspaceId, projectAccess: [], capabilities: [] },
        prompt: deps.prompts.maidAssessment(input, context),
        idempotencyKey: input.idempotencyKey,
      });
      const decision = deps.parse.maidDecision(output);
      if (decision.type === "quick" || decision.type === "durable") {
        const configured = deps.workspaceProjects?.(input.workspaceId);
        if (configured !== undefined) {
          const allowed = new Set(configured);
          const invalid = decision.brief.projects.filter((projectId) => !allowed.has(projectId));
          if (invalid.length > 0) {
            return {
              type: "out_of_scope",
              reason: `Maid selected project ids outside workspace ${input.workspaceId}`,
            };
          }
        }
      }
      return decision;
    },

    async executeAdministrativeCommand(input) {
      if (deps.administration === undefined) {
        throw new Error("administrative commands are not configured");
      }
      return deps.administration.execute(input);
    },

    async finalizeIntakeRequest(input) {
      const current = await deps.repository.loadTask(input.taskId);
      if (current === undefined || current.workspaceId !== input.workspaceId) {
        throw new Error(`unknown administrative task ${input.taskId}`);
      }
      if (current.status === input.status) return;
      if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
        throw new Error(`administrative task ${input.taskId} is already ${current.status}`);
      }

      const event = {
        id: input.eventId,
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        type:
          input.status === "completed"
            ? input.presentation === "reply"
              ? ("MaidResponded" as const)
              : ("TaskCompleted" as const)
            : ("TaskFailed" as const),
        payload: {
          ...(input.title === undefined ? {} : { title: input.title }),
          summary: input.summary,
          ...(input.bullets === undefined ? {} : { bullets: input.bullets }),
          ...(input.sections === undefined ? {} : { sections: input.sections }),
          ...(input.conversationId === undefined
            ? {}
            : { conversationId: input.conversationId }),
        },
        createdAt: deps.clock.now(),
      };
      const intents = await deps.interactionPolicy.emit(event);
      await deps.repository.transaction(async (tx) => {
        const updated = await tx.updateTaskStatus({
          taskId: input.taskId,
          nextStatus: input.status,
          expectedVersion: current.version,
        });
        if (!updated) throw new Error(`administrative task ${input.taskId} changed concurrently`);
        await tx.appendTaskEvent({
          taskId: input.taskId,
          eventType: event.type,
          idempotencyKey: `intake:${input.taskId}:${event.type}`,
          payload: event.payload,
        });
        for (const intent of intents) await tx.enqueueNotification(intent);
      });
      await deps.interactionPolicy.recordEmitted(intents);
      await deps.interactionPolicy.publish(event);
    },

    async materializeScheduledRequest(input) {
      if (deps.administration === undefined) {
        throw new Error("scheduled request materialization is not configured");
      }
      return deps.administration.materializeScheduledRequest(input);
    },

    async planTask(input) {
      const runtime = requestedRuntime(input, roleRuntime(input.workspaceId, "manager"));
      const output = await invokeAgent({
        runId: deps.ids.next("run"),
        taskId: input.taskId,
        stepKey: input.stepKey,
        actor: { role: "manager" },
        provider: runtime.provider,
        modelProfile: runtime.modelProfile,
        scope: { workspaceId: input.workspaceId, projectAccess: [], capabilities: [] },
        prompt: deps.prompts.planning(input),
        idempotencyKey: input.idempotencyKey,
      });
      return { status: "planned", plan: deps.parse.plan(output) };
    },

    async runWorkerStep(input) {
      const output = await invokeAgent({
        runId: deps.ids.next("run"),
        taskId: input.taskId,
        stepKey: input.stepKey,
        actor: { role: "worker", profile: input.workerProfile },
        provider: input.provider,
        modelProfile: input.modelProfile,
        // 10 section 7: the run scope is the control plane's, derived from the
        // task's workspace and from what a human approved at the side-effect
        // gate. Sending an empty grant here made every gate answer inert.
        scope: {
          workspaceId: input.workspaceId,
          projectAccess: [...input.projectAccess],
          capabilities: [...input.capabilities],
        },
        prompt: deps.prompts.worker(input),
        idempotencyKey: input.idempotencyKey,
      });
      return deps.parse.workerResult(output);
    },

    async runVerification(input) {
      const options: Parameters<typeof runVerificationInEngine>[2] = {};
      if (input.cwd !== undefined) options.cwd = input.cwd;
      if (input.expectedArtifacts !== undefined) {
        options.expectedArtifacts = input.expectedArtifacts;
      }
      return beating(() =>
        runVerificationInEngine(
          input.plan,
          { commands: commandsFor(input.workspaceId), artifacts: deps.artifacts },
          options,
        ),
      );
    },

    async runReview(input) {
      const runtime = requestedRuntime(input, workerRuntime(input.workspaceId, "reviewer").runtime);
      const output = await invokeAgent({
        runId: deps.ids.next("run"),
        taskId: input.taskId,
        stepKey: input.stepKey,
        actor: { role: "worker", profile: "reviewer" },
        provider: runtime.provider,
        modelProfile: runtime.modelProfile,
        scope: { workspaceId: input.workspaceId, projectAccess: [], capabilities: [] },
        prompt: deps.prompts.review(input),
        idempotencyKey: input.idempotencyKey,
      });
      return deps.parse.reviewFindings(output);
    },

    async decideNextAction(input) {
      const runtime = requestedRuntime(input, roleRuntime(input.workspaceId, "manager"));
      const output = await invokeAgent({
        runId: deps.ids.next("run"),
        taskId: input.taskId,
        actor: { role: "manager" },
        provider: runtime.provider,
        modelProfile: runtime.modelProfile,
        scope: { workspaceId: input.workspaceId, projectAccess: [], capabilities: [] },
        prompt: deps.prompts.managerDecision(input),
        idempotencyKey: input.idempotencyKey,
      });
      return deps.parse.managerDecision(output);
    },

    async resolveWorkerRuntime(input) {
      return workerRuntime(input.workspaceId, input.workerProfile);
    },

    async recordTaskStatus(input) {
      return deps.repository.transaction(async (tx) => {
        const applied = await tx.updateTaskStatus({
          taskId: input.taskId,
          nextStatus: input.status,
          expectedVersion: input.expectedVersion,
        });
        if (applied) {
          await tx.appendTaskEvent({
            taskId: input.taskId,
            eventType: input.eventType,
            idempotencyKey: input.idempotencyKey,
            payload: input.payload ?? {},
          });
        }
        // Reads through the handle are synchronous: the span already holds the
        // connection, so there is nothing to await.
        const task = tx.loadTask(input.taskId);
        return { applied, version: task?.version ?? input.expectedVersion };
      });
    },

    async createCheckpoint(input) {
      const decision = await deps.checkpointPolicy.evaluate({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        ...(input.risk === undefined ? {} : { risk: input.risk }),
        ...(input.hasFindings === undefined ? {} : { hasFindings: input.hasFindings }),
        ...(input.securityMandated === undefined
          ? {}
          : { securityMandated: input.securityMandated }),
        ...(input.requested === undefined ? {} : { requested: input.requested }),
      });
      if (!decision.required) return { checkpointId: "", version: input.version, required: false };

      const checkpoint = buildCheckpoint({
        id: deps.ids.next("checkpoint"),
        taskId: input.taskId,
        kind: input.kind,
        // `input.prompt` is model text on some paths. It is stored for the
        // operator UI but only ever leaves the process through the interaction
        // policy's whitelist + scrubber below (07 section 9).
        prompt: decision.prompt || input.prompt,
        choices: decision.choices,
        version: input.version,
      });

      const event = {
        id: checkpoint.id,
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        type: CHECKPOINT_EVENT_TYPE[input.kind],
        payload: {
          checkpointId: checkpoint.id,
          checkpointVersion: checkpoint.version,
          prompt: checkpoint.prompt,
          choices: checkpoint.choices,
          ...(input.conversationId === undefined
            ? {}
            : { conversationId: input.conversationId }),
        },
        createdAt: deps.clock.now(),
      };
      const intents = await deps.interactionPolicy.emit(event);

      await deps.repository.transaction(async (tx) => {
        await tx.recordCheckpoint(checkpoint);
        for (const intent of intents) {
          await tx.enqueueNotification(
            input.conversationId === undefined
              ? intent
              : { ...intent, conversationId: input.conversationId },
          );
        }
      });
      // Both only after the checkpoint row and its outbox intents are durable:
      // the ledger may remember only rows the database holds, and a subscriber
      // is never told about a checkpoint the database does not hold.
      await deps.interactionPolicy.recordEmitted(intents);
      await deps.interactionPolicy.publish(event);
      return { checkpointId: checkpoint.id, version: checkpoint.version, required: true };
    },

    async recordStepOutcome(input) {
      const steps = await deps.repository.listSteps(input.taskId);
      const existing = steps.find((step) => step.stepKey === input.stepKey);
      await deps.repository.upsertStep({
        taskId: input.taskId,
        stepKey: input.stepKey,
        stepKind: input.stepKind,
        status: input.status,
        visitCount: (existing?.visitCount ?? 0) + 1,
        attemptCount: (existing?.attemptCount ?? 0) + 1,
      });
    },

    async chargeBudget(input) {
      const decision = await deps.budget.charge({
        taskId: input.taskId,
        ...(input.rootTaskId === undefined ? {} : { rootTaskId: input.rootTaskId }),
        kind: input.kind,
        ...(input.stepKey === undefined ? {} : { stepKey: input.stepKey }),
      });
      if (decision.allowed) return { allowed: true, stepsUsed: decision.stepsUsed };
      return {
        allowed: false,
        limit: decision.limit,
        stepsUsed: decision.stepsUsed,
        ...(decision.message === undefined ? {} : { message: decision.message }),
      };
    },

    async extendBudget(input) {
      return deps.budget.extendOnce(input.taskId);
    },

    async loadGatePolicy({ workspaceId }) {
      if (deps.policies.gatePolicy === undefined) {
        // No gate policy wired: report the workspace's gates and NO catalog.
        // Substituting a built-in default here is what let a task pass a
        // quality gate nobody configured.
        const { policy } = await deps.policies.load(workspaceId);
        return { mandatoryGates: {}, effectiveGates: policy.humanGates };
      }
      return deps.policies.gatePolicy(workspaceId);
    },

    async emitDomainEvent(input) {
      const event = {
        id: input.eventId,
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        type: input.type as never,
        payload: input.payload,
        createdAt: deps.clock.now(),
      };
      const intents = await deps.interactionPolicy.emit(event);
      await deps.repository.transaction(async (tx) => {
        await tx.appendTaskEvent({
          taskId: input.taskId,
          eventType: input.type,
          idempotencyKey: `event:${input.eventId}`,
          payload: input.payload,
        });
        for (const intent of intents) {
          await tx.enqueueNotification(
            input.conversationId === undefined
              ? intent
              : { ...intent, conversationId: input.conversationId },
          );
        }
      });
      // Both only after the task event and its outbox intents are durable.
      await deps.interactionPolicy.recordEmitted(intents);
      await deps.interactionPolicy.publish(event);
    },

    async completeTask(input) {
      const stored = await deps.repository.listArtifacts(input.taskId);
      const steps = await deps.repository.listSteps(input.taskId);
      const result = await completeTaskInEngine({
        state: {
          taskId: input.taskId,
          pipeline: input.pipeline,
          lane: "durable",
          status: "reviewing",
          version: input.expectedVersion,
          startedAt: 0,
          updatedAt: deps.clock.now(),
        },
        taskVersion: input.expectedVersion,
        event: {
          id: input.eventId,
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          type: "TaskCompleted",
          // The conversation the request arrived on travels ON THE EVENT, which
          // is the only way it reaches the outbox row: the interaction policy
          // reads `payload.conversationId` when it builds every intent, and the
          // completion intents are enqueued inside the engine's transaction
          // where nothing else can thread it on afterwards. Without it the row
          // has no conversation, the resolver cannot recover one (the engine's
          // task event is keyed `task:<id>:completed`, not `event:<eventId>`,
          // and `payload.taskId` is not persisted), and EVERY `TaskCompleted`
          // dead-letters — the one message the quiet-UX design exists to send.
          payload: {
            summary: input.summary,
            ...(input.conversationId === undefined
              ? {}
              : { conversationId: input.conversationId }),
          },
          createdAt: deps.clock.now(),
        },
        conditions: {
          pipeline: getPipeline(input.pipeline),
          steps: steps.map((s) => ({ stepKey: s.stepKey, status: s.status })),
          verificationRequired: input.verificationRequired,
          ...(input.verification !== undefined ? { verification: input.verification } : {}),
          ...(input.findings !== undefined ? { findings: input.findings } : {}),
          reviewGateSatisfied: input.reviewGateSatisfied,
          requiredArtifactPaths: input.requiredArtifactPaths,
          storedArtifactPaths: stored.map((a) => a.path),
        },
        now: deps.clock.now(),
        ports: { repository: deps.repository, interactionPolicy: deps.interactionPolicy },
      });

      if (result.ok) return { status: "completed" };
      if (result.reason === "conditions-unmet") return { status: "rejected", unmet: result.unmet };
      if (result.reason === "version-conflict") return { status: "conflict" };
      return { status: "rejected", unmet: ["completion-notification-registered"] };
    },

    async createDelegation(input) {
      return deps.delegations.create(input);
    },

    async compareWithPreviousResult(input) {
      return deps.scheduledResults.compare(input);
    },

    async loadWorkspacePolicy({ workspaceId }) {
      return deps.policies.load(workspaceId);
    },
  };
}
