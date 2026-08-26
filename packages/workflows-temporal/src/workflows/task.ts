import {
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  patched,
  proxyActivities,
  setHandler,
  sleep,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type {
  HumanCheckpointKind,
  PipelineName,
  ReviewFindings,
  TaskBrief,
  TaskId,
  TaskStatus,
  VerificationPlan,
  WorkerCapability,
  WorkspaceId,
  WorkspacePolicy,
} from "@meidoya/domain";
import {
  advancePipeline,
  applyManagerDecision,
  createTaskMachineState,
  enterGate,
  gateGrantsProgress,
  gateResumeStatus,
  getPipeline,
  isQuickSoftDeadlineExceeded,
  isTerminal,
  promoteQuickToDurable,
  quickLaneWaivesGate,
  recordReviewRound,
  transition,
  validateExecutionPlan,
  type PipelineOutcome,
  type PipelineStep,
  type QualityGateCatalog,
  type ReviewLoopState,
  type TaskLane,
  type TaskMachineState,
  type VerificationResult,
} from "@meidoya/task-engine";

import type {
  Activities,
  ChargeBudgetInput,
  ManagerDecisionInput,
  PlanTaskInput,
  ReviewInput,
} from "../activities.js";
import { recordCheckpointAnswer } from "../answer-queue.js";
import {
  DB_ACTIVITY_OPTIONS,
  MANAGER_ACTIVITY_OPTIONS,
  NOTIFICATION_ACTIVITY_OPTIONS,
  VERIFICATION_ACTIVITY_OPTIONS,
  WORKER_ACTIVITY_OPTIONS,
} from "../retry-policies.js";
import { agentRunKey, taskEventKey } from "../idempotency.js";
import { nodeTaskQueue } from "../task-queues.js";
import {
  TASK_SIDE_EFFECT_GATE_GRANT,
  TASK_SIDE_EFFECT_GATE_PIPELINE,
  TASK_SIDE_EFFECT_GATE_UNION,
  TASK_MODEL_POLICY_ROUTING,
} from "../patches.js";
import { capabilityGrantedSteps, stepsTaskWorkflowCannotRun } from "../pipelines-guard.js";
import { isVacuousVerification, verificationProjectId } from "../verification-scope.js";
import {
  BASE_CAPABILITIES,
  derivePlanCapabilities,
  derivePlanSideEffectCapabilities,
  derivePlanSideEffectCapabilitiesIsolated,
  derivePlanSideEffectCapabilitiesPerStepGrant,
  derivePipelineSideEffectCapabilities,
  grantForStep,
  plannedKindOfPipelineKind,
} from "../plan-capabilities.js";

export type TaskWorkflowInput = {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  environmentId: string;
  pipeline: PipelineName;
  lane: TaskLane;
  brief: TaskBrief;
  policy: WorkspacePolicy;
  /** Execution node whose task queue runs the Worker activities. */
  executionNodeId: string;
  conversationId?: string;
  taskVersion: number;
  /**
   * The task at the top of this tree. 06 section 4: `max_steps` is a ROOT
   * budget spanning child tasks and subworkflows, so a child charges its root
   * rather than opening a budget of its own. Defaults to `taskId`.
   */
  rootTaskId?: TaskId;
  /** Quick lane only. */
  quickSoftDeadlineMs?: number;
  promoteTo?: PipelineName;
};

export type CheckpointAnswer = {
  checkpointId: string;
  answer: "approved" | "rejected" | "answered";
  text?: string;
};

export const taskAnswerCheckpointSignal = defineSignal<[CheckpointAnswer]>("answerCheckpoint");
export const taskCancelTaskSignal = defineSignal<[string]>("cancelTask");
export const taskRefreshPolicySignal = defineSignal<[WorkspacePolicy]>("refreshPolicy");

export type TaskSnapshot = {
  status: TaskStatus;
  lane: TaskLane;
  pipeline: PipelineName;
  currentStepKey?: string;
  pendingCheckpointId?: string;
  version: number;
  /** Steps of the root budget consumed so far (06 section 5). */
  stepsUsed: number;
};

export const taskSnapshotQuery = defineQuery<TaskSnapshot>("taskSnapshot");

export type TaskWorkflowResult = {
  taskId: TaskId;
  status: TaskStatus;
  lane: TaskLane;
  pipeline: PipelineName;
  promoted: boolean;
  summary: string;
};

const db = proxyActivities<Activities>(DB_ACTIVITY_OPTIONS);
const notify = proxyActivities<Activities>(NOTIFICATION_ACTIVITY_OPTIONS);
const manager = proxyActivities<Activities>(MANAGER_ACTIVITY_OPTIONS);

/** Context the checkpoint policy needs; never sourced from an agent. */
type GateContext = {
  risk?: "low" | "medium" | "high";
  hasFindings?: boolean;
  securityMandated?: boolean;
  requested?: boolean;
};

/**
 * The operator-facing text of an activity failure.
 *
 * Deterministic: it reads only the failure's own fields, walking `cause` so the
 * node's refusal ("quality gate `test` is not in this node's catalog") reaches
 * the human rather than Temporal's generic "Activity task failed".
 */
function failureMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current.message !== "") parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (parts.length === 0) return "unknown activity failure";
  return [...new Set(parts)].join(": ");
}

/** The answers that mean "extend the budget once", per 06 section 8's choices. */
const EXTEND_ANSWERS = ["extend", "extend-once", "extend budget once"];

function requestsExtension(
  answer: CheckpointAnswer["answer"],
  text: string | undefined,
): boolean {
  if (answer === "approved") return true;
  if (answer === "rejected" || text === undefined) return false;
  return EXTEND_ANSWERS.includes(text.trim().toLowerCase());
}

