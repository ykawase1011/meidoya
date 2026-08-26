import { fileURLToPath } from "node:url";

import { ApplicationFailure } from "@temporalio/activity";
import { startTimeSkippingEnv } from "@meidoya/temporal-test-env";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type {
  ExecutionPlan,
  HumanCheckpointKind,
  ManagerDecision,
  ReviewFindings,
  RuntimeProfile,
  WorkerResult,
  WorkspacePolicy,
} from "@meidoya/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  Activities,
  ChargeBudgetInput,
  CompleteTaskInput,
  CreateCheckpointInput,
  VerificationInput,
  ReviewInput,
  WorkerStepInput,
} from "../activities.js";
import { MAX_QUEUED_ANSWERS } from "../answer-queue.js";
import { CONTROL_TASK_QUEUE, nodeTaskQueue } from "../task-queues.js";
import { taskWorkflowId } from "../workflow-ids.js";
import {
  TaskWorkflow,
  taskAddInstructionSignal,
  taskAnswerCheckpointSignal,
  taskSnapshotQuery,
  type TaskSnapshot,
  type TaskWorkflowInput,
} from "./task.js";

const policy: WorkspacePolicy = {
  requestPolicy: { quickSoftDeadlineMs: 120_000, defaultPipeline: "coding" },
  humanGates: {
    clarification: "never",
    plan: "always",
    review: "never",
    sideEffect: "policy",
  },
  limits: {
    maxSteps: 24,
    maxStepVisits: 5,
    maxFixRounds: 3,
    maxReviewRounds: 3,
    maxNoProgressRounds: 2,
    maxParallelWorkers: 3,
    maxModelEscalations: 2,
    maxConsecutiveFailures: 3,
    maxWallTimeMs: 4 * 60 * 60 * 1000,
  },
  execution: { preferredProfile: "codex-standard", fallbackProfiles: [] },
};

const PLAN: ExecutionPlan = {
  summary: "s",
  risk: "low",
  projects: [{ projectId: "p1", mode: "write" }],
  steps: [
    {
      key: "impl",
      kind: "implement",
      description: "d",
      workerProfile: "implementer",
      dependsOn: [],
    },
  ],
  expectedArtifacts: [],
  verification: { commands: [{ name: "test" }] },
};

type Log = {
  calls: string[];
  inFlight: number;
  maxInFlightDuringWait: number;
  charges: ChargeBudgetInput[];
  checkpoints: CreateCheckpointInput[];
  extensions: number;
  agentRuns: number;
  events: { type: string; payload: Record<string, unknown> }[];
  /** Every Worker run's authoritative scope, as the node would receive it. */
  workerSteps: WorkerStepInput[];
  reviewSteps: ReviewInput[];
  /** Every verification request, as the node would receive it. */
  verifications: VerificationInput[];
  /** What the control plane was told at completion, `reviewGateSatisfied` included. */
  completions: CompleteTaskInput[];
  stepOutcomes: string[];
};

function newLog(): Log {
  return {
    calls: [],
    inFlight: 0,
    maxInFlightDuringWait: 0,
    charges: [],
    checkpoints: [],
    extensions: 0,
    agentRuns: 0,
    events: [],
    workerSteps: [],
    reviewSteps: [],
    verifications: [],
    completions: [],
    stepOutcomes: [],
  };
}

type ActivityOptions = {
  policy?: WorkspacePolicy;
  plan?: ExecutionPlan;
  workerDelayMs?: number;
  workerResult?: WorkerResult;
  findings?: ReviewFindings;
  managerDecision?: ManagerDecision;
  /** Which checkpoint kinds the control-plane policy requires. */
  requiredGates?: HumanCheckpointKind[];
  effectiveGates?: WorkspacePolicy["humanGates"];
  /** Verification outcome per attempt; a single boolean applies to all. */
  verificationPasses?: boolean;
  /**
   * Denies a specific charge regardless of the counters. Lets a test pick one
   * enforcement point and check that its VERDICT — not merely its invocation —
   * is honoured.
   */
  denyBudget?: (input: ChargeBudgetInput) => boolean;
  /** When false, the one offered extension is refused, so a denial stands. */
  allowExtension?: boolean;
  /** Makes `runVerification` refuse the way a node refuses: non-retryably. */
  verificationRefusal?: string;
  /** When false, `loadGatePolicy` serves NO quality-gate catalog at all. */
  qualityGateCatalog?: false;
  workerRuntime?: RuntimeProfile;
};

/**
 * Activities standing in for the control plane. The budget is a real counter
 * and the checkpoint policy a real decision table, so a workflow that forgets
 * to charge or forgets to ask is visible here rather than silently fine.
 */
function makeActivities(log: Log, options: ActivityOptions = {}): Activities {
  const limits = (options.policy ?? policy).limits;
  let version = 0;
  let checkpointSeq = 0;
  let steps = 0;
  let fixRounds = 0;
  let reviewRounds = 0;
  let extraSteps = 0;
  let extended = false;

  const requiredGates = options.requiredGates ?? [];
  const track = <T>(name: string, fn: () => T): T => {
    log.calls.push(name);
    log.inFlight += 1;
    try {
      return fn();
    } finally {
      log.inFlight -= 1;
    }
  };

  return {
    async loadTaskContext() {
      throw new Error("unused");
    },
    async assessRequest() {
      throw new Error("unused");
    },
    async executeAdministrativeCommand() {
      throw new Error("unused");
    },
    async finalizeIntakeRequest() {
      throw new Error("unused");
    },
    async materializeScheduledRequest() {
      throw new Error("unused");
    },
    async loadGatePolicy() {
      log.calls.push("loadGatePolicy");
      return {
        mandatoryGates: {},
        effectiveGates: options.effectiveGates ?? (options.policy ?? policy).humanGates,
        ...(options.qualityGateCatalog === false
          ? {}
          : {
              qualityGates: [
                { name: "test", argv: ["npm", "test"] },
                { name: "lint", argv: ["npm", "run", "lint"] },
              ],
            }),
      };
    },
    async recordStepOutcome(input) {
      log.calls.push("recordStepOutcome");
      log.stepOutcomes.push(input.status);
    },
    async chargeBudget(input) {
      log.charges.push(input);
      log.calls.push(`chargeBudget:${input.kind}`);
      if (options.denyBudget?.(input) === true) {
        return { allowed: false, limit: "max_steps", stepsUsed: steps };
      }
      if (input.kind === "fix-round") {
        if (fixRounds + 1 > limits.maxFixRounds) {
          return { allowed: false, limit: "max_fix_rounds", stepsUsed: steps };
        }
        fixRounds += 1;
        return { allowed: true, stepsUsed: steps };
      }
      if (input.kind === "review-round") {
        if (reviewRounds + 1 > limits.maxReviewRounds) {
          return { allowed: false, limit: "max_review_rounds", stepsUsed: steps };
        }
        reviewRounds += 1;
        return { allowed: true, stepsUsed: steps };
      }
      if (steps + 1 > limits.maxSteps + extraSteps) {
        return { allowed: false, limit: "max_steps", stepsUsed: steps };
      }
      steps += 1;
      return { allowed: true, stepsUsed: steps };
    },
    async extendBudget() {
      log.extensions += 1;
      // No extension is available at all, so a denied charge has to stand.
      if (options.allowExtension === false) return { ok: false, reason: "already-extended" };
      if (extended) return { ok: false, reason: "already-extended" };
      extended = true;
      extraSteps = limits.maxSteps;
      return { ok: true, maxSteps: limits.maxSteps + extraSteps };
    },
    async planTask() {
      log.agentRuns += 1;
      return track("planTask", () => ({
        status: "planned" as const,
        plan: options.plan ?? PLAN,
      }));
    },
    async runWorkerStep(stepInput) {
      log.workerSteps.push(stepInput);
      if (options.workerDelayMs !== undefined && options.workerDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.workerDelayMs));
      }
      log.agentRuns += 1;
      return track(
        "runWorkerStep",
        () =>
          options.workerResult ?? {
            type: "completed" as const,
            summary: "done",
            artifacts: [],
            evidence: [],
          },
      );
    },
    async runVerification(verificationInput) {
      log.verifications.push(verificationInput);
      if (options.verificationRefusal !== undefined) {
        log.calls.push("runVerification");
        // Exactly how the execution node refuses: an ApplicationFailure whose
        // type is in `nonRetryableErrorTypes`, so Temporal runs it once.
        throw ApplicationFailure.create({
          message: options.verificationRefusal,
          type: "PolicyViolation",
          nonRetryable: true,
        });
      }
      return track("runVerification", () =>
        options.verificationPasses === false
          ? {
              status: "failed" as const,
              groups: [],
              missingArtifacts: [],
              artifacts: [],
              evidence: [],
              failureSignature: "test#red",
            }
          : {
              status: "passed" as const,
              groups: [],
              missingArtifacts: [],
              artifacts: [],
              evidence: [],
            },
      );
    },
    async runReview(reviewInput) {
      log.reviewSteps.push(reviewInput);
      log.agentRuns += 1;
      return track("runReview", () => options.findings ?? { findings: [] });
    },
    async decideNextAction() {
      log.agentRuns += 1;
      return track(
        "decideNextAction",
        () => options.managerDecision ?? ({ type: "complete" } as ManagerDecision),
      );
    },
    async resolveWorkerRuntime() {
      const runtime = options.workerRuntime ?? {
        provider: "codex" as const,
        modelProfile: "standard" as const,
      };
      return {
        runtime,
        allowedRuntimes: [runtime],
      };
    },
    async recordTaskStatus(input) {
      return track("recordTaskStatus", () => {
        version += 1;
        log.calls[log.calls.length - 1] = `recordTaskStatus:${input.status}`;
        return { applied: true, version };
      });
    },
    async createCheckpoint(input) {
      log.checkpoints.push(input);
      return track("createCheckpoint", () => {
        const required = input.kind === "limit-exceeded" || requiredGates.includes(input.kind);
        checkpointSeq += 1;
        return {
          checkpointId: required ? `cp-${input.kind}-${checkpointSeq}` : "",
          version: input.version,
          required,
        };
      });
    },
    async emitDomainEvent(event) {
      log.events.push({ type: event.type, payload: event.payload });
      track("emitDomainEvent", () => undefined);
    },
    async completeTask(completion) {
      log.completions.push(completion);
      return track("completeTask", () => ({ status: "completed" as const }));
    },
    async createDelegation() {
      throw new Error("unused");
    },
    async compareWithPreviousResult() {
      return { changed: true };
    },
    async loadWorkspacePolicy() {
      return { policy: options.policy ?? policy, revision: 1 };
    },
  };
}

