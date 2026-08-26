import { startTimeSkippingEnv } from "@meidoya/temporal-test-env";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ExecutionPlan,
  HumanCheckpointKind,
  WorkspacePolicy,
} from "@meidoya/domain";
import type { Activities, CreateCheckpointInput } from "@meidoya/workflows-temporal";
import { CONTROL_TASK_QUEUE, nodeTaskQueue, taskWorkflowId } from "@meidoya/workflows-temporal";
import {
  TaskWorkflow,
  taskAnswerCheckpointSignal,
  taskSnapshotQuery,
  type TaskSnapshot,
  type TaskWorkflowInput,
  // The workflow entry point is not re-exported from the package root (it is
  // bundled by path, exactly as the daemon bundles it), so it is imported by
  // the same built path `controlWorkflowsPath()` hands to the worker.
} from "@meidoya/workflows-temporal/dist/workflows/index.js";
import { controlWorkflowsPath } from "./temporal.js";

/**
 * The other half of #4's guarantee. Recovery turns at-most-once delivery of a
 * checkpoint answer into at-least-once: a committed answer may reach the
 * workflow twice (a client retry racing the reconciliation sweep, or simply two
 * retries). That is only a safe trade if the SECOND delivery is inert — which
 * is a property of the real TaskWorkflow, not of the daemon, so it is asserted
 * against the real TaskWorkflow.
 *
 * The dangerous interleaving is the one exercised here: the duplicate arrives
 * *after* the gate it belongs to was consumed and while a LATER gate is parked
 * waiting. A workflow that drained its answer queue positionally would sail
 * through that later gate on a stale answer — approving a review nobody
 * reviewed. Matching by checkpoint id is what makes it inert.
 */