export type TaskWorkflowVersion = {
  /** {@link TASK_SIDE_EFFECT_GATE_GRANT} */
  readonly sideEffectGateGrant: boolean;
  /** {@link TASK_SIDE_EFFECT_GATE_UNION} */
  readonly sideEffectGateUnion: boolean;
  /** {@link TASK_SIDE_EFFECT_GATE_PIPELINE} */
  readonly sideEffectGatePipeline: boolean;
  /** {@link TASK_MODEL_POLICY_ROUTING} */
  readonly modelPolicyRouting: boolean;
};

/**
 * Drives the task-engine state machine. Every agent run, SQLite write, command
 * execution and chat post happens in an Activity (08 section 2/4).
 *
 * Two invariants this workflow exists to hold:
 *  - every counted unit of work is charged to the ROOT execution budget BEFORE
 *    it runs (06 sections 4/5), so no loop can run unbounded; and
 *  - every human gate is decided by the checkpoint policy, never by an agent's
 *    own output (06 sections 1/2).
 */
export async function TaskWorkflow(input: TaskWorkflowInput): Promise<TaskWorkflowResult> {
  /**
   * Every versioning decision is taken ONCE, here, before any command is issued
   * (see `../patches.ts` and README § Workflow versioning).
   *
   * Taking them at workflow start rather than at each changed block is
   * deliberate: `patched()` answers "false" only while replaying history that
   * predates the patch, so a decision taken deep in the workflow could come out
   * `true` for an execution whose earlier, correlated decision came out `false`
   * — which for the gate patches would mean asking a human the same question
   * twice. Deciding at the top means one execution follows one path end to end.
   *
   * It costs one `MarkerRecorded` + one `UpsertWorkflowSearchAttributes` per
   * live id per execution, whether or not the gated code is reached; the README
   * (§ Where the decision is taken) carries the arithmetic and the ceiling.
   */
  return runTaskWorkflow(input, {
    sideEffectGateGrant: patched(TASK_SIDE_EFFECT_GATE_GRANT),
    sideEffectGateUnion: patched(TASK_SIDE_EFFECT_GATE_UNION),
    sideEffectGatePipeline: patched(TASK_SIDE_EFFECT_GATE_PIPELINE),
    modelPolicyRouting: patched(TASK_MODEL_POLICY_ROUTING),
  });
}

/**
 * The workflow body, with the versioning decisions passed in.
 *
 * Split out so the legacy branches can be driven directly from a test: they are
 * otherwise reachable only by replaying a pre-patch history, which cannot see
 * activity ARGUMENTS at all and so cannot check what a legacy path grants.
 * `patched()` is never called from here — a workflow must take that decision
 * before it issues its first command.
 */