const input: TaskWorkflowInput = {
  taskId: "t-gate-1",
  workspaceId: "work-it",
  environmentId: "home",
  pipeline: "coding",
  lane: "durable",
  brief: { summary: "add feature", projects: ["p1"], origin: "chat" },
  policy,
  executionNodeId: "mac-main",
  taskVersion: 0,
};

let env: TestWorkflowEnvironment | undefined;

beforeAll(async () => {
  env = await startTimeSkippingEnv();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

function requireEnv(): TestWorkflowEnvironment {
  if (!env) throw new Error("no test environment");
  return env;
}

const workflowsPath = fileURLToPath(new URL("./index.ts", import.meta.url));

/** Runs `body` with both workers up, exactly like the daemon + a node. */
async function withWorkers(
  activities: Activities,
  body: (client: TestWorkflowEnvironment["client"]) => Promise<void>,
): Promise<void> {
  const testEnv = requireEnv();
  const control = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: CONTROL_TASK_QUEUE,
    workflowsPath,
    activities,
  });
  const node = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: nodeTaskQueue("mac-main"),
    activities,
  });
  await control.runUntil(node.runUntil(body(testEnv.client)));
}

/**
 * The same, bundling `pre-patch-workflows.ts` instead: `TaskWorkflowPrePatch` is
 * `TaskWorkflow` with every `patched()` answer forced to `false`, i.e. the code
 * path an execution started before this deploy replays.
 */
const prePatchWorkflowsPath = fileURLToPath(
  new URL("./pre-patch-workflows.ts", import.meta.url),
);

async function withPrePatchWorkers(
  activities: Activities,
  body: (client: TestWorkflowEnvironment["client"]) => Promise<void>,
): Promise<void> {
  const testEnv = requireEnv();
  const control = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: CONTROL_TASK_QUEUE,
    workflowsPath: prePatchWorkflowsPath,
    activities,
  });
  const node = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: nodeTaskQueue("mac-main"),
    activities,
  });
  await control.runUntil(node.runUntil(body(testEnv.client)));
}

/**
 * The same bundle, for `TaskWorkflowPreUnionPatch`: the generation that took
 * `task-side-effect-gate-grant-202608` and not `task-side-effect-gate-union`.
 */
const withPreUnionWorkers = withPrePatchWorkers;

/**
 * The same bundle again, for `TaskWorkflowPrePipelinePatch`: the previous
 * release (4e663ee), which took both side-effect patches and not
 * `task-side-effect-gate-pipeline-202608`.
 */
const withPrePipelineWorkers = withPrePatchWorkers;

/**
 * Answers a gate and waits until the workflow has actually consumed it.
 *
 * The time-skipping server jumps the clock while a caller awaits a workflow
 * result, so calling `result()` while the workflow is still parked on a gate
 * lets it skip straight past the execution timeout. Draining the gate first
 * keeps the test measuring the workflow rather than the clock.
 */
async function answerGate(
  handle: {
    query: (q: typeof taskSnapshotQuery) => Promise<TaskSnapshot>;
    signal: (s: typeof taskAnswerCheckpointSignal, a: { checkpointId: string; answer: "approved" | "rejected" | "answered" }) => Promise<void>;
  },
  checkpointId: string,
  answer: "approved" | "rejected" | "answered" = "approved",
): Promise<void> {
  await handle.signal(taskAnswerCheckpointSignal, { checkpointId, answer });
  await waitForStatus(
    handle,
    (s) => s.pendingCheckpointId !== checkpointId,
    `${checkpointId} to be consumed`,
  );
}

async function waitForStatus(
  handle: { query: (q: typeof taskSnapshotQuery) => Promise<TaskSnapshot> },
  predicate: (snapshot: TaskSnapshot) => boolean,
  what: string,
): Promise<TaskSnapshot> {
  for (let i = 0; i < 400; i += 1) {
    const snapshot = await handle.query(taskSnapshotQuery);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `timed out waiting for ${what}; last snapshot ${JSON.stringify(await handle.query(taskSnapshotQuery))}`,
  );
}