const policy: WorkspacePolicy = {
  requestPolicy: { quickSoftDeadlineMs: 120_000, defaultPipeline: "coding" },
  humanGates: {
    clarification: "never",
    plan: "always",
    review: "always",
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

const REQUIRED_GATES: HumanCheckpointKind[] = ["plan-approval", "review-approval"];

type Log = { checkpoints: CreateCheckpointInput[]; statuses: string[] };

function makeActivities(log: Log): Activities {
  let version = 0;
  let seq = 0;
  let steps = 0;
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} is not part of this scenario`);
  };
  return {
    loadTaskContext: unused("loadTaskContext"),
    assessRequest: unused("assessRequest"),
    executeAdministrativeCommand: unused("executeAdministrativeCommand"),
    finalizeIntakeRequest: unused("finalizeIntakeRequest"),
    materializeScheduledRequest: unused("materializeScheduledRequest"),
    createDelegation: unused("createDelegation"),
    async loadGatePolicy() {
      return {
        mandatoryGates: {},
        effectiveGates: policy.humanGates,
        qualityGates: [{ name: "test", argv: ["npm", "test"] }],
      };
    },
    async loadWorkspacePolicy() {
      return { policy, revision: 1 };
    },
    async recordStepOutcome() {},
    async chargeBudget() {
      steps += 1;
      return { allowed: true, stepsUsed: steps };
    },
    async extendBudget() {
      return { ok: false, reason: "already-extended" };
    },
    async planTask() {
      return { status: "planned" as const, plan: PLAN };
    },
    async runWorkerStep() {
      return { type: "completed" as const, summary: "done", artifacts: [], evidence: [] };
    },
    async runVerification() {
      return {
        status: "passed" as const,
        groups: [],
        missingArtifacts: [],
        artifacts: [],
        evidence: [],
      };
    },
    async runReview() {
      return { findings: [] };
    },
    async decideNextAction() {
      return { type: "complete" as const };
    },
    async resolveWorkerRuntime() {
      return {
        runtime: { provider: "codex", modelProfile: "standard" },
        allowedRuntimes: [{ provider: "codex", modelProfile: "standard" }],
      };
    },
    async recordTaskStatus(input) {
      version += 1;
      log.statuses.push(input.status);
      return { applied: true, version };
    },
    async createCheckpoint(input) {
      log.checkpoints.push(input);
      seq += 1;
      const required = input.kind === "limit-exceeded" || REQUIRED_GATES.includes(input.kind);
      return {
        checkpointId: required ? `cp-${input.kind}-${seq}` : "",
        version: input.version,
        required,
      };
    },
    async emitDomainEvent() {},
    async completeTask() {
      return { status: "completed" as const };
    },
    async compareWithPreviousResult() {
      return { changed: true };
    },
  };
}

const input: TaskWorkflowInput = {
  taskId: "t-redeliver-1",
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
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

type Handle = {
  query: (q: typeof taskSnapshotQuery) => Promise<TaskSnapshot>;
  signal: (
    s: typeof taskAnswerCheckpointSignal,
    a: { checkpointId: string; answer: "approved" | "rejected" | "answered" },
  ) => Promise<void>;
};

/** Polls the workflow's own query for a condition — no wall-clock guessing. */
async function waitForStatus(
  handle: Handle,
  predicate: (snapshot: TaskSnapshot) => boolean,
  what: string,
): Promise<TaskSnapshot> {
  for (let i = 0; i < 400; i += 1) {
    const snapshot = await handle.query(taskSnapshotQuery);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("duplicate checkpoint delivery", () => {
  it("is observed by TaskWorkflow as one logical answer", async () => {
    const testEnv = env;
    if (testEnv === undefined) throw new Error("no test environment");
    const log: Log = { checkpoints: [], statuses: [] };
    const activities = makeActivities(log);

    const control = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: CONTROL_TASK_QUEUE,
      workflowsPath: controlWorkflowsPath(),
      activities,
    });
    const node = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: nodeTaskQueue("mac-main"),
      activities,
    });

    await control.runUntil(
      node.runUntil(
        (async () => {
          const handle = await testEnv.client.workflow.start(TaskWorkflow, {
            taskQueue: CONTROL_TASK_QUEUE,
            workflowId: taskWorkflowId(input.taskId),
            args: [input],
          });

          const parked = await waitForStatus(
            handle,
            (s) => s.status === "waiting_plan_approval",
            "the plan gate",
          );
          const planCheckpoint = parked.pendingCheckpointId;
          expect(planCheckpoint).toBeDefined();

          // Delivery 1: the answer the daemon committed.
          await handle.signal(taskAnswerCheckpointSignal, {
            checkpointId: planCheckpoint!,
            answer: "approved",
          });
          // Wait until the workflow has actually consumed it, so the duplicate
          // lands in the explicitly worse position: after consumption.
          await waitForStatus(
            handle,
            (s) => s.pendingCheckpointId !== planCheckpoint,
            "the plan gate to be consumed",
          );

          // Delivery 2: the same committed answer again — the retry or the
          // reconciliation sweep that recovery may produce.
          await handle.signal(taskAnswerCheckpointSignal, {
            checkpointId: planCheckpoint!,
            answer: "approved",
          });

          // The review gate must still park. If the duplicate were consumed
          // positionally it would approve this gate, and the workflow would
          // complete without anyone having answered it.
          const review = await waitForStatus(
            handle,
            (s) => s.status === "waiting_review_approval",
            "the review gate",
          );
          expect(review.pendingCheckpointId).not.toBe(planCheckpoint);

          // Still parked after further round trips: the stale duplicate never
          // satisfies a gate it does not name, however long it sits in the
          // workflow's queue.
          for (let i = 0; i < 3; i += 1) {
            expect((await handle.query(taskSnapshotQuery)).status).toBe("waiting_review_approval");
          }

          // The plan gate itself was consumed exactly once: the duplicate did
          // not re-open it, re-record its wait state, or re-answer it.
          expect(log.checkpoints.filter((c) => c.kind === "plan-approval")).toHaveLength(1);
          expect(log.statuses.filter((s) => s === "waiting_plan_approval")).toHaveLength(1);

          await handle.terminate("test finished");
        })(),
      ),
    );
  }, 180_000);
});
