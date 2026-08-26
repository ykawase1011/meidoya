import { describe, expect, it } from "vitest";
import type { WorkspacePolicy } from "@meidoya/domain";
import {
  FakeAgentPort,
  FakeArtifactProbe,
  FakeCheckpointPolicy,
  FakeCommandRunner,
  FakeExecutionBudget,
  FakeInteractionPolicy,
  FixedClock,
  InMemoryTaskRepository,
  SequentialIds,
} from "@meidoya/task-engine";

import { createActivities, type ActivityDependencies } from "./activities.js";
import { HEARTBEAT_INTERVAL_MS, activityHeartbeat, withHeartbeat } from "./heartbeat.js";
import { MANAGER_ACTIVITY_OPTIONS } from "./retry-policies.js";

const policy: WorkspacePolicy = {
  requestPolicy: { quickSoftDeadlineMs: 1000, defaultPipeline: "coding" },
  humanGates: { clarification: "never", plan: "always", review: "never", sideEffect: "policy" },
  limits: {
    maxSteps: 24,
    maxStepVisits: 5,
    maxFixRounds: 3,
    maxReviewRounds: 3,
    maxNoProgressRounds: 2,
    maxParallelWorkers: 3,
    maxModelEscalations: 2,
    maxConsecutiveFailures: 3,
    maxWallTimeMs: 1000,
  },
  execution: { preferredProfile: "codex-standard", fallbackProfiles: [] },
};

describe("withHeartbeat", () => {
  it("beats immediately and then on the interval, until the work settles", async () => {
    const beats: number[] = [];
    let ticks = 0;
    await withHeartbeat(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return "done";
      },
      { intervalMs: 10, heartbeat: () => beats.push((ticks += 1)) },
    );

    // One immediate beat plus roughly 12 interval beats; the exact count is the
    // scheduler's business, "more than one and it stopped" is ours.
    expect(beats.length).toBeGreaterThan(3);
    const afterSettle = beats.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(beats.length).toBe(afterSettle);
  });

  it("stops beating when the work throws, and re-raises", async () => {
    let beats = 0;
    await expect(
      withHeartbeat(
        async () => {
          throw new Error("agent failed");
        },
        { intervalMs: 5, heartbeat: () => (beats += 1) },
      ),
    ).rejects.toThrow("agent failed");

    const afterThrow = beats;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(beats).toBe(afterThrow);
  });

  it("is a no-op outside a Temporal Activity Context", () => {
    expect(() => activityHeartbeat()).not.toThrow();
  });
});

function setup(agentDelayMs: number, heartbeat: () => void) {
  const repository = new InMemoryTaskRepository();
  const agents = new FakeAgentPort([{ status: "succeeded", output: { ok: true } }]);
  const slowAgents: ActivityDependencies["agents"] = {
    async invoke(invocation) {
      await new Promise((resolve) => setTimeout(resolve, agentDelayMs));
      return agents.invoke(invocation);
    },
  };
  const deps: ActivityDependencies = {
    repository,
    agents: slowAgents,
    checkpointPolicy: new FakeCheckpointPolicy(() => ({ required: false })),
    budget: new FakeExecutionBudget(policy.limits),
    interactionPolicy: new FakeInteractionPolicy(),
    commands: new FakeCommandRunner({}),
    artifacts: new FakeArtifactProbe(),
    clock: new FixedClock(1000),
    ids: new SequentialIds(),
    heartbeat: { heartbeat, intervalMs: 5 },
    prompts: {
      planning: () => "plan",
      worker: () => "work",
      review: () => "review",
      managerDecision: () => "decide",
      maidAssessment: () => "assess",
    },
    policies: { load: async () => ({ policy, revision: 1 }) },
    delegations: {
      create: async () => ({ childTaskId: "c", maidWorkflowId: "m" }),
    },
    scheduledResults: { compare: async () => ({ changed: true }) },
    parse: {
      maidDecision: () => ({ type: "administrative", command: { kind: "task.list" } }),
      plan: () => ({
        summary: "s",
        risk: "low",
        projects: [],
        steps: [],
        expectedArtifacts: [],
        verification: { commands: [] },
      }),
      workerResult: () => ({ type: "completed", summary: "ok", artifacts: [], evidence: [] }),
      reviewFindings: () => ({ findings: [] }),
      managerDecision: () => ({ type: "complete" }),
    },
  };
  return createActivities(deps);
}

/**
 * The production-blocking half of this: `MANAGER_ACTIVITY_OPTIONS` declares a
 * `heartbeatTimeout`, and Temporal enforces it. Nothing in this codebase beat,
 * so every Manager call longer than a minute was killed and retried to
 * exhaustion — and then the workflow failed. Delete the `withHeartbeat` wrapper
 * in `activities.ts` and these go red.
 */
describe("the activities that declare a heartbeat timeout beat", () => {
  it("beats throughout an agent run", async () => {
    let beats = 0;
    const activities = setup(60, () => (beats += 1));
    await activities.planTask({
      taskId: "t1",
      workspaceId: "ws1",
      brief: { summary: "implement change", projects: ["p1"], origin: "cli" },
      stepKey: "plan",
      attempt: 1,
      idempotencyKey: "plan:1",
    });
    expect(beats).toBeGreaterThan(1);
  });

  it("beats throughout a review and a Manager decision", async () => {
    let beats = 0;
    const activities = setup(60, () => (beats += 1));
    await activities.runReview({
      taskId: "t1",
      workspaceId: "ws1",
      brief: { summary: "implement change", projects: ["p1"], origin: "cli" },
      stepKey: "review",
      attempt: 1,
      provider: "codex",
      modelProfile: "standard",
      capabilities: ["repo.read"],
      projectAccess: [{ projectId: "p1", mode: "read" }],
      idempotencyKey: "review:1",
    });
    const afterReview = beats;
    expect(afterReview).toBeGreaterThan(1);

    await activities.decideNextAction({
      taskId: "t1",
      workspaceId: "ws1",
      findings: { findings: [] },
      idempotencyKey: "decide:1",
    });
    expect(beats).toBeGreaterThan(afterReview + 1);
  });

  it("beats throughout a Worker run", async () => {
    let beats = 0;
    const activities = setup(60, () => (beats += 1));
    await activities.runWorkerStep({
      taskId: "t1",
      workspaceId: "ws1",
      brief: { summary: "implement change", projects: ["p1"], origin: "cli" },
      stepKey: "implement",
      stepKind: "implement",
      attempt: 1,
      workerProfile: "implementer",
      provider: "codex",
      modelProfile: "standard",
      capabilities: ["repo.read"],
      projectAccess: [],
      idempotencyKey: "work:1",
    });
    expect(beats).toBeGreaterThan(1);
  });

  it("beats often enough for the timeout it promises", () => {
    // 15s beats against a 1-minute timeout: three may be lost before the server
    // gives up on the worker.
    expect(MANAGER_ACTIVITY_OPTIONS.heartbeatTimeout).toBe("1 minute");
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(60_000 / 3);
  });
});