describe("TaskWorkflow", () => {
  it("reruns the same task with an instruction received during execution", async () => {
    const log = newLog();
    const ungatedPolicy: WorkspacePolicy = {
      ...policy,
      humanGates: {
        clarification: "never",
        plan: "never",
        review: "never",
        sideEffect: "policy",
      },
    };
    const activities = makeActivities(log, {
      policy: ungatedPolicy,
      effectiveGates: ungatedPolicy.humanGates,
      workerDelayMs: 250,
    });
    const workflowInput: TaskWorkflowInput = {
      ...input,
      taskId: "t-thread-instruction-1",
      policy: ungatedPolicy,
    };

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId(workflowInput.taskId),
        args: [workflowInput],
      });
      for (let count = 0; count < 200 && log.workerSteps.length === 0; count += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(log.workerSteps).toHaveLength(1);

      await handle.signal(taskAddInstructionSignal, {
        id: "chat:discord-follow-up",
        text: "失敗したテストだけ再実行してください",
      });
      await handle.query(taskSnapshotQuery);

      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(log.workerSteps.length).toBeGreaterThanOrEqual(2);
      expect(log.workerSteps.at(-1)?.brief.summary).toContain(
        "失敗したテストだけ再実行してください",
      );
    });
  }, 120_000);

  /**
   * A parked task must never be observable without the id of what parked it.
   *
   * The status is set synchronously and the id used to be assigned after the
   * `recordTaskStatus` activity, which suspends — so a query landing in that
   * window answered `waiting_*` with no `pendingCheckpointId`, telling a client
   * an answer is needed but not which checkpoint to answer. It surfaced as a
   * flake in the gate test roughly one run in three; this polls the window
   * directly instead of waiting for that to recur.
   */
  it("never reports a parked status without the checkpoint that parked it", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: ["plan-approval"] });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId(input.taskId),
        args: [input],
      });

      const violations: TaskSnapshot[] = [];
      let parked: TaskSnapshot | undefined;
      // Poll with no delay so the query lands inside the activity's suspension.
      for (let i = 0; i < 600 && parked === undefined; i += 1) {
        const snapshot = await handle.query(taskSnapshotQuery);
        if (snapshot.status.startsWith("waiting_")) {
          if (snapshot.pendingCheckpointId === undefined) violations.push(snapshot);
          else parked = snapshot;
        }
      }

      expect(violations).toEqual([]);
      expect(parked).toBeDefined();
      await answerGate(handle, parked!.pendingCheckpointId!);
      expect((await handle.result()).status).toBe("completed");
    });
  }, 120_000);

  it("waits for a human gate holding no activity, then completes", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: ["plan-approval"] });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId(input.taskId),
        args: [input],
      });

      const snapshot = await waitForStatus(
        handle,
        (s) => s.status === "waiting_plan_approval",
        "the plan gate",
      );

      // 05 section 9: while waiting the workflow holds no agent process,
      // no git lock and no SQLite transaction.
      expect(snapshot.pendingCheckpointId).toContain("plan-approval");
      log.maxInFlightDuringWait = log.inFlight;
      expect(log.inFlight).toBe(0);
      expect(log.calls).not.toContain("runWorkerStep");
      expect(log.calls).not.toContain("runVerification");

      await answerGate(handle, snapshot.pendingCheckpointId!);

      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(log.calls).toContain("runWorkerStep");
      expect(log.calls).toContain("runVerification");
      expect(log.calls).toContain("completeTask");
    });
  }, 120_000);

  /**
   * The guard test for this whole class of defect: a correctly-implemented
   * engine that production code never calls. It asserts the enforcement points
   * are REACHED on the ordinary success path, not merely that they work when
   * called directly. Five separate engines in this repo were dead this way; if
   * any of these assertions starts failing, another one just died.
   */
  it("reaches every enforcement point on the ordinary path", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      requiredGates: ["plan-approval", "review-approval"],
      effectiveGates: { ...policy.humanGates, review: "before-complete" },
      workerRuntime: { provider: "claude", modelProfile: "standard" },
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-guard-1"),
        args: [{ ...input, taskId: "t-guard-1" }],
      });

      for (const kind of ["plan-approval", "review-approval"]) {
        const snapshot = await waitForStatus(
          handle,
          (s) => s.pendingCheckpointId !== undefined && s.pendingCheckpointId.includes(kind),
          `the ${kind} gate`,
        );
        await answerGate(handle, snapshot.pendingCheckpointId!);
      }

      const result = await handle.result();
      expect(result.status).toBe("completed");
    });

    // The review gate is answered by a human during the terminal review step,
    // so the completion check does not ask the same question again — but the
    // answer it accepts is that one, which is the last thing before completion
    // in every shipped pipeline (see `../pipelines-guard.test.ts`).
    expect(log.checkpoints.filter((c) => c.kind === "review-approval").length).toBe(1);

    // 1. The budget was charged, and every charge names the ROOT task.
    expect(log.charges.length).toBeGreaterThan(0);
    expect(log.charges.every((c) => c.rootTaskId === "t-guard-1")).toBe(true);
    expect(log.charges.map((c) => c.kind)).toEqual(
      expect.arrayContaining(["agent-run", "verification-group", "review-group", "review-round"]),
    );

    // 2. Every counted unit of work is charged BEFORE it runs. An unbounded
    //    `while` that forgot to charge is exactly what this catches.
    const counted = new Set(["planTask", "runWorkerStep", "runVerification", "runReview"]);
    for (let i = 0; i < log.calls.length; i += 1) {
      const call = log.calls[i];
      if (call === undefined || !counted.has(call)) continue;
      const preceding = log.calls.slice(0, i).filter((c) => c.startsWith("chargeBudget"));
      expect(preceding.length).toBeGreaterThan(0);
    }

    // 3. The checkpoint policy was consulted, with the context that makes the
    //    mandatory floor and the on-risk / on-findings modes decidable at all.
    const planQuery = log.checkpoints.find((c) => c.kind === "plan-approval");
    expect(planQuery?.risk).toBe("low");
    const reviewQuery = log.checkpoints.find((c) => c.kind === "review-approval");
    expect(reviewQuery?.hasFindings).toBe(false);
    expect(log.workerSteps[0]).toMatchObject({ provider: "claude", modelProfile: "standard" });
    expect(log.reviewSteps[0]).toMatchObject({
      provider: "claude",
      modelProfile: "standard",
      capabilities: ["repo.read"],
      projectAccess: [{ projectId: "p1", mode: "read" }],
    });
    expect(log.reviewSteps[0]?.brief.summary).toBe("add feature");
    expect(log.reviewSteps[0]?.verification?.status).toBe("passed");
  }, 120_000);

  it("stops a persistently failing verification at the fix-round limit", async () => {
    const log = newLog();
    const tightPolicy: WorkspacePolicy = {
      ...policy,
      limits: { ...policy.limits, maxFixRounds: 2 },
    };
    const activities = makeActivities(log, {
      policy: tightPolicy,
      verificationPasses: false,
      requiredGates: [],
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-loop-1"),
        args: [{ ...input, taskId: "t-loop-1", policy: tightPolicy }],
      });

      // The limit checkpoint is never optional; the task is paused on it.
      const paused = await waitForStatus(
        handle,
        (s) => s.status === "needs_attention" && s.pendingCheckpointId !== undefined,
        "the limit checkpoint",
      );
      expect(paused.pendingCheckpointId).toContain("limit-exceeded");

      // Extending the budget does not buy more fix rounds, so the task stops.
      await answerGate(handle, paused.pendingCheckpointId!);

      const result = await handle.result();
      expect(result.status).toBe("needs_attention");
    });

    // Bounded, not merely "eventually stopped": 2 fix rounds means a handful of
    // agent runs, nowhere near the 4074 the unguarded loop produced.
    expect(log.agentRuns).toBeLessThanOrEqual(10);
    expect(log.calls.filter((c) => c === "runVerification").length).toBeLessThanOrEqual(4);
    // 2 rounds granted, 1 denied, 1 retried after the extension — and no more.
    expect(log.charges.filter((c) => c.kind === "fix-round").length).toBe(4);
  }, 120_000);

  it("extends the budget exactly once on the real path", async () => {
    const log = newLog();
    // Two steps of budget: enough for the plan and the implement step, then the
    // verification group must ask for an extension.
    const tinyPolicy: WorkspacePolicy = {
      ...policy,
      limits: { ...policy.limits, maxSteps: 2 },
    };
    const activities = makeActivities(log, { policy: tinyPolicy, requiredGates: [] });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-extend-1"),
        args: [
          {
            ...input,
            taskId: "t-extend-1",
            policy: tinyPolicy,
            // Force a second limit: verification keeps failing, so the fix loop
            // burns the extension too.
          },
        ],
      });

      // First limit: approve, which spends the one available extension.
      const first = await waitForStatus(
        handle,
        (s) => s.status === "needs_attention" && s.pendingCheckpointId !== undefined,
        "the first limit checkpoint",
      );
      await answerGate(handle, first.pendingCheckpointId!);

      const result = await handle.result();
      expect(result.status).toBe("completed");
    });

    expect(log.extensions).toBe(1);

    // A second task whose verification never goes green: the one extension is
    // spent on the first limit, so the next one pauses for good.
    const log2 = newLog();
    const activities2 = makeActivities(log2, {
      policy: tinyPolicy,
      verificationPasses: false,
      requiredGates: [],
    });
    await withWorkers(activities2, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-extend-2"),
        args: [{ ...input, taskId: "t-extend-2", policy: tinyPolicy }],
      });

      let answered: string | undefined;
      for (let i = 0; i < 2; i += 1) {
        const paused = await waitForStatus(
          handle,
          (s) =>
            s.status === "needs_attention" &&
            s.pendingCheckpointId !== undefined &&
            s.pendingCheckpointId !== answered,
          `limit checkpoint ${i + 1}`,
        );
        answered = paused.pendingCheckpointId;
        await answerGate(handle, answered!);
      }

      const result = await handle.result();
      expect(result.status).toBe("needs_attention");
    });
    // Asked twice, granted once.
    expect(log2.extensions).toBe(2);
  }, 180_000);

  /**
   * The companion to "reaches every enforcement point": that test proves the
   * budget is CHARGED, this one proves its verdict is OBEYED. Charging and then
   * ignoring the answer is not enforcement, and mutation testing showed every
   * charge below could be reduced to a no-op with a fully green suite.
   *
   * The scenario denies exactly one charge and refuses the single extension the
   * operator is offered, so the denial has to stand. What it asserts is a
   * bounded invocation COUNT of the work the charge was supposed to authorise:
   * a status alone would still pass if the work ran first and the task stopped
   * afterwards.
   */
  async function runWithDeniedCharge(
    taskId: string,
    denyBudget: (charge: ChargeBudgetInput) => boolean,
  ): Promise<Log> {
    const log = newLog();
    const activities = makeActivities(log, {
      requiredGates: [],
      denyBudget,
      allowExtension: false,
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId(taskId),
        args: [{ ...input, taskId }],
      });

      const paused = await waitForStatus(
        handle,
        (s) => s.status === "needs_attention" && s.pendingCheckpointId !== undefined,
        "the limit checkpoint",
      );
      expect(paused.pendingCheckpointId).toContain("limit-exceeded");

      // Approving spends the one extension on offer; it is refused here, so the
      // task must stop rather than proceed on a denied charge.
      await answerGate(handle, paused.pendingCheckpointId!);

      const result = await handle.result();
      expect(result.status).toBe("needs_attention");
    });

    expect(log.extensions).toBe(1);
    return log;
  }

  it("honours a denied plan charge: the Manager never plans", async () => {
    const log = await runWithDeniedCharge(
      "t-deny-plan-1",
      (charge) => charge.kind === "agent-run" && charge.stepKey === "plan",
    );

    expect(log.calls.filter((c) => c === "planTask")).toHaveLength(0);
    expect(log.calls.filter((c) => c === "runWorkerStep")).toHaveLength(0);
    expect(log.workerSteps).toHaveLength(0);
    // No agent ran at all, and the denied charge was asked once — the refused
    // extension means it is not even retried.
    expect(log.agentRuns).toBe(0);
    expect(log.charges.filter((c) => c.kind === "agent-run")).toHaveLength(1);
  }, 120_000);

  it("honours a denied step charge: the Worker never runs", async () => {
    const log = await runWithDeniedCharge(
      "t-deny-step-1",
      (charge) => charge.kind === "agent-run" && charge.stepKey === "implement",
    );

    expect(log.calls.filter((c) => c === "runWorkerStep")).toHaveLength(0);
    expect(log.workerSteps).toHaveLength(0);
    // The plan is the only agent run the budget authorised.
    expect(log.agentRuns).toBe(1);
    expect(log.calls.filter((c) => c === "runVerification")).toHaveLength(0);
  }, 120_000);

  it("honours a denied verification charge: no command group runs", async () => {
    const log = await runWithDeniedCharge(
      "t-deny-verify-1",
      (charge) => charge.kind === "verification-group",
    );

    expect(log.calls.filter((c) => c === "runVerification")).toHaveLength(0);
    expect(log.calls.filter((c) => c === "runReview")).toHaveLength(0);
    expect(log.charges.filter((c) => c.kind === "verification-group")).toHaveLength(1);
  }, 120_000);

  it("honours a denied review-group charge: the reviewer never runs", async () => {
    const log = await runWithDeniedCharge(
      "t-deny-reviewgroup-1",
      (charge) => charge.kind === "review-group",
    );

    expect(log.calls.filter((c) => c === "runReview")).toHaveLength(0);
    expect(log.calls.filter((c) => c === "decideNextAction")).toHaveLength(0);
    // The group charge is denied before the round charge is ever attempted.
    expect(log.charges.filter((c) => c.kind === "review-round")).toHaveLength(0);
  }, 120_000);

  it("honours a denied review-round charge: the reviewer never runs", async () => {
    const log = await runWithDeniedCharge(
      "t-deny-reviewround-1",
      (charge) => charge.kind === "review-round",
    );

    expect(log.calls.filter((c) => c === "runReview")).toHaveLength(0);
    expect(log.calls.filter((c) => c === "decideNextAction")).toHaveLength(0);
    expect(log.charges.filter((c) => c.kind === "review-group").length).toBeGreaterThan(0);
  }, 120_000);

  it("honours a denied fix-round charge: no fix step is dispatched", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      requiredGates: [],
      verificationPasses: false,
      denyBudget: (charge) => charge.kind === "fix-round",
      allowExtension: false,
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-deny-fix-1"),
        args: [{ ...input, taskId: "t-deny-fix-1" }],
      });

      const paused = await waitForStatus(
        handle,
        (s) => s.status === "needs_attention" && s.pendingCheckpointId !== undefined,
        "the limit checkpoint",
      );
      expect(paused.pendingCheckpointId).toContain("limit-exceeded");
      await answerGate(handle, paused.pendingCheckpointId!);

      const result = await handle.result();
      expect(result.status).toBe("needs_attention");
    });

    // One implement step ran; the denied fix round dispatched no second one.
    expect(log.workerSteps.map((s) => s.stepKey)).toEqual(["implement"]);
    expect(log.calls.filter((c) => c === "runVerification")).toHaveLength(1);
    expect(log.extensions).toBe(1);
  }, 120_000);

  it("does not let an agent satisfy the gate that reviews it", async () => {
    const log = newLog();
    // The reviewer reports nothing and the Manager declares completion — the
    // exact pair that used to reach `completed` with no human involved.
    const activities = makeActivities(log, {
      findings: { findings: [] },
      managerDecision: { type: "complete" },
      effectiveGates: { ...policy.humanGates, review: "on-findings" },
      requiredGates: ["review-approval"],
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-selfgate-1"),
        args: [{ ...input, taskId: "t-selfgate-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_review_approval",
        "the review gate",
      );
      expect(log.calls).not.toContain("completeTask");

      await answerGate(handle, waiting.pendingCheckpointId!);
      const result = await handle.result();
      expect(result.status).toBe("completed");
    });
  }, 120_000);

  it("stops a side-effect-capable plan at the side-effect gate", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: { ...PLAN, summary: "deploy the service and open a pull request" },
      requiredGates: ["side-effect-approval"],
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-side-1"),
        args: [{ ...input, taskId: "t-side-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_side_effect_approval",
        "the side-effect gate",
      );
      expect(log.calls).not.toContain("runWorkerStep");
      const query = log.checkpoints.find((c) => c.kind === "side-effect-approval");
      expect(query?.securityMandated).toBe(true);

      await answerGate(handle, waiting.pendingCheckpointId!);
      const result = await handle.result();
      expect(result.status).toBe("completed");

      // Approving is not a formality: the capability is now in the run scope
      // the node receives. Without this the gate answer changed nothing.
      const worked = log.workerSteps.find((s) => s.workerProfile === "implementer");
      expect(worked?.capabilities).toContain("external-side-effect");
    });
  }, 120_000);

  /**
   * The evasion the string detector cannot see. Nothing in this plan mentions
   * push, deploy or a pull request; the gate fires because the step it asks for
   * would be GRANTED shell plus network egress, which is structured data the
   * planning agent does not author.
   */
  it("gates a plan that never narrates its side effect", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: {
        ...PLAN,
        summary: "Finish the sync.",
        steps: [
          {
            key: "sync",
            kind: "other",
            description: "Run `scripts/sync.sh` to finish.",
            workerProfile: "researcher",
            dependsOn: [],
          },
        ],
      },
      requiredGates: ["side-effect-approval"],
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-side-terse-1"),
        args: [{ ...input, taskId: "t-side-terse-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_side_effect_approval",
        "the side-effect gate",
      );
      expect(log.calls).not.toContain("runWorkerStep");
      expect(log.workerSteps).toHaveLength(0);

      await answerGate(handle, waiting.pendingCheckpointId!);
      await handle.result();
    });
  }, 120_000);

  it("halts the task when the side-effect gate is rejected", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: { ...PLAN, summary: "deploy the service" },
      requiredGates: ["side-effect-approval"],
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-side-reject-1"),
        args: [{ ...input, taskId: "t-side-reject-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_side_effect_approval",
        "the side-effect gate",
      );
      await answerGate(handle, waiting.pendingCheckpointId!, "rejected");

      const result = await handle.result();
      expect(result.status).not.toBe("completed");
      expect(log.calls).not.toContain("runWorkerStep");
      expect(log.calls).not.toContain("completeTask");
    });
  }, 120_000);

  /**
   * Regression guard for the capability threading itself. Delete the
   * `capabilities` / `projectAccess` arguments in `runWorkerStep` (or send
   * empty arrays from `activities.ts`) and this goes red: it asserts a Worker
   * run carries a non-empty authoritative grant, that the grant is narrowed per
   * step, and that a gate nobody approved never appears in it.
   */
  it("hands every Worker run the control plane's capability grant", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: [] });

    await withWorkers(activities, async (client) => {
      const result = await client.workflow.execute(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-grant-1"),
        args: [{ ...input, taskId: "t-grant-1" }],
      });
      expect(result.status).toBe("completed");
    });

    expect(log.workerSteps.length).toBeGreaterThan(0);
    for (const step of log.workerSteps) {
      expect(step.capabilities.length).toBeGreaterThan(0);
      expect(step.capabilities).toContain("repo.read");
      // No human approved anything here, so nothing may leave the workspace.
      expect(step.capabilities).not.toContain("external-side-effect");
      expect(step.capabilities).not.toContain("network");
      expect(step.projectAccess).toEqual([{ projectId: "p1", mode: "write" }]);
    }
    const implement = log.workerSteps.find((s) => s.workerProfile === "implementer");
    expect(implement?.capabilities).toContain("repo.write");
    expect(implement?.capabilities).toContain("shell");
  }, 120_000);

  /**
   * 10 section 3: the node sandboxes verification to ONE project, inferring it
   * only when the workspace binds exactly one and raising a non-retryable
   * `PolicyViolation` otherwise. The workflow used to send no `projectId` at
   * all, so every coding task on a node that binds two projects halted there.
   * The approved plan is the authority for which project it is.
   */
  it("names the project verification runs in, and the quality-gate catalog", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: [] });

    await withWorkers(activities, async (client) => {
      const result = await client.workflow.execute(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-verify-project-1"),
        args: [{ ...input, taskId: "t-verify-project-1" }],
      });
      expect(result.status).toBe("completed");
    });

    expect(log.verifications.length).toBeGreaterThan(0);
    for (const verification of log.verifications) {
      expect(verification.projectId).toBe("p1");
      expect(verification.plan.commands.length).toBeGreaterThan(0);
      expect(verification.qualityGates.map((g) => g.name)).toContain("test");
    }
  }, 120_000);

  /**
   * A node's refusal is non-retryable, and a non-retryable failure must STOP the
   * task. Letting it escape the workflow failed the execution, which the daemon
   * then re-dispatched: the demo logged the same `PolicyViolation` over and
   * over, ran no gate, and asked no human — the unbounded-loop shape this
   * project has hit before. Delete the try/catch around `runStep` and this goes
   * red, on the loop count as well as the status.
   */
  it("stops the task on a non-retryable verification refusal instead of looping", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      requiredGates: [],
      verificationRefusal: "quality gate `test` is not in this node's catalog",
    });

    await withWorkers(activities, async (client) => {
      const result = await client.workflow.execute(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-verify-refused-1"),
        args: [{ ...input, taskId: "t-verify-refused-1" }],
      });
      // The workflow ENDS, in the one state an operator can act on.
      expect(result.status).toBe("needs_attention");
    });

    // Exactly one attempt: Temporal did not retry the refusal, and neither did
    // the pipeline by looping verify -> fix -> verify.
    expect(log.calls.filter((c) => c === "runVerification")).toHaveLength(1);
    expect(log.calls).not.toContain("completeTask");
    // The operator is told what the node actually said.
    const attention = log.events.find((e) => e.type === "TaskNeedsAttention");
    expect(attention?.payload["reason"]).toBe("step-failed");
    expect(String(attention?.payload["message"])).toContain("not in this node's catalog");
  }, 120_000);

  /**
   * No quality-gate catalog is not an empty one: with no gate policy wired
   * there is nothing to justify a command against, and `?? DEFAULT_QUALITY_GATES`
   * is what made that indistinguishable from an operator choosing `test`.
   */
  it("refuses to verify at all when the workspace has no quality-gate catalog", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: [], qualityGateCatalog: false });

    await withWorkers(activities, async (client) => {
      const result = await client.workflow.execute(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-no-catalog-1"),
        args: [{ ...input, taskId: "t-no-catalog-1" }],
      });
      expect(result.status).toBe("needs_attention");
    });

    expect(log.verifications).toHaveLength(0);
    expect(log.calls).not.toContain("runVerification");
    expect(log.calls).not.toContain("completeTask");
    // It stops BEFORE spending a step of the root budget on it.
    expect(log.charges.filter((c) => c.kind === "verification-group")).toHaveLength(0);
  }, 120_000);

  it("promotes a quick task past its soft deadline without changing its id", async () => {
    const log = newLog();
    const quickPolicy: WorkspacePolicy = {
      ...policy,
      humanGates: { ...policy.humanGates, plan: "never" },
    };
    const activities = makeActivities(log, {
      policy: quickPolicy,
      effectiveGates: quickPolicy.humanGates,
      workerDelayMs: 1_500,
      requiredGates: [],
    });
    const quickInput: TaskWorkflowInput = {
      ...input,
      taskId: "t-quick-1",
      pipeline: "quick",
      lane: "quick",
      policy: quickPolicy,
      quickSoftDeadlineMs: 100,
      promoteTo: "coding",
    };

    await withWorkers(activities, async (client) => {
      const result = await client.workflow.execute(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId(quickInput.taskId),
        args: [quickInput],
      });

      expect(result.taskId).toBe("t-quick-1");
      expect(result.promoted).toBe(true);
      expect(result.lane).toBe("durable");
      expect(result.pipeline).toBe("coding");
      expect(result.status).toBe("completed");
      // Promotion posts no extra progress message.
      expect(log.calls.filter((c) => c === "emitDomainEvent")).toHaveLength(0);
    });
  }, 120_000);

  it("never records a blocked Worker as a successful quick-lane step", async () => {
    const log = newLog();
    const quickPolicy: WorkspacePolicy = {
      ...policy,
      humanGates: { clarification: "never", plan: "never", review: "never", sideEffect: "policy" },
    };
    const activities = makeActivities(log, {
      policy: quickPolicy,
      effectiveGates: quickPolicy.humanGates,
      requiredGates: [],
      workerResult: {
        type: "blocked",
        reason: "repository could not be read",
        proposedQuestion: "retry?",
      },
    });

    await withWorkers(activities, async (client) => {
      await client.workflow.execute(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-quick-blocked-1"),
        args: [
          {
            ...input,
            taskId: "t-quick-blocked-1",
            pipeline: "quick",
            lane: "quick",
            policy: quickPolicy,
          },
        ],
      });
    });

    expect(log.stepOutcomes).toContain("failed");
    expect(log.stepOutcomes.at(-1)).toBe("failed");
  }, 120_000);

  /**
   * 10 section 3: verification commands run inside the execution node's
   * sandbox. The activity used to be proxied with no `taskQueue`, so it went to
   * the control queue and the daemon ran it — while the node's registration,
   * sandbox and all, was never reached. Only a worker that CANNOT serve it can
   * show where it was dispatched.
   */
  it("dispatches verification to the execution node's task queue", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: [] });
    const controlOnly: Activities = {
      ...activities,
      async runVerification() {
        throw new Error("runVerification reached the control plane, outside any sandbox");
      },
    };

    const testEnv = requireEnv();
    const control = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: CONTROL_TASK_QUEUE,
      workflowsPath,
      activities: controlOnly,
    });
    const node = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: nodeTaskQueue("mac-main"),
      activities,
    });

    await control.runUntil(
      node.runUntil(
        (async () => {
          const result = await testEnv.client.workflow.execute(TaskWorkflow, {
            taskQueue: CONTROL_TASK_QUEUE,
            workflowId: taskWorkflowId("t-verify-queue-1"),
            args: [{ ...input, taskId: "t-verify-queue-1" }],
          });
          expect(result.status).toBe("completed");
        })(),
      ),
    );
  }, 120_000);
});

