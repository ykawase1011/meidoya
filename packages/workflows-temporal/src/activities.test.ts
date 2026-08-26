import { describe, expect, it } from "vitest";
import type { DomainEvent, Task, WorkspacePolicy } from "@meidoya/domain";
import {
  FakeAgentPort,
  FakeArtifactProbe,
  FakeCheckpointPolicy,
  FakeCommandRunner,
  FakeExecutionBudget,
  FakeAgentPort as FakeAgentPortType,
  FakeInteractionPolicy,
  FixedClock,
  InMemoryTaskRepository,
  SequentialIds,
} from "@meidoya/task-engine";

import { createActivities, type ActivityDependencies } from "./activities.js";

const policy: WorkspacePolicy = {
  requestPolicy: { quickSoftDeadlineMs: 1000, defaultPipeline: "coding" },
  humanGates: { clarification: "when-needed", plan: "always", review: "never", sideEffect: "policy" },
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

const task: Task = {
  id: "t1",
  workspaceId: "ws1",
  origin: "chat",
  pipeline: "coding",
  title: "t",
  intent: { summary: "t", projects: [], origin: "chat" },
  status: "planning",
  temporalWorkflowId: "task/t1",
  version: 0,
  createdAt: 0,
  updatedAt: 0,
};

function setup(planRequired = true) {
  const repository = new InMemoryTaskRepository();
  repository.tasks.set(task.id, { ...task });
  const deps: ActivityDependencies = {
    repository,
    agents: new FakeAgentPort([{ status: "succeeded", output: { ok: true } }]),
    checkpointPolicy: new FakeCheckpointPolicy((query) =>
      query.kind === "plan-approval" && planRequired
        ? { required: true, prompt: "Approve plan?", choices: [{ id: "yes", label: "Approve" }] }
        : { required: false },
    ),
    budget: new FakeExecutionBudget(policy.limits),
    interactionPolicy: new FakeInteractionPolicy(),
    commands: new FakeCommandRunner({ lint: { exitCode: 1, failureSignature: "lint-error" } }),
    artifacts: new FakeArtifactProbe(),
    clock: new FixedClock(1000),
    ids: new SequentialIds(),
    prompts: {
      planning: () => "plan",
      worker: () => "work",
      review: () => "review",
      managerDecision: () => "decide",
      maidAssessment: () => "assess",
    },
    policies: {
      load: async () => ({ policy, revision: 1 }),
      gatePolicy: () => ({
        mandatoryGates: { review: "always" },
        effectiveGates: { ...policy.humanGates, review: "always" },
        qualityGates: [{ name: "test", argv: ["npm", "test"] }],
      }),
    },
    delegations: {
      create: async (input) => ({
        childTaskId: `child-${input.targetWorkspaceId}`,
        maidWorkflowId: `maid/home/${input.targetWorkspaceId}`,
      }),
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
  return { deps, repository, activities: createActivities(deps) };
}

describe("activities", () => {
  it("executes an administrative command through the trusted control-plane port", async () => {
    const { activities, deps } = setup();
    const calls: string[] = [];
    deps.administration = {
      async execute(input) {
        calls.push(input.command.kind);
        return { summary: "Schedule daily was created." };
      },
      async materializeScheduledRequest() {
        return { taskId: "unused", pipeline: "scheduled" };
      },
    };

    await expect(
      activities.executeAdministrativeCommand({
        workspaceId: "ws1",
        taskId: "admin-1",
        command: { kind: "schedule.list" },
      }),
    ).resolves.toEqual({ summary: "Schedule daily was created." });
    expect(calls).toEqual(["schedule.list"]);
  });

  it("terminalizes an intake-only request with its notification in one transaction", async () => {
    const { activities, repository, deps } = setup();
    repository.tasks.set("admin-1", {
      ...task,
      id: "admin-1",
      status: "received",
      version: 0,
    });

    await activities.finalizeIntakeRequest({
      workspaceId: "ws1",
      taskId: "admin-1",
      status: "completed",
      eventId: "event-1",
      title: "定期実行",
      summary: "Schedule daily was created.",
      bullets: ["0 9 * * * (Asia/Tokyo)"],
      sections: [{ title: "登録内容", bullets: ["平日 09:00"] }],
    });

    expect(repository.tasks.get("admin-1")?.status).toBe("completed");
    expect(repository.events).toMatchObject([
      {
        taskId: "admin-1",
        eventType: "TaskCompleted",
      },
    ]);
    expect((deps.interactionPolicy as FakeInteractionPolicy).events).toMatchObject([
      {
        type: "TaskCompleted",
        payload: {
          title: "定期実行",
          summary: "Schedule daily was created.",
          bullets: ["0 9 * * * (Asia/Tokyo)"],
          sections: [{ title: "登録内容", bullets: ["平日 09:00"] }],
        },
      },
    ]);
    expect(repository.outbox).toHaveLength(1);
  });

  it("publishes a direct Maid reply without presenting it as task completion", async () => {
    const { activities, repository, deps } = setup();
    repository.tasks.set("reply-1", {
      ...task,
      id: "reply-1",
      status: "received",
      version: 0,
    });

    await activities.finalizeIntakeRequest({
      workspaceId: "ws1",
      taskId: "reply-1",
      status: "completed",
      presentation: "reply",
      eventId: "event-reply",
      summary: "こんにちは。現在進行中のタスクはありません。",
    });

    expect(repository.tasks.get("reply-1")?.status).toBe("completed");
    expect(repository.events.at(-1)?.eventType).toBe("MaidResponded");
    expect((deps.interactionPolicy as FakeInteractionPolicy).events.at(-1)?.type).toBe(
      "MaidResponded",
    );
  });

  it("loads trusted workspace context before invoking the Maid", async () => {
    const { activities, deps } = setup();
    let promptContext: unknown;
    deps.prompts.maidAssessment = (_input, context) => {
      promptContext = context;
      return "assess";
    };
    deps.administration = {
      async execute() {
        return { summary: "unused" };
      },
      context() {
        return {
          activeTaskCount: 0,
          waitingTaskCount: 1,
          enabledScheduleCount: 2,
          openTasks: [
            { taskId: "task-readme", title: "README確認", status: "waiting_user_input" },
          ],
        };
      },
      async materializeScheduledRequest() {
        return { taskId: "unused", pipeline: "scheduled" };
      },
    };

    await activities.assessRequest({
      workspaceId: "ws1",
      requestKey: "request-1",
      origin: "chat",
      messageRef: "event-1",
      idempotencyKey: "assess-1",
    });

    expect(promptContext).toMatchObject({ waitingTaskCount: 1, enabledScheduleCount: 2 });
  });

  it("rejects Maid-selected projects outside the configured workspace", async () => {
    const { activities, deps } = setup();
    deps.workspaceProjects = () => ["parser"];
    deps.parse.maidDecision = () => ({
      type: "durable",
      brief: { summary: "change it", projects: ["foreign-project"], origin: "chat" },
    });

    await expect(
      activities.assessRequest({
        workspaceId: "ws1",
        requestKey: "request-1",
        origin: "chat",
        messageRef: "event-1",
        idempotencyKey: "assess-1",
      }),
    ).resolves.toEqual({
      type: "out_of_scope",
      reason: "Maid selected project ids outside workspace ws1",
    });
  });

  it("records a status change with an optimistic version guard", async () => {
    const { activities, repository } = setup();
    const applied = await activities.recordTaskStatus({
      taskId: "t1",
      status: "running",
      expectedVersion: 0,
      eventType: "TaskStatus:running",
      idempotencyKey: "task:t1:running:1",
    });
    expect(applied).toEqual({ applied: true, version: 1 });
    expect(repository.tasks.get("t1")?.status).toBe("running");

    const stale = await activities.recordTaskStatus({
      taskId: "t1",
      status: "verifying",
      expectedVersion: 0,
      eventType: "TaskStatus:verifying",
      idempotencyKey: "task:t1:verifying:2",
    });
    expect(stale.applied).toBe(false);
    expect(repository.tasks.get("t1")?.status).toBe("running");
  });

  it("creates a checkpoint with exactly one outbox message per version", async () => {
    const { activities, repository, deps } = setup();
    const created = await activities.createCheckpoint({
      taskId: "t1",
      workspaceId: "ws1",
      kind: "plan-approval",
      prompt: "Approve?",
      version: 1,
    });
    expect(created.required).toBe(true);
    expect(repository.outbox).toHaveLength(1);

    // The message is produced by the interaction policy from a typed event
    // carrying the checkpoint's identity + version — which is what makes the
    // real renderer emit exactly one message per version (07 section 4).
    const policy = deps.interactionPolicy as FakeInteractionPolicy;
    expect(policy.events.map((e) => e.type)).toEqual(["WaitingPlanApproval"]);
    expect(policy.events[0]?.payload).toMatchObject({
      checkpointId: created.checkpointId,
      checkpointVersion: created.version,
    });

    const skipped = await activities.createCheckpoint({
      taskId: "t1",
      workspaceId: "ws1",
      kind: "clarification",
      prompt: "?",
      version: 1,
    });
    expect(skipped.required).toBe(false);
    expect(repository.outbox).toHaveLength(1);
  });

  it("never puts raw checkpoint text on the outbox itself", async () => {
    const { activities, repository, deps } = setup();
    const fakeToken = ["ghp_", "0123456789abcdefghij"].join("");
    await activities.createCheckpoint({
      taskId: "t1",
      workspaceId: "ws1",
      kind: "plan-approval",
      // Model text: a secret and an absolute path the renderer must scrub.
      prompt: `token=${fakeToken} under /Users/someone/secrets`,
      version: 1,
    });
    // The activity hands the event to the interaction policy and enqueues only
    // what came back; it never builds an outbox row from the prompt itself.
    const policy = deps.interactionPolicy as FakeInteractionPolicy;
    expect(policy.events).toHaveLength(1);
    expect(repository.outbox).toHaveLength(1);
    expect(repository.outbox[0]?.eventId).toBe(policy.events[0]?.id);
  });

  it("charges the root budget and extends it exactly once", async () => {
    const { activities, deps } = setup();
    const budget = deps.budget as FakeExecutionBudget;

    const charged = await activities.chargeBudget({
      taskId: "child-1",
      rootTaskId: "t1",
      kind: "agent-run",
      stepKey: "implement",
    });
    expect(charged).toEqual({ allowed: true, stepsUsed: 1 });
    // A child charges its ROOT, so children cannot mint budget.
    expect(budget.snapshot("t1")).toEqual({ stepsUsed: 1 });
    expect(budget.snapshot("child-1")).toEqual({ stepsUsed: 0 });

    expect(await activities.extendBudget({ taskId: "t1" })).toMatchObject({ ok: true });
    expect(await activities.extendBudget({ taskId: "t1" })).toEqual({
      ok: false,
      reason: "already-extended",
    });
  });

  it("serves the mandatory gate floor and quality-gate allowlist to the workflow", async () => {
    const { activities } = setup();
    const gates = await activities.loadGatePolicy({ workspaceId: "ws1" });
    expect(gates.mandatoryGates).toEqual({ review: "always" });
    // The floor raised `never` to `always`; the workspace cannot relax it.
    expect(gates.effectiveGates.review).toBe("always");
    expect(gates.qualityGates?.map((g) => g.name)).toEqual(["test"]);
  });

  /**
   * With no gate policy wired, the catalog is ABSENT — not a built-in default.
   * `?? DEFAULT_QUALITY_GATES` here made "nobody configured anything"
   * indistinguishable from "the operator chose `test`", so a task could pass a
   * quality gate no operator ever approved. The workflow refuses to verify
   * without a catalog and the node refuses a run that arrives without one.
   */
  it("serves NO catalog when the deployment wired no gate policy", async () => {
    const { deps } = setup();
    const withoutGatePolicy = createActivities({
      ...deps,
      policies: { load: deps.policies.load },
    });
    const gates = await withoutGatePolicy.loadGatePolicy({ workspaceId: "ws1" });
    expect(gates.qualityGates).toBeUndefined();
    expect(gates.effectiveGates).toEqual(policy.humanGates);
  });

  it("verifies from command evidence", async () => {
    const { activities } = setup();
    const result = await activities.runVerification({
      taskId: "t1",
      workspaceId: "ws1",
      stepKey: "verify",
      plan: { commands: [{ name: "lint", command: "npm run lint" }] },
      qualityGates: [{ name: "lint", argv: ["npm", "run", "lint"] }],
    });
    expect(result.status).toBe("failed");
    expect(result.failureSignature).toBe("lint#lint-error");
  });

  it("refuses completion when a condition is unmet and completes when they hold", async () => {
    const { activities, repository, deps } = setup();
    const rejected = await activities.completeTask({
      taskId: "t1",
      workspaceId: "ws1",
      pipeline: "coding",
      expectedVersion: 0,
      eventId: "e1",
      summary: "done",
      verificationRequired: true,
      reviewGateSatisfied: true,
      requiredArtifactPaths: [],
    });
    expect(rejected.status).toBe("rejected");
    expect(repository.tasks.get("t1")?.status).toBe("planning");

    for (const stepKey of ["plan", "implement", "verify", "review"]) {
      await repository.upsertStep({
        taskId: "t1",
        stepKey,
        stepKind: stepKey,
        status: "succeeded",
        visitCount: 1,
        attemptCount: 1,
      });
    }

    const completed = await activities.completeTask({
      taskId: "t1",
      workspaceId: "ws1",
      pipeline: "coding",
      expectedVersion: 0,
      eventId: "e2",
      summary: "done",
      verificationRequired: true,
      verification: {
        status: "passed",
        groups: [],
        missingArtifacts: [],
        artifacts: [],
        evidence: [],
      },
      reviewGateSatisfied: true,
      requiredArtifactPaths: [],
    });
    expect(completed.status).toBe("completed");
    expect(repository.tasks.get("t1")?.status).toBe("completed");
    expect(repository.outbox).toHaveLength(1);
    expect((deps.interactionPolicy as FakeInteractionPolicy).events.at(-1)?.payload).toMatchObject({
      title: "タスク「t」が完了しました",
      summary: "done",
    });
  });
  /**
   * Regression guard for the capability threading. `runWorkerStep` used to send
   * `scope: { workspaceId, projectAccess: [], capabilities: [] }`, so the run
   * scope the execution node received carried nothing a human had approved and
   * the node fell back to its own standing grant. Put the empty arrays back and
   * this goes red.
   */
  it("sends the control plane's capability grant as the Worker run scope", async () => {
    const { activities, deps } = setup();
    await activities.runWorkerStep({
      taskId: "t1",
      workspaceId: "ws1",
      brief: { summary: "implement change", projects: ["p1"], origin: "cli" },
      stepKey: "impl",
      stepKind: "implement",
      attempt: 1,
      workerProfile: "implementer",
      provider: "codex",
      modelProfile: "standard",
      capabilities: ["repo.read", "repo.write", "shell", "external-side-effect"],
      projectAccess: [{ projectId: "p1", mode: "write" }],
      idempotencyKey: "run:t1:impl:1",
    });

    const agents = deps.agents as FakeAgentPortType;
    const invocation = agents.calls.at(-1);
    expect(invocation?.scope.capabilities).toEqual([
      "repo.read",
      "repo.write",
      "shell",
      "external-side-effect",
    ]);
    expect(invocation?.scope.projectAccess).toEqual([{ projectId: "p1", mode: "write" }]);
    expect(invocation?.scope.workspaceId).toBe("ws1");
  });

  /** Coordinating roles hold nothing, whatever they ask for (09 section 9). */
  it("keeps the Manager's run scope empty", async () => {
    const { activities, deps } = setup();
    await activities.planTask({
      taskId: "t1",
      workspaceId: "ws1",
      brief: { summary: "implement change", projects: ["p1"], origin: "cli" },
      stepKey: "plan",
      attempt: 1,
      idempotencyKey: "run:t1:plan:1",
    });
    const agents = deps.agents as FakeAgentPortType;
    expect(agents.calls.at(-1)?.scope.capabilities).toEqual([]);
  });
});

/**
 * THE ORDER OF THE THREE EFFECTS, at the two activity call sites.
 *
 * `emit` derives, the transaction commits, and only then may anything be
 * observable: the live announcement (`publish`) and the emit ledger
 * (`recordEmitted`). `completeTask` in the engine has carried a regression test
 * for this since it shipped; `createCheckpoint` and `emitDomainEvent` had the
 * identical ordering with NO test — the same mutation there ran the whole suite
 * green, so nothing stopped the announcement drifting back in front of the
 * write it describes.
 */
class ObservingPolicy extends FakeInteractionPolicy {
  /** What the repository held at the moment each event was announced. */
  readonly stateAtPublish: { checkpoints: number; events: number; outbox: number }[] = [];

  constructor(private readonly repo: InMemoryTaskRepository) {
    super();
  }

  override publish(event: DomainEvent): void {
    this.stateAtPublish.push({
      checkpoints: this.repo.checkpoints.size,
      events: this.repo.events.length,
      outbox: this.repo.outbox.length,
    });
    super.publish(event);
  }
}

describe("createCheckpoint and emitDomainEvent announce only what is durable", () => {
  function observed() {
    const rig = setup();
    const policy = new ObservingPolicy(rig.repository);
    const deps: ActivityDependencies = { ...rig.deps, interactionPolicy: policy };
    return { ...rig, policy, activities: createActivities(deps) };
  }

  const checkpointInput = {
    taskId: "t1",
    workspaceId: "ws1",
    kind: "plan-approval" as const,
    prompt: "Approve plan?",
    version: 1,
  };

  const eventInput = {
    taskId: "t1",
    workspaceId: "ws1",
    eventId: "e-domain-1",
    type: "TaskNeedsAttention",
    payload: { reason: "stuck" },
  };

  it("createCheckpoint announces AFTER the checkpoint row and its outbox rows exist", async () => {
    const { activities, policy } = observed();
    await activities.createCheckpoint(checkpointInput);
    expect(policy.published).toHaveLength(1);
    // Publishing before the transaction would see an empty repository here.
    expect(policy.stateAtPublish).toEqual([{ checkpoints: 1, events: 0, outbox: 1 }]);
    // And the ledger records the intents only once they are durable too.
    expect(policy.recorded).toHaveLength(1);
  });

  it("createCheckpoint announces NOTHING when its transaction rolls back", async () => {
    const { activities, policy, repository } = observed();
    repository.enqueueNotification = () => {
      throw new Error("outbox down");
    };
    await expect(activities.createCheckpoint(checkpointInput)).rejects.toThrow("outbox down");
    expect(policy.published).toEqual([]);
    expect(policy.recorded).toEqual([]);
    expect(repository.checkpoints.size).toBe(0);
  });

  it("emitDomainEvent announces AFTER the task event and its outbox rows exist", async () => {
    const { activities, policy } = observed();
    await activities.emitDomainEvent(eventInput);
    expect(policy.published).toHaveLength(1);
    expect(policy.stateAtPublish).toEqual([{ checkpoints: 0, events: 1, outbox: 1 }]);
    expect(policy.recorded).toHaveLength(1);
  });

  it("emitDomainEvent announces NOTHING when its transaction rolls back", async () => {
    const { activities, policy, repository } = observed();
    repository.enqueueNotification = () => {
      throw new Error("outbox down");
    };
    await expect(activities.emitDomainEvent(eventInput)).rejects.toThrow("outbox down");
    expect(policy.published).toEqual([]);
    expect(policy.recorded).toEqual([]);
    expect(repository.events).toEqual([]);
  });
});