export async function runTaskWorkflow(
  input: TaskWorkflowInput,
  version: TaskWorkflowVersion,
): Promise<TaskWorkflowResult> {
  const worker = proxyActivities<Activities>({
    ...WORKER_ACTIVITY_OPTIONS,
    taskQueue: nodeTaskQueue(input.executionNodeId),
  });
  // 10 section 3: verification commands run in the execution node's sandbox, so
  // the activity has to be dispatched to the NODE's task queue exactly as the
  // Worker activities are. Without this it was served by the control plane,
  // outside any sandbox, and the node's registration was dead code.
  const verifier = proxyActivities<Activities>({
    ...VERIFICATION_ACTIVITY_OPTIONS,
    taskQueue: nodeTaskQueue(input.executionNodeId),
  });
  const reviewer = proxyActivities<Activities>({
    ...WORKER_ACTIVITY_OPTIONS,
    taskQueue: nodeTaskQueue(input.executionNodeId),
  });

  const rootTaskId = input.rootTaskId ?? input.taskId;
  let policy = input.policy;
  let machine: TaskMachineState = createTaskMachineState({
    taskId: input.taskId,
    pipeline: input.pipeline,
    lane: input.lane,
    now: Date.now(),
  });
  let taskVersion = input.taskVersion;
  let promoted = false;
  let cancelReason: string | undefined;
  let pendingCheckpointId: string | undefined;
  const answers: CheckpointAnswer[] = [];
  let eventSequence = 0;
  let attempt = 0;
  let loop: ReviewLoopState = { reviewRounds: 0, fixRounds: 0, fingerprints: [] };
  let verification: VerificationResult | undefined;
  let findings: ReviewFindings | undefined;
  let requiredArtifactPaths: string[] = [];
  let plannedVerification: VerificationPlan | undefined;
  let executionPlan: import("@meidoya/domain").ExecutionPlan | undefined;
  let taskSummary = input.brief.summary;
  /**
   * The capability grant the control plane decided for this plan, gate answer
   * included. It travels with every Worker activity as the authoritative run
   * scope (10 section 7); before a plan exists there is nothing to grant, so a
   * Worker run that somehow happens first gets the read-only floor.
   */
  let planGrant: WorkerCapability[] = ["repo.read"];
  // Quick tasks have no plan step. Their Maid-selected TaskBrief projects are
  // already checked against the workspace catalog, so retain them as a
  // read-only floor instead of broadening an empty scope to every node binding.
  // A validated ExecutionPlan replaces this list before any write-capable step.
  let planProjects: { projectId: string; mode: "read" | "write" }[] = input.brief.projects.map(
    (projectId) => ({ projectId, mode: "read" }),
  );
  let stepsUsed = 0;
  const stepVisits: Record<string, number> = {};

  /**
   * The answer of the most recent `review-approval` gate. Only a human answer
   * sets it; an agent's `complete` decision must not.
   *
   * Every `review-approval` gate the shipped pipelines can raise is the last
   * thing before completion (`pipelines-guard.test.ts` holds that property), so
   * this is never a stale answer about work that has changed since. A pipeline
   * that puts such a gate on a NON-terminal step breaks that and needs the
   * answer scoped to the step it was given during — see the guard test, which
   * fails the day one does.
   */
  let reviewGateSatisfied = false;
  /** Set only by the checkpoint policy telling us no review gate is required. */
  let reviewGateWaived = false;

  let mandatoryGates: Partial<WorkspacePolicy["humanGates"]> = {};
  let effectiveGates: WorkspacePolicy["humanGates"] = policy.humanGates;
  let qualityGates: QualityGateCatalog | undefined;

  setHandler(taskCancelTaskSignal, (reason) => {
    cancelReason = reason;
  });
  setHandler(taskRefreshPolicySignal, (next) => {
    policy = next;
  });
  // Everything that arrives is queued; `runGate` picks out the answer to the
  // checkpoint it is actually waiting on, by id. A pre-filter here used to drop
  // answers for other checkpoints, which read like defence but was neither: an
  // answer that arrives in the window between the checkpoint row committing and
  // `pendingCheckpointId` being set passes any such filter anyway, and one for a
  // stale checkpoint is discarded by the id match below. Deleting it removes a
  // second, weaker copy of the rule that nothing could make fail.
  //
  // What the queue DOES need is a bound. Nothing drains it but a gate, and a
  // workflow parked in a two-hour Worker activity reaches no gate — so every
  // signal sent to it in the meantime lived in workflow memory (replayed from
  // history on every worker restart) for the rest of the execution. See
  // `answer-queue.ts` for the two rules and why they are replay-safe.
  setHandler(taskAnswerCheckpointSignal, (incoming) => {
    recordCheckpointAnswer(answers, incoming);
  });
  setHandler(taskSnapshotQuery, () => {
    const snapshot: TaskSnapshot = {
      status: machine.status,
      lane: machine.lane,
      pipeline: machine.pipeline,
      version: machine.version,
      stepsUsed,
    };
    if (machine.currentStepKey !== undefined) snapshot.currentStepKey = machine.currentStepKey;
    if (pendingCheckpointId !== undefined) snapshot.pendingCheckpointId = pendingCheckpointId;
    return snapshot;
  });

  const moveTo = async (
    to: TaskStatus,
    options: { stepKey?: string; resumeStatus?: TaskStatus; eventType?: string } = {},
  ): Promise<boolean> => {
    const moved = transition(
      machine,
      {
        to,
        ...(options.stepKey !== undefined ? { stepKey: options.stepKey } : {}),
        ...(options.resumeStatus !== undefined ? { resumeStatus: options.resumeStatus } : {}),
      },
      Date.now(),
    );
    if (!moved.ok) return false;
    machine = moved.state;
    eventSequence += 1;
    const recorded = await db.recordTaskStatus({
      taskId: input.taskId,
      status: to,
      expectedVersion: taskVersion,
      eventType: options.eventType ?? `TaskStatus:${to}`,
      idempotencyKey: taskEventKey(input.taskId, to, eventSequence),
    });
    taskVersion = recorded.version;
    return recorded.applied;
  };

  const emit = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    await notify.emitDomainEvent({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      eventId: uuid4(),
      type,
      payload,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    });
  };

  const pause = async (reason: string, message: string): Promise<void> => {
    await moveTo("needs_attention", { eventType: "TaskNeedsAttention" });
    await emit("TaskNeedsAttention", { reason, message });
  };

  const hasFindings = (): boolean =>
    findings !== undefined && findings.findings.length > 0;

  /**
   * A gate is a pure wait: the workflow holds no activity, no agent process, no
   * git lock and no SQLite transaction while it blocks (05 section 9).
   *
   * Returns false when the task must stop: a rejection, a cancellation, or a
   * gate that is required but cannot be entered. A required gate is NEVER
   * silently skipped — that is the whole point of this function.
   */
  const runGate = async (
    kind: HumanCheckpointKind,
    prompt: string,
    context: GateContext = {},
  ): Promise<boolean> => {
    // 05 section 2: the quick lane runs no PLAN or COMPLETION approval; it has
    // no durable state to hold them in. Which gates that covers is
    // `quickLaneWaivesGate`'s decision, not a condition inlined here — the one
    // it must never cover is `side-effect-approval`, and a carve-out written in
    // place is a carve-out that quietly grows. Anything else is a policy
    // decision, made below.
    if (machine.lane === "quick" && quickLaneWaivesGate(kind)) {
      if (kind === "review-approval") {
        reviewGateWaived = true;
      }
      return true;
    }

    const created = await db.createCheckpoint({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      kind,
      prompt,
      version: machine.version + 1,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      ...(context.risk === undefined ? {} : { risk: context.risk }),
      ...(context.hasFindings === undefined ? {} : { hasFindings: context.hasFindings }),
      ...(context.securityMandated === undefined
        ? {}
        : { securityMandated: context.securityMandated }),
      ...(context.requested === undefined ? {} : { requested: context.requested }),
    });
    if (!created.required) {
      if (kind === "review-approval") {
        reviewGateWaived = true;
      }
      return true;
    }

    const previous = machine.status;
    let waiting = enterGate(machine, kind, Date.now(), previous);
    // 05 section 3: a question raised mid-flight (a blocked Worker, a Manager
    // asking for a checkpoint) uses the interrupt wait state, which is reachable
    // from anywhere and remembers where to resume. Without it a `when-needed`
    // clarification could only ever be honoured during planning.
    const interruptWait = !waiting.ok && kind === "clarification";
    if (interruptWait) {
      waiting = transition(
        machine,
        { to: "waiting_user_input", resumeStatus: previous },
        Date.now(),
      );
    }
    if (!waiting.ok) {
      await pause(
        "gate-unreachable",
        `required ${kind} gate cannot be entered from ${previous}: ${waiting.message}`,
      );
      return false;
    }
    machine = waiting.state;
    // Publish the id in the same synchronous step that parks the status. The
    // activity below suspends, so setting it afterwards left a window where a
    // query answered `waiting_*` with no `pendingCheckpointId` — a client is
    // then told the task needs an answer but not which checkpoint to answer.
    // The checkpoint row already exists here; `created` came from an activity
    // that has committed. Assigning a local is not a command, so the replayed
    // command sequence is unchanged and this needs no patch id.
    pendingCheckpointId = created.checkpointId;
    // The wait state is a real version bump. Dropping it here left `taskVersion`
    // one behind, so a gate answered straight into completion (review-approval,
    // which resumes to `completed` without a further transition) failed the
    // optimistic version guard and paused the task instead of completing it.
    const waitRecorded = await db.recordTaskStatus({
      taskId: input.taskId,
      status: machine.status,
      expectedVersion: taskVersion,
      eventType: `Waiting:${kind}`,
      idempotencyKey: `checkpoint:${created.checkpointId}:${created.version}`,
    });
    taskVersion = waitRecorded.version;

    // Match the answer by checkpoint id rather than draining the queue. The
    // checkpoint row is visible to the API the moment the activity commits, so a
    // fast answer can land while this workflow is still recording the wait
    // state; clearing the queue here dropped it and parked the task forever.
    const answerIndex = (): number =>
      answers.findIndex((candidate) => candidate.checkpointId === created.checkpointId);

    await condition(() => answerIndex() >= 0 || cancelReason !== undefined);
    const index = answerIndex();
    const given = index >= 0 ? answers.splice(index, 1)[0] : undefined;
    // Anything left over belongs to a checkpoint nobody is waiting on.
    answers.length = 0;
    pendingCheckpointId = undefined;
    if (given === undefined) return false;

    const answer = given.answer;

    // 06 section 8: a limit checkpoint offers one extension. It is an *answer*
    // checkpoint, not an approval one, so the choice arrives as text.
    if (kind === "limit-exceeded") {
      if (!requestsExtension(answer, given.text)) return false;
      await moveTo(previous, { eventType: `CheckpointResolved:${kind}` });
      return true;
    }

    // An interrupt wait may only resume where it came from (the state machine
    // records it precisely so an answer cannot land in an arbitrary state).
    const resumeTo = interruptWait ? previous : gateResumeStatus(kind, answer, previous);
    if (kind === "review-approval") {
      reviewGateSatisfied = answer === "approved";
    }
    if (resumeTo === "completed") return true;
    await moveTo(resumeTo, { eventType: `CheckpointResolved:${kind}` });

    // Three answers exist, not two. No patch id: `applyCheckpointEvent`
    // (`@meidoya/checkpoint-policy`) refuses an `answer` event on an approval
    // kind, so no history can contain the verdict whose handling changed here.
    // Branching only on `rejected` made an
    // `answered` verdict on a `plan-approval` or a `side-effect-approval` mean
    // "proceed" — the plan ran and the gated capabilities entered the run scope
    // on an answer that is not consent, while `gateResumeStatus` had already
    // sent the task to `planning` / `needs_attention` and `gates.ts` routes the
    // same answer to `needs_attention`. `gateGrantsProgress` is the one place
    // that decides, and it is unit-tested per kind.
    if (!gateGrantsProgress(kind, answer)) {
      // A refusal is an instruction to stop, not an invitation to continue.
      if (!isTerminal(machine.status) && machine.status !== "needs_attention") {
        await pause(
          "gate-rejected",
          `the ${kind} gate was ${answer === "rejected" ? "rejected" : "not approved"}`,
        );
      }
      return false;
    }
    return true;
  };

  /**
   * 06 section 8: an exhausted budget pauses into needs_attention offering one
   * extension, rather than failing or (as before) looping forever.
   */
  const chargeBudget = async (
    kind: ChargeBudgetInput["kind"],
    stepKey?: string,
  ): Promise<boolean> => {
    const request: ChargeBudgetInput = {
      taskId: input.taskId,
      rootTaskId,
      kind,
      ...(stepKey === undefined ? {} : { stepKey }),
    };

    const first = await db.chargeBudget(request);
    if (first.allowed) {
      stepsUsed = first.stepsUsed;
      return true;
    }

    const proceeded = await runGate(
      "limit-exceeded",
      `Task paused: execution limit reached (${first.limit}).`,
      { requested: true },
    );
    if (!proceeded) return false;

    const extension = await db.extendBudget({ taskId: rootTaskId });
    if (!extension.ok) {
      await pause(first.limit, `execution limit ${first.limit} reached (${extension.reason})`);
      return false;
    }

    const second = await db.chargeBudget(request);
    if (second.allowed) {
      stepsUsed = second.stepsUsed;
      return true;
    }
    await pause(second.limit, `execution limit ${second.limit} reached after one extension`);
    return false;
  };

  const runStep = async (step: PipelineStep): Promise<PipelineOutcome | "halt"> => {
    attempt += 1;
    const visits = (stepVisits[step.key] ?? 0) + 1;
    stepVisits[step.key] = visits;

    switch (step.kind) {
      case "clarify":
        return "success";

      case "plan":
      case "assess": {
        // A re-plan is its own counted unit (06 section 5).
        if (!(await chargeBudget(visits > 1 ? "manager-replan" : "agent-run", step.key))) {
          return "halt";
        }
        const planInput: PlanTaskInput = {
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          brief: input.brief,
          stepKey: step.key,
          attempt,
          idempotencyKey: agentRunKey(input.taskId, step.key, attempt),
        };
        const planned = await manager.planTask(
          version.modelPolicyRouting
            ? planInput
            : ({
                ...planInput,
                provider: "codex",
                modelProfile: "standard",
              } as PlanTaskInput),
        );
        if (planned.status !== "planned") return "failure";

        const requestedCapabilities = derivePlanCapabilities(planned.plan);
        // 06 section 1.4: the gate trigger is the capability set an acting step
        // will be GRANTED — structured data derived from project access,
        // verification commands and the base grant below — not the plan's own
        // prose and not the plan's own step list. A plan that declines to
        // narrate its side effect gates all the same, and so does one that
        // declines to DECLARE the step that performs it: the steps that run are
        // the pipeline's, and the planning agent does not author those.
        //
        // The set it is evaluated on is the grant each step of THIS PIPELINE
        // will actually be issued (`grantForStep`, the same call the dispatch
        // below makes), because that is what a human would be approving. The
        // plan-wide grant taken whole includes BASE_CAPABILITIES, so it made a
        // read-only research task — whose Worker steps are both `researcher` and
        // receive `repo.read` + `network`, with nothing to act with — ask for a
        // side-effect approval; a gate that fires on everything is one people
        // approve without reading.
        //
        // Three frozen verdicts sit behind this, newest first:
        //  - TASK_SIDE_EFFECT_GATE_PIPELINE — before it, the trigger read the
        //    plan-wide grant WHOLE, so any plan holding `network` gated on every
        //    pipeline (`derivePlanSideEffectCapabilities`);
        //  - TASK_SIDE_EFFECT_GATE_UNION — before that, the trigger was each
        //    PLANNED step's request widened with the plan's externals, so a plan
        //    declaring only `investigate` + `review` steps gated nothing while
        //    the coding pipeline's `implement` step took the whole grant
        //    (`derivePlanSideEffectCapabilitiesPerStepGrant`);
        //  - TASK_SIDE_EFFECT_GATE_GRANT — before that, each planned step's
        //    request was judged in isolation
        //    (`derivePlanSideEffectCapabilitiesIsolated`).
        const gatedCapabilities = !version.sideEffectGateGrant
          ? derivePlanSideEffectCapabilitiesIsolated(planned.plan)
          : !version.sideEffectGateUnion
            ? derivePlanSideEffectCapabilitiesPerStepGrant(planned.plan)
            : version.sideEffectGatePipeline
              ? derivePipelineSideEffectCapabilities(
                  planned.plan,
                  capabilityGrantedSteps(getPipeline(machine.pipeline)),
                )
              : derivePlanSideEffectCapabilities(planned.plan);
        // What the plan asks for, plus the floor every acting step receives.
        // The gate below is the only thing between this set and a Worker, and a
        // refusal HALTS — so there is no state in which a gated capability has
        // to be subtracted from it. Subtracting the gated ones here and pushing
        // them back after approval was arithmetic no execution could observe.
        const grantedCapabilities = [
          ...new Set<WorkerCapability>([...BASE_CAPABILITIES, ...requestedCapabilities]),
        ];

        // 06 section 1.4: a human approval is what grants an external effect.
        if (gatedCapabilities.length > 0) {
          const approved = await runGate(
            "side-effect-approval",
            "This plan performs an effect outside the workspace" +
              ` (${gatedCapabilities.join(", ")}). Approve?`,
            { securityMandated: true, requested: true, risk: planned.plan.risk },
          );
          // The approval is the ONLY thing that lets this grant — gated
          // capabilities included — reach a Worker: the run scope is assigned
          // below, after the gate, and the execution node enforces it.
          if (!approved) return "halt";
        }
        planGrant = grantedCapabilities;
        planProjects = planned.plan.projects;
        executionPlan = planned.plan;

        const firstActingProfile =
          capabilityGrantedSteps(getPipeline(machine.pipeline))[0]?.workerProfile ?? "implementer";
        const routing = version.modelPolicyRouting
          ? await manager.resolveWorkerRuntime({
              workspaceId: input.workspaceId,
              workerProfile: firstActingProfile,
            })
          : {
              runtime: { provider: "codex" as const, modelProfile: "standard" as const },
              allowedRuntimes: [
                { provider: "codex" as const, modelProfile: "standard" as const },
                { provider: "codex" as const, modelProfile: "high" as const },
                { provider: "claude" as const, modelProfile: "standard" as const },
                { provider: "claude" as const, modelProfile: "high" as const },
              ],
            };
        const validation = validateExecutionPlan(planned.plan, {
          workspaceProjectIds: input.brief.projects,
          writableProjectIds: input.brief.projects,
          workerProfileAllowlist: [
            "researcher",
            "implementer",
            "reviewer",
            "security-reviewer",
            "tester",
            "mechanical-editor",
          ],
          allowedRuntimes: routing.allowedRuntimes,
          requestedRuntime: routing.runtime,
          grantedCapabilities,
          requestedCapabilities,
          gates: effectiveGates,
          mandatoryGates,
          budget: policy.limits,
          stepsAlreadyUsed: stepsUsed,
          requireVerification: machine.pipeline === "coding",
          ...(qualityGates === undefined ? {} : { qualityGates }),
        });
        if (!validation.ok) {
          await pause("invalid-plan", validation.rejections.map((r) => r.message).join("; "));
          return "halt";
        }
        requiredArtifactPaths = planned.plan.expectedArtifacts;
        plannedVerification = planned.plan.verification;

        // 06 section 1.2: the plan gate stops AFTER the plan exists, which is
        // also the only moment its risk is known.
        const proceeded = await runGate("plan-approval", "Approve this plan?", {
          risk: planned.plan.risk,
        });
        return proceeded ? "success" : "halt";
      }

      case "verify": {
        // 05 section 7: a verification with no commands "passes" vacuously, so
        // substituting an empty plan for a missing one turned the quality gate
        // into a formality. There is nothing to run and nothing to trust: stop
        // and say so. Plan validation already refuses an empty verification for
        // the coding pipeline, so this is the floor under that, for a verify
        // step reached with no plan at all.
        const verificationPlan = plannedVerification;
        if (verificationPlan === undefined || isVacuousVerification(verificationPlan)) {
          await pause(
            "no-verification-plan",
            `step ${step.key} has no verification commands to run; an empty verification ` +
              "cannot stand as evidence",
          );
          return "halt";
        }
        // The catalog is the operator's, loaded once by `db.loadGatePolicy`. An
        // ABSENT one means no gate policy is wired at all — not an empty
        // allowlist — and there is no default to fall back on: that fallback is
        // what made "nobody configured anything" look like "the operator chose
        // `test`". Refuse rather than invent one.
        if (qualityGates === undefined) {
          await pause(
            "no-quality-gate-catalog",
            "this workspace has no quality-gate catalog, so no verification command can be " +
              "justified; configure one before running a coding task",
          );
          return "halt";
        }
        if (!(await chargeBudget("verification-group", step.key))) return "halt";
        const projectId = verificationProjectId(planProjects);
        verification = await verifier.runVerification({
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          stepKey: step.key,
          plan: verificationPlan,
          expectedArtifacts: requiredArtifactPaths,
          // 10 section 3: the node sandboxes the commands to ONE project. It
          // infers that project only when the workspace binds exactly one and
          // refuses to guess otherwise, so a node bound to two projects can
          // never verify unless the control plane names it. The approved plan
          // is the only authority for which one: the project it may write.
          ...(projectId === undefined ? {} : { projectId }),
          // The node holds no workspace configuration, so the operator's
          // catalog travels with the activity. It is the same one plan
          // validation used.
          qualityGates: qualityGates.map((gate) => ({
            name: gate.name,
            argv: [...gate.argv],
          })),
        });
        return verification.status === "passed" ? "success" : "failure";
      }

      case "compare": {
        const compared = await db.compareWithPreviousResult({
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          resultHash: `${input.taskId}:${attempt}`,
        });
        return compared.changed ? "success" : "no-change";
      }

      case "review": {
        if (!(await chargeBudget("review-group", step.key))) return "halt";
        if (!(await chargeBudget("review-round", step.key))) return "halt";
        if (version.modelPolicyRouting) {
          const reviewRouting = await manager.resolveWorkerRuntime({
            workspaceId: input.workspaceId,
            workerProfile: "reviewer",
          });
          findings = await reviewer.runReview({
            taskId: input.taskId,
            workspaceId: input.workspaceId,
            brief: input.brief,
            stepKey: step.key,
            attempt,
            provider: reviewRouting.runtime.provider,
            modelProfile: reviewRouting.runtime.modelProfile,
            capabilities: ["repo.read"],
            projectAccess: planProjects.map((project) => ({
              projectId: project.projectId,
              mode: "read" as const,
            })),
            ...(executionPlan === undefined ? {} : { executionPlan }),
            ...(verification === undefined ? {} : { verification }),
            idempotencyKey: agentRunKey(input.taskId, step.key, attempt),
          });
        } else {
          findings = await manager.runReview({
            taskId: input.taskId,
            workspaceId: input.workspaceId,
            stepKey: step.key,
            attempt,
            provider: "codex",
            modelProfile: "standard",
            idempotencyKey: agentRunKey(input.taskId, step.key, attempt),
          } as ReviewInput);
        }
        loop = recordReviewRound(loop, findings, verification);
        const decisionInput: ManagerDecisionInput = {
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          findings,
          ...(verification !== undefined ? { verification } : {}),
          idempotencyKey: agentRunKey(input.taskId, `${step.key}-decision`, attempt),
        };
        const decision = await manager.decideNextAction(
          version.modelPolicyRouting
            ? decisionInput
            : ({
                ...decisionInput,
                provider: "codex",
                modelProfile: "standard",
              } as ManagerDecisionInput),
        );
        const outcome = applyManagerDecision({
          decision,
          loop,
          findings,
          budget: policy.limits,
          reviewGate: effectiveGates.review,
        });
        switch (outcome.kind) {
          case "complete":
            // The Manager may propose completion; only the checkpoint policy
            // (and a human, if it says so) may satisfy the review gate.
            return "success";
          case "gate": {
            const proceeded = await runGate(outcome.checkpointKind, outcome.prompt, {
              requested: true,
              hasFindings: hasFindings(),
            });
            if (!proceeded) return "halt";
            return reviewGateSatisfied || reviewGateWaived ? "success" : "findings";
          }
          case "fix":
            loop = outcome.loop;
            return "findings";
          case "review-again":
            loop = outcome.loop;
            return "failure";
          case "needs-attention":
            await pause(outcome.limit, outcome.message);
            return "halt";
          case "abort":
            await moveTo("failed", { eventType: "TaskFailed" });
            await emit("TaskFailed", { reason: outcome.reason });
            return "halt";
        }
        return "halt";
      }

      case "deliver": {
        await emit("ScheduleChanged", { summary: input.brief.summary });
        return "success";
      }

      case "work":
      case "research":
      case "synthesize":
      case "implement":
      case "execute":
      case "fix": {
        if (step.kind === "fix" && !(await chargeBudget("fix-round", step.key))) return "halt";
        if (!(await chargeBudget("agent-run", step.key))) return "halt";
        const workerProfile = step.workerProfile ?? "implementer";
        const routing = version.modelPolicyRouting
          ? await manager.resolveWorkerRuntime({
              workspaceId: input.workspaceId,
              workerProfile,
            })
          : {
              runtime: { provider: "codex" as const, modelProfile: "standard" as const },
              allowedRuntimes: [{ provider: "codex" as const, modelProfile: "standard" as const }],
            };
        const result = await worker.runWorkerStep({
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          brief: input.brief,
          stepKey: step.key,
          stepKind: step.kind,
          attempt,
          workerProfile,
          provider: routing.runtime.provider,
          modelProfile: routing.runtime.modelProfile,
          // The plan's grant, narrowed to this step. A `review` step never
          // inherits the external effect a human approved for `implement`.
          capabilities: grantForStep(
            planGrant,
            { kind: plannedKindOfPipelineKind(step.kind), workerProfile },
            { writableProjects: planProjects.some((p) => p.mode === "write") },
          ),
          projectAccess: planProjects.map((p) => ({ projectId: p.projectId, mode: p.mode })),
          ...(executionPlan === undefined ? {} : { executionPlan }),
          idempotencyKey: agentRunKey(input.taskId, step.key, attempt),
        });
        if (result.type === "completed") {
          taskSummary = result.summary;
          return "success";
        }
        if (result.type === "blocked") {
          // The Manager, not the Worker, decides whether to ask the user; a
          // `when-needed` clarification gate exists precisely for this ask.
          const proceeded = await runGate(
            "clarification",
            result.proposedQuestion ?? result.reason,
            { requested: true },
          );
          // A waived clarification gate is not evidence that the blocked work
          // happened. Recording success here let quick tasks complete with the
          // original request restated as their result while the Worker had
          // explicitly said it could not inspect the repository.
          return proceeded ? "failure" : "halt";
        }
        return "failure";
      }

      /**
       * A step kind this workflow does not implement is a STOP.
       *
       * This used to be the Worker branch's `default:`, so `delegate`,
       * `await-children` and `aggregate` — the whole `cross-workspace` body,
       * declared `executor: "control" | "manager"` — were dispatched to the
       * execution node as `worker.runWorkerStep` with `workerProfile:
       * "implementer"`. A coordination step ran as an implementer with a repo
       * grant, silently, because the switch had no case for it and `executor`
       * was read by nothing. Now the dispatch is by explicit kind and anything
       * else pauses; `pipelines-guard.ts` refuses to let such a pipeline reach
       * this function at all.
       */
      default: {
        await pause(
          "unsupported-step-kind",
          `pipeline ${machine.pipeline} step ${step.key} is a ${step.kind} step, which this ` +
            "workflow does not run; it must never be dispatched as a Worker run",
        );
        return "halt";
      }
    }
  };

  /**
   * A pipeline whose steps this workflow does not implement is refused before
   * anything runs.
   *
   * `cross-workspace` is such a pipeline: its `delegate`, `await-children` and
   * `aggregate` steps are workflow-level constructs (a child workflow, a signal
   * wait, an aggregation over children) that `CrossWorkspaceWorkflow` provides
   * and no activity can. Started here it used to walk straight into the Worker
   * branch and dispatch its three coordination steps to an execution node as
   * `implementer` runs. Pure and deterministic — it reads the pipeline table,
   * which is code.
   *
   * ## Why this is not behind a patch id
   *
   * It changes the command stream — but only for an execution whose pipeline is
   * `cross-workspace`, and those cannot arise from the normal route:
   * `RequestWorkflow` calls `selectPipeline` with `workspaceKind: "execution"`,
   * which never yields it. One exists only if an operator set
   * `defaultPipeline` / a pipeline hint to a coordination pipeline, and such an
   * execution is, by construction, dispatching `delegate` / `await-children` /
   * `aggregate` to an execution node as `implementer` Worker runs.
   *
   * A patch id preserves the OLD branch for in-flight executions. Here the old
   * branch is that dispatch, so gating this would deliberately keep sending
   * coordination steps to a node as implementer runs for exactly the executions
   * that are doing it now — buying replay compatibility with the one behaviour
   * the change exists to stop. The alternative cost is a workflow-task failure
   * on such an execution, which an operator resolves by terminating a task that
   * must not be running: that is the intended outcome, not a regression.
   *
   * Deploy note, therefore: before rolling this out, list any TaskWorkflow
   * execution whose pipeline is `cross-workspace` and terminate it (there
   * should be none). Every OTHER change in this file's neighbouring revisions —
   * the `answered` verdict on an approval gate, the answer-signal handler, the
   * capability-grant arithmetic — leaves the command stream identical for every
   * history that can exist, and the recorded fixtures in `replay.test.ts` prove
   * it.
   */
  const unrunnable = stepsTaskWorkflowCannotRun({ [machine.pipeline]: getPipeline(machine.pipeline) });
  if (unrunnable.length > 0) {
    await pause(
      "unsupported-pipeline",
      `pipeline ${machine.pipeline} cannot be run by TaskWorkflow: ` +
        unrunnable.map((v) => `${v.stepKey} is ${v.reason}`).join("; "),
    );
    return {
      taskId: input.taskId,
      status: machine.status,
      lane: machine.lane,
      pipeline: machine.pipeline,
      promoted,
      summary: taskSummary,
    };
  }

  // Quick tasks race their soft deadline; promotion keeps the same task id and
  // posts no extra progress message (05 section 2).
  const deadline =
    machine.lane === "quick" && input.quickSoftDeadlineMs !== undefined
      ? sleep(input.quickSoftDeadlineMs).then(() => {
          if (
            isQuickSoftDeadlineExceeded(
              machine,
              {
                softDeadlineMs: input.quickSoftDeadlineMs ?? 0,
                promoteTo: input.promoteTo ?? "research",
              },
              Date.now(),
            )
          ) {
            const promotion = promoteQuickToDurable(machine, {
              now: Date.now(),
              pipeline: input.promoteTo ?? "research",
            });
            if (promotion.ok) {
              machine = promotion.state;
              promoted = true;
            }
          }
        })
      : undefined;
  void deadline;

  // The mandatory floor and the operator's quality-gate allowlist are loaded
  // once, from the control plane. Nothing an agent produces can influence them.
  const gatePolicy = await db.loadGatePolicy({ workspaceId: input.workspaceId });
  mandatoryGates = gatePolicy.mandatoryGates;
  effectiveGates = gatePolicy.effectiveGates;
  qualityGates = gatePolicy.qualityGates;

  await moveTo("planning", { eventType: "TaskStarted" });

  let stepKey: string | undefined = getPipeline(machine.pipeline).entry;
  let halted = false;

  while (stepKey !== undefined && !halted) {
    if (cancelReason !== undefined) break;
    const pipeline = getPipeline(machine.pipeline);
    const step: PipelineStep | undefined = pipeline.steps[stepKey];
    if (!step) {
      await pause("unknown-step", `pipeline ${pipeline.name} has no step ${stepKey}`);
      break;
    }
    if (machine.status !== step.status) {
      await moveTo(step.status, { stepKey: step.key });
    } else {
      machine = { ...machine, currentStepKey: step.key };
    }

    // Pre-step gates. Plan approval is evaluated after the plan exists and
    // review approval before completion; every other declared gate stops here.
    if (
      step.gate !== undefined &&
      !(step.gate === "plan-approval" && (step.kind === "plan" || step.kind === "assess")) &&
      !(step.gate === "review-approval" && step.kind === "review")
    ) {
      const context: GateContext =
        step.gate === "review-approval" ? { hasFindings: hasFindings() } : {};
      const proceeded = await runGate(step.gate, `Approve ${step.key}?`, context);
      if (!proceeded) {
        halted = true;
        break;
      }
      if (cancelReason !== undefined) break;
    }

    /**
     * A step whose ACTIVITY fails is a stop, not a retry.
     *
     * Temporal has already applied the activity's own retry policy by the time
     * the failure reaches here; a refusal (`PolicyViolation`, `ScopeViolation`)
     * is non-retryable, so it arrives on the first attempt. Letting it escape
     * this function failed the workflow, which the daemon then re-dispatched —
     * the same refusal logged over and over with no human ever asked. The task
     * pauses into `needs_attention` with the reason instead, which is the one
     * state an operator can act on.
     *
     * Cancellation is not a failure and is re-raised: a cancelled workflow must
     * not go on issuing commands.
     */
    let outcome: PipelineOutcome | "halt";
    try {
      outcome = await runStep(step);
    } catch (error) {
      if (isCancellation(error)) throw error;
      await pause("step-failed", `step ${step.key} could not run: ${failureMessage(error)}`);
      halted = true;
      break;
    }
    if (outcome === "halt") {
      halted = true;
      break;
    }

    // The step's own verdict, recorded by the control plane: the completion
    // check has no other way to know a control-plane step ever ran.
    await db.recordStepOutcome({
      taskId: input.taskId,
      stepKey: step.key,
      stepKind: step.kind,
      status: outcome === "success" || outcome === "no-change" ? "succeeded" : "failed",
    });

    if (machine.pipeline !== pipeline.name) {
      // Promoted mid-step: continue in the durable pipeline from its entry.
      stepKey = getPipeline(machine.pipeline).entry;
      continue;
    }

    const advance = advancePipeline(pipeline, step.key, outcome);
    if (advance.kind === "stuck") {
      await pause("pipeline-stuck", advance.reason);
      halted = true;
      break;
    }
    if (advance.kind === "complete") {
      stepKey = undefined;
      break;
    }
    stepKey = advance.step.key;
  }

  if (cancelReason !== undefined) {
    await moveTo("cancelled", { eventType: "TaskCancelled" });
    await emit("TaskFailed", { reason: cancelReason, cancelled: true });
    return {
      taskId: input.taskId,
      status: machine.status,
      lane: machine.lane,
      pipeline: machine.pipeline,
      promoted,
      summary: taskSummary,
    };
  }

  if (!halted) {
    // 06 section 1.3: the review gate is asked for on EVERY completion. Whether
    // it is required is the checkpoint policy's decision, never the pipeline
    // definition's silence and never the Manager's own verdict.
    //
    // `reviewGateSatisfied` can only have been set by a human answering a
    // `review-approval` gate, and on the pipelines shipped today every such
    // gate is the last thing before completion: they all sit on TERMINAL steps,
    // and the only other one — the gate the Manager's `gate` decision raises
    // inside a review step — either approves into completion or halts. So the
    // answer this reads is always an answer about the work being completed.
    // `pipelines-guard.test.ts` pins that property, and says what has to be
    // rebuilt (and gated with a patch id) the day a pipeline breaks it.
    if (!reviewGateSatisfied) {
      const proceeded = await runGate("review-approval", "Approve completion?", {
        hasFindings: hasFindings(),
      });
      if (!proceeded) {
        return {
          taskId: input.taskId,
          status: machine.status,
          lane: machine.lane,
          pipeline: machine.pipeline,
          promoted,
          summary: taskSummary,
        };
      }
    }

    const completion = await db.completeTask({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      pipeline: machine.pipeline,
      expectedVersion: taskVersion,
      eventId: uuid4(),
      summary: taskSummary,
      verificationRequired: machine.pipeline === "coding",
      ...(verification !== undefined ? { verification } : {}),
      ...(findings !== undefined ? { findings } : {}),
      reviewGateSatisfied: reviewGateSatisfied || reviewGateWaived,
      requiredArtifactPaths,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    });

    if (completion.status === "completed") {
      const moved = transition(machine, { to: "completed" }, Date.now());
      if (moved.ok) machine = moved.state;
    } else {
      await pause(
        "completion-rejected",
        completion.status === "conflict"
          ? "task projection changed concurrently"
          : completion.unmet.join(", "),
      );
    }
  }

  void workflowInfo();

  return {
    taskId: input.taskId,
    status: machine.status,
    lane: machine.lane,
    pipeline: machine.pipeline,
    promoted,
    summary: taskSummary,
  };
}