/**
 * The ordinary coding plan: someone reads, someone writes. No planned step asks
 * for anything alarming on its own, and yet the plan-wide grant carries the
 * researcher's `network` into the implementer's `repo.write` + `shell`.
 */
const TWO_STEP_PLAN: ExecutionPlan = {
  ...PLAN,
  steps: [
    {
      key: "look",
      kind: "investigate",
      description: "Read the module.",
      workerProfile: "researcher",
      dependsOn: [],
    },
    {
      key: "impl",
      kind: "implement",
      description: "Rename the helper.",
      workerProfile: "implementer",
      dependsOn: ["look"],
    },
  ],
};

/**
 * A plan that declares no step able to act: an `investigate` and a `review`,
 * with a writable project and verification commands. The planning agent authors
 * `kind` and `workerProfile`, so this shape is agent-controllable — and the
 * pipeline's `implement` step runs whatever it says.
 */
const NO_ACTOR_PLAN: ExecutionPlan = {
  ...PLAN,
  steps: [
    {
      key: "look",
      kind: "investigate",
      description: "Read the module.",
      workerProfile: "researcher",
      dependsOn: [],
    },
    {
      key: "check",
      kind: "review",
      description: "Check the result.",
      workerProfile: "reviewer",
      dependsOn: ["look"],
    },
  ],
};

/**
 * A read-only research task: one `investigate` step by a researcher, a project
 * opened for READING, and no verification commands. Nothing here can act — and
 * on the research pipeline nothing that runs it can either.
 */
const READ_ONLY_RESEARCH_PLAN: ExecutionPlan = {
  summary: "Read the docs and write up what we found.",
  risk: "low",
  projects: [{ projectId: "p1", mode: "read" }],
  steps: [
    {
      key: "look",
      kind: "investigate",
      description: "Read the module.",
      workerProfile: "researcher",
      dependsOn: [],
    },
  ],
  expectedArtifacts: [],
  verification: { commands: [] },
};

describe("the side-effect gate is evaluated on the running pipeline's grants", () => {
  /**
   * The alert-fatigue fix (`task-side-effect-gate-pipeline-202608`).
   *
   * `planWideGrant` unions `BASE_CAPABILITIES` — `repo.write` + `shell` — into
   * the set the old trigger read, so ANY plan with a researcher step tripped it,
   * on every pipeline. A read-only research task asked a human to approve a side
   * effect no step of its pipeline could perform, and a gate people approve
   * reflexively protects nothing.
   */
  it("asks for no side-effect approval on a read-only research task", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: READ_ONLY_RESEARCH_PLAN,
      requiredGates: ["side-effect-approval"],
    });

    await withWorkers(activities, async (client) => {
      const result = await client.workflow.execute(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-research-readonly-1"),
        args: [{ ...input, taskId: "t-research-readonly-1", pipeline: "research" }],
      });
      expect(result.status).toBe("completed");
    });

    expect(log.checkpoints.map((c) => c.kind)).not.toContain("side-effect-approval");
    // And the reason it is safe to stop asking: this is everything its Worker
    // steps were issued. No shell, no repo.write, so nothing to pair the egress
    // with — which is exactly what `sideEffectCapabilities` has always said.
    expect(log.workerSteps.length).toBeGreaterThan(0);
    for (const step of log.workerSteps) {
      expect([...step.capabilities].sort()).toEqual(["network", "repo.read"]);
    }
  }, 120_000);

  /**
   * The escape that must NOT reopen: the coding pipeline's `implement` step is
   * an implementer whatever the plan declares, so the same read-only-looking
   * plan still gates there.
   */
  it("still gates that very plan on the coding pipeline", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: READ_ONLY_RESEARCH_PLAN,
      requiredGates: ["side-effect-approval"],
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-research-on-coding-1"),
        args: [{ ...input, taskId: "t-research-on-coding-1" }],
      });
      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_side_effect_approval",
        "the side-effect gate",
      );
      await answerGate(handle, waiting.pendingCheckpointId!, "rejected");
      const result = await handle.result();
      expect(result.status).not.toBe("completed");
    });

    expect(log.checkpoints.map((c) => c.kind)).toContain("side-effect-approval");
    expect(log.workerSteps).toHaveLength(0);
  }, 120_000);

  /**
   * The legacy branch, driven directly. An execution started on the previous
   * release is parked on exactly this gate, so the branch has to keep asking it:
   * "fix" this test and those executions fail their workflow task on replay.
   */
  it("with the pipeline patch off, still asks for it on the research pipeline", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: READ_ONLY_RESEARCH_PLAN,
      requiredGates: ["side-effect-approval"],
    });

    await withPrePipelineWorkers(activities, async (client) => {
      const handle = await client.workflow.start("TaskWorkflowPrePipelinePatch", {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-legacy-pipeline-1"),
        args: [{ ...input, taskId: "t-legacy-pipeline-1", pipeline: "research" }],
      });
      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_side_effect_approval",
        "the legacy side-effect gate",
      );
      await answerGate(handle, waiting.pendingCheckpointId!);
      await handle.result();
    });

    expect(log.checkpoints.map((c) => c.kind)).toContain("side-effect-approval");
  }, 120_000);
});

describe("the side-effect gate keys on the grant a step is actually issued", () => {
  it("gates an ordinary researcher + implementer plan", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: TWO_STEP_PLAN,
      requiredGates: ["side-effect-approval"],
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-two-step-1"),
        args: [{ ...input, taskId: "t-two-step-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_side_effect_approval",
        "the side-effect gate",
      );
      // Nothing has run yet: the grant is decided before any Worker sees it.
      expect(log.workerSteps).toHaveLength(0);
      const asked = log.checkpoints.find((c) => c.kind === "side-effect-approval");
      expect(asked?.prompt).toContain("network");
      expect(asked?.securityMandated).toBe(true);

      await answerGate(handle, waiting.pendingCheckpointId!);
      const result = await handle.result();
      expect(result.status).toBe("completed");
    });

    // The approval is what put it in the run scope.
    const implement = log.workerSteps.find((s) => s.workerProfile === "implementer");
    expect(implement?.capabilities).toContain("network");
  }, 120_000);

  /**
   * The round-4 escape, end to end.
   *
   * The plan declares NO acting step — an `investigate` and a `review`, both of
   * which stepCapabilities says cannot write or run anything — while asking for
   * a writable project and verification commands. Every trigger that keys on
   * the PLAN's steps therefore sees nothing to gate; the coding pipeline's
   * fixed `implement` step, which the plan does not author, is handed the
   * plan-wide grant regardless. Before the fix this ran to `completed` with
   * checkpoints `[clarification, plan-approval, review-approval]` — no
   * side-effect-approval — and an implement grant of
   * `[repo.read, repo.write, shell, network]`.
   */
  it("gates a plan that declares no acting step, which the pipeline supplies anyway", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: NO_ACTOR_PLAN,
      requiredGates: ["side-effect-approval"],
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-no-actor-1"),
        args: [{ ...input, taskId: "t-no-actor-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_side_effect_approval",
        "the side-effect gate",
      );
      expect(log.workerSteps).toHaveLength(0);
      await answerGate(handle, waiting.pendingCheckpointId!, "rejected");

      const result = await handle.result();
      expect(result.status).not.toBe("completed");
    });

    expect(log.checkpoints.map((c) => c.kind)).toContain("side-effect-approval");
    // The rejection is what keeps the pipeline's implement step out of the
    // network, so nothing ran at all.
    expect(log.workerSteps).toHaveLength(0);
    expect(log.calls).not.toContain("completeTask");
  }, 120_000);

  it("hands out no network at all when that gate is rejected", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: TWO_STEP_PLAN,
      requiredGates: ["side-effect-approval"],
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-two-step-2"),
        args: [{ ...input, taskId: "t-two-step-2" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_side_effect_approval",
        "the side-effect gate",
      );
      await answerGate(handle, waiting.pendingCheckpointId!, "rejected");

      const result = await handle.result();
      expect(result.status).toBe("needs_attention");
    });

    expect(log.workerSteps).toHaveLength(0);
    expect(log.calls).not.toContain("completeTask");
  }, 120_000);
});

/**
 * The legacy branches, driven directly.
 *
 * `replay.test.ts` proves they issue the previous release's COMMANDS; it cannot
 * prove anything about what those commands carry, because activity arguments
 * are not replay-visible. Everything asserted here is the pre-patch behaviour
 * verbatim — including the two defects the patches exist to fix. If an
 * assertion here starts failing, a legacy branch has been "fixed", and every
 * execution still replaying it will fail its workflow task instead.
 */
describe("TaskWorkflow with the patches forced off (the pre-patch path)", () => {
  it("asks for no side-effect gate, and grants the implement step the plan's network", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: TWO_STEP_PLAN,
      // Even though the policy would require it, the pre-patch trigger never
      // asks: it looks at each planned step in isolation.
      requiredGates: ["side-effect-approval"],
    });

    await withPrePatchWorkers(activities, async (client) => {
      const result = await client.workflow.execute("TaskWorkflowPrePatch", {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-legacy-side-1"),
        args: [{ ...input, taskId: "t-legacy-side-1" }],
      });
      expect(result).toMatchObject({ status: "completed" });
    });

    expect(log.checkpoints.map((c) => c.kind)).not.toContain("side-effect-approval");
    // The grant 2dedb76 sent, exactly: the plan-wide union narrowed to the step,
    // network included because the step holds `shell`.
    const implement = log.workerSteps.find((s) => s.workerProfile === "implementer");
    expect(implement?.capabilities).toEqual(["repo.read", "repo.write", "shell", "network"]);
  }, 120_000);

  /**
   * The generation between the two side-effect patches, driven directly:
   * `task-side-effect-gate-grant-202608` taken, `task-side-effect-gate-union`
   * not. It is the branch every execution started after the last deploy is
   * replaying, and it contains the escape the union patch closes — a plan with
   * no acting step asks for nothing and the pipeline's implement step is handed
   * the plan's network anyway. This asserts that defect, verbatim: if it starts
   * failing, the legacy branch has been "fixed" and those executions will fail
   * their workflow task instead.
   */
  it("with only the grant patch, lets a plan with no acting step through ungated", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: NO_ACTOR_PLAN,
      requiredGates: ["side-effect-approval"],
    });

    await withPreUnionWorkers(activities, async (client) => {
      const result = await client.workflow.execute("TaskWorkflowPreUnionPatch", {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-legacy-union-1"),
        args: [{ ...input, taskId: "t-legacy-union-1" }],
      });
      expect(result).toMatchObject({ status: "completed" });
    });

    expect(log.checkpoints.map((c) => c.kind)).not.toContain("side-effect-approval");
    const implement = log.workerSteps.find((s) => s.workerProfile === "implementer");
    expect(implement?.capabilities).toEqual(["repo.read", "repo.write", "shell", "network"]);
  }, 120_000);

  /**
   * The same generation on the plan the grant patch DID catch: it still gates,
   * so the union patch is additive rather than a replacement.
   */
  it("with only the grant patch, still gates the researcher + implementer plan", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: TWO_STEP_PLAN,
      requiredGates: ["side-effect-approval"],
    });

    await withPreUnionWorkers(activities, async (client) => {
      const handle = await client.workflow.start("TaskWorkflowPreUnionPatch", {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-legacy-union-2"),
        args: [{ ...input, taskId: "t-legacy-union-2" }],
      });
      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_side_effect_approval",
        "the side-effect gate",
      );
      await answerGate(handle, waiting.pendingCheckpointId!);
      expect(await handle.result()).toMatchObject({ status: "completed" });
    });

    expect(log.checkpoints.map((c) => c.kind)).toContain("side-effect-approval");
  }, 120_000);

  it("takes the review step's approval as the completion answer", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      requiredGates: ["review-approval"],
      effectiveGates: { ...policy.humanGates, review: "before-complete" },
    });

    await withPrePatchWorkers(activities, async (client) => {
      const handle = await client.workflow.start("TaskWorkflowPrePatch", {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-legacy-review-1"),
        args: [{ ...input, taskId: "t-legacy-review-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.pendingCheckpointId !== undefined,
        "the review gate",
      );
      await answerGate(handle, waiting.pendingCheckpointId!);
      expect(await handle.result()).toMatchObject({ status: "completed" });
    });

    // One review gate, and it was NOT the completion one.
    expect(log.checkpoints.filter((c) => c.kind === "review-approval")).toHaveLength(1);
    expect(log.checkpoints.map((c) => c.prompt)).not.toContain("Approve completion?");
    expect(log.completions).toHaveLength(1);
    expect(log.completions[0]?.reviewGateSatisfied).toBe(true);
  }, 120_000);

  it("still refuses to let the Manager's own verdict satisfy the review gate", async () => {
    const log = newLog();
    // No human answers anything, and the Manager declares completion.
    const activities = makeActivities(log, {
      findings: { findings: [] },
      managerDecision: { type: "complete" },
      effectiveGates: { ...policy.humanGates, review: "on-findings" },
      requiredGates: ["review-approval"],
    });

    await withPrePatchWorkers(activities, async (client) => {
      const handle = await client.workflow.start("TaskWorkflowPrePatch", {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-legacy-selfgate-1"),
        args: [{ ...input, taskId: "t-legacy-selfgate-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_review_approval",
        "the completion review gate",
      );
      expect(log.calls).not.toContain("completeTask");
      await answerGate(handle, waiting.pendingCheckpointId!, "rejected");
      expect(await handle.result()).toMatchObject({ status: "needs_attention" });
    });

    expect(log.calls).not.toContain("completeTask");
  }, 120_000);

  it("halts on a refused pre-step gate instead of completing anyway", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: ["plan-approval"] });

    await withPrePatchWorkers(activities, async (client) => {
      const handle = await client.workflow.start("TaskWorkflowPrePatch", {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-legacy-halt-1"),
        args: [{ ...input, taskId: "t-legacy-halt-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_plan_approval",
        "the plan gate",
      );
      await answerGate(handle, waiting.pendingCheckpointId!, "rejected");
      expect(await handle.result()).toMatchObject({ status: "needs_attention" });
    });

    expect(log.calls).not.toContain("runWorkerStep");
    expect(log.calls).not.toContain("completeTask");
  }, 120_000);

  it("charges the root budget and records every step outcome", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: [] });

    await withPrePatchWorkers(activities, async (client) => {
      const result = await client.workflow.execute("TaskWorkflowPrePatch", {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-legacy-budget-1"),
        args: [{ ...input, taskId: "t-legacy-budget-1" }],
      });
      expect(result).toMatchObject({ status: "completed" });
    });

    // The previous release already enforced all three. A legacy branch that
    // "restored" an even older shape would drop them — which is exactly the
    // defect this suite now exists to catch.
    expect(log.charges.length).toBeGreaterThan(0);
    expect(log.charges.every((c) => c.rootTaskId === "t-legacy-budget-1")).toBe(true);
    expect(log.calls).toContain("recordStepOutcome");
    expect(log.calls.filter((c) => c === "loadGatePolicy")).toHaveLength(1);
  }, 120_000);
});

/**
 * Three answers exist, not two.
 *
 * `runGate` branched only on `rejected`, so an `answered` verdict on an
 * approval gate fell through to "proceed": the plan ran, and for a
 * `side-effect-approval` the gated capabilities went into the run scope the
 * node enforces — on an answer that is not consent, and while
 * `gateResumeStatus` was simultaneously sending the task to `needs_attention`.
 * The checkpoint policy refuses an `answer` event on an approval kind today, so
 * this was one policy edit away from being live and nothing pinned it.
 */
describe("an approval gate that is answered rather than approved", () => {
  it("does not grant the side effect", async () => {
    const log = newLog();
    const activities = makeActivities(log, {
      plan: { ...PLAN, summary: "deploy the service and open a pull request" },
      requiredGates: ["side-effect-approval"],
    });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-side-answered-1"),
        args: [{ ...input, taskId: "t-side-answered-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_side_effect_approval",
        "the side-effect gate",
      );
      await answerGate(handle, waiting.pendingCheckpointId!, "answered");

      const result = await handle.result();
      expect(result.status).not.toBe("completed");
      // Not one Worker run, so not one capability handed out.
      expect(log.calls).not.toContain("runWorkerStep");
      expect(log.workerSteps).toHaveLength(0);
      expect(log.calls).not.toContain("completeTask");
    });
  }, 120_000);

  it("does not let the plan proceed", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: ["plan-approval"] });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-plan-answered-1"),
        args: [{ ...input, taskId: "t-plan-answered-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_plan_approval",
        "the plan gate",
      );
      await answerGate(handle, waiting.pendingCheckpointId!, "answered");

      const result = await handle.result();
      expect(result.status).not.toBe("completed");
      expect(log.calls).not.toContain("runWorkerStep");
      expect(log.calls).not.toContain("completeTask");
    });
  }, 120_000);

  /**
   * The review gate is the one approval kind that keeps going on `answered` —
   * its answer is feedback, and `gateResumeStatus` maps it to `running`. What it
   * must NOT do is count as approval, so the completion check hears the truth.
   * Change `reviewGateSatisfied = answer === "approved"` to `= true` and this is
   * the test that goes red.
   */
  it("tells the completion check the review gate was not satisfied", async () => {
    const log = newLog();
    // The Manager raises no review gate of its own (`review: "never"`), so the
    // one that is asked is the completion gate — the answer the completion
    // check reads.
    const activities = makeActivities(log, { requiredGates: ["review-approval"] });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-review-answered-1"),
        args: [{ ...input, taskId: "t-review-answered-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.pendingCheckpointId?.includes("review-approval") === true,
        "the review gate",
      );
      await answerGate(handle, waiting.pendingCheckpointId!, "answered");
      await handle.result();
    });

    const completion = log.completions.at(-1);
    expect(completion, "the task never reached the completion check").toBeDefined();
    expect(completion?.reviewGateSatisfied).toBe(false);
  }, 120_000);
});

describe("the answer signal", () => {
  /**
   * The gate consumes the answer to ITS checkpoint, matched by id.
   *
   * The signal handler used to pre-filter on `pendingCheckpointId` as well; that
   * copy was deleted because nothing could make it fail (an answer arriving
   * before the id is set passes any such filter, and a stale one is dropped
   * here). This is the rule that is actually load-bearing: replace the id match
   * in `runGate` with "take whatever is queued" and the task resumes on an
   * answer meant for another checkpoint.
   */
  it("ignores an answer addressed to another checkpoint", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: ["plan-approval"] });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-stale-answer-1"),
        args: [{ ...input, taskId: "t-stale-answer-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_plan_approval",
        "the plan gate",
      );

      await handle.signal(taskAnswerCheckpointSignal, {
        checkpointId: "cp-someone-elses-checkpoint",
        answer: "approved",
      });
      // Still parked: the gate wants ITS answer.
      for (let i = 0; i < 5; i += 1) {
        const snapshot = await handle.query(taskSnapshotQuery);
        expect(snapshot.pendingCheckpointId).toBe(waiting.pendingCheckpointId);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(log.calls).not.toContain("runWorkerStep");

      await answerGate(handle, waiting.pendingCheckpointId!);
      const result = await handle.result();
      expect(result.status).toBe("completed");
    });
  }, 120_000);

  /**
   * The queue is bounded (`answer-queue.ts`), and the bound must not cost the
   * answer the gate is waiting for.
   *
   * Nothing drains the queue but a gate, so a workflow parked in a two-hour
   * Worker activity accumulated every signal ever sent to it. Bounding it means
   * choosing what to drop, and the choice is "the oldest": the answer a gate is
   * about to want arrives milliseconds after its checkpoint row commits. Drop
   * the newest instead and this test parks forever.
   */
  it("survives more mis-addressed answers than the queue can hold", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: ["plan-approval"] });

    await withWorkers(activities, async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-answer-flood-1"),
        args: [{ ...input, taskId: "t-answer-flood-1" }],
      });

      const waiting = await waitForStatus(
        handle,
        (s) => s.status === "waiting_plan_approval",
        "the plan gate",
      );

      for (let i = 0; i < MAX_QUEUED_ANSWERS * 3; i += 1) {
        await handle.signal(taskAnswerCheckpointSignal, {
          checkpointId: `cp-noise-${i}`,
          answer: "approved",
        });
      }

      await answerGate(handle, waiting.pendingCheckpointId!);
      const result = await handle.result();
      expect(result.status).toBe("completed");
    });
  }, 240_000);
});

describe("a pipeline TaskWorkflow does not implement", () => {
  /**
   * `cross-workspace` is driven by `CrossWorkspaceWorkflow`: its `delegate`,
   * `await-children` and `aggregate` steps are child workflows and signal waits,
   * not activities. Started here, every one of them used to fall into the Worker
   * branch's `default:` and go out to an execution node as an `implementer`
   * Worker run — three control/manager steps running as the wrong role, silently.
   */
  it("pauses instead of dispatching its steps as Worker runs", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: [] });

    await withWorkers(activities, async (client) => {
      const result = await client.workflow.execute(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-cross-1"),
        args: [{ ...input, taskId: "t-cross-1", pipeline: "cross-workspace" }],
      });
      expect(result.status).toBe("needs_attention");
    });

    expect(log.calls).not.toContain("runWorkerStep");
    expect(log.workerSteps).toHaveLength(0);
    expect(log.calls).not.toContain("planTask");
    expect(log.calls).not.toContain("completeTask");
    expect(log.events.map((e) => e.payload["reason"])).toContain("unsupported-pipeline");
  }, 120_000);
});

describe("what the completion check is told", () => {
  /**
   * `verificationRequired` is the control plane's rule, not the pipeline's
   * silence: `evaluateCompletion` refuses a coding task whose verification did
   * not pass, and it can only do that if the workflow says the pipeline requires
   * it. Hardcode `false` here and the check stops asking — masked, until now, by
   * `required-steps-terminal` happening to fail first for the shipped pipelines.
   */
  it("requires verification for a coding task", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: [] });

    await withWorkers(activities, async (client) => {
      const result = await client.workflow.execute(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-verif-required-1"),
        args: [{ ...input, taskId: "t-verif-required-1" }],
      });
      expect(result.status).toBe("completed");
    });

    expect(log.completions.at(-1)?.verificationRequired).toBe(true);
    expect(log.completions.at(-1)?.verification?.status).toBe("passed");
  }, 120_000);

  it("does not require it for a pipeline that runs no verification", async () => {
    const log = newLog();
    const activities = makeActivities(log, { requiredGates: [] });

    await withWorkers(activities, async (client) => {
      await client.workflow.execute(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: taskWorkflowId("t-verif-research-1"),
        args: [{ ...input, taskId: "t-verif-research-1", pipeline: "research" }],
      });
    });

    // A research plan carries no verification commands, so demanding a passed
    // verification would make the pipeline uncompletable.
    expect(log.completions.at(-1)?.verificationRequired).toBe(false);
  }, 120_000);
});
