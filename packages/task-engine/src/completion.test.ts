import { describe, expect, it } from "vitest";
import type { DomainEvent, Task } from "@meidoya/domain";

import { completeTask, evaluateCompletion, type CompletionCheckInput } from "./completion.js";
import { FakeInteractionPolicy, InMemoryTaskRepository } from "./fakes.js";
import { getPipeline } from "./pipelines.js";
import { createTaskMachineState, transition, type TaskMachineState } from "./state-machine.js";
import type { VerificationResult } from "./verification.js";

const passed: VerificationResult = {
  status: "passed",
  groups: [],
  missingArtifacts: [],
  artifacts: [],
  evidence: [],
};

function conditions(overrides: Partial<CompletionCheckInput> = {}): CompletionCheckInput {
  return {
    pipeline: getPipeline("coding"),
    steps: [
      { stepKey: "plan", status: "succeeded" },
      { stepKey: "implement", status: "succeeded" },
      { stepKey: "verify", status: "succeeded" },
      { stepKey: "review", status: "succeeded" },
    ],
    verificationRequired: true,
    verification: passed,
    findings: { findings: [{ id: "F-1", severity: "minor", summary: "nit" }] },
    reviewGateSatisfied: true,
    requiredArtifactPaths: ["diff.patch"],
    storedArtifactPaths: ["diff.patch"],
    notificationRegistered: true,
    ...overrides,
  };
}

describe("completion conditions", () => {
  it("accepts when all conditions hold", () => {
    expect(evaluateCompletion(conditions())).toEqual({ ok: true });
  });

  it("requires every required step to be terminal", () => {
    const result = evaluateCompletion(
      conditions({ steps: [{ stepKey: "plan", status: "succeeded" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unmet).toContain("required-steps-terminal");
  });

  it("counts a required step that RAN and failed, not just one that is absent", () => {
    // The test above deletes the step from the list, which is caught by the
    // `status === undefined` half of the predicate alone. Nothing covered the
    // other half, so the terminal-status check could be weakened to
    // `status === undefined && !TERMINAL.includes(status)` — under which a task
    // whose implement step FAILED satisfies "required steps terminal" and
    // completes. Found by the mutation gate; see docs/mutation-testing.md.
    for (const status of ["failed", "running", "pending"] as const) {
      const result = evaluateCompletion(
        conditions({
          steps: [
            { stepKey: "plan", status: "succeeded" },
            { stepKey: "implement", status },
            { stepKey: "verify", status: "succeeded" },
            { stepKey: "review", status: "succeeded" },
          ],
        }),
      );
      expect(result.ok, status).toBe(false);
      if (!result.ok) expect(result.unmet, status).toContain("required-steps-terminal");
    }
  });

  it("does not consult verification at all on a pipeline that requires none", () => {
    // Pins that `verificationRequired` actually gates the check: with the
    // condition forced true, a research task with no verification result would
    // stop completing.
    const noVerification = conditions({ verificationRequired: false });
    delete noVerification.verification;
    expect(evaluateCompletion(noVerification)).toEqual({ ok: true });
  });

  it("accepts a task that carries no findings report at all", () => {
    // `input.findings ? … : []` guards a call that assumes a report is present;
    // nothing exercised the absent case, so the guard had no signal.
    const noFindings = conditions();
    delete noFindings.findings;
    expect(evaluateCompletion(noFindings)).toEqual({ ok: true });
  });

  it("requires the verification policy to be satisfied", () => {
    const result = evaluateCompletion(
      conditions({ verification: { ...passed, status: "failed" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unmet).toContain("verification-policy-satisfied");

    const withoutVerification = conditions();
    delete withoutVerification.verification;
    expect(evaluateCompletion(withoutVerification).ok).toBe(false);
  });

  it("requires no unresolved blocking finding", () => {
    const result = evaluateCompletion(
      conditions({ findings: { findings: [{ id: "F-9", severity: "blocking", summary: "x" }] } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unmet).toContain("no-unresolved-blocking-findings");
  });

  it("requires the review gate, stored artifacts and the outbox row", () => {
    const result = evaluateCompletion(
      conditions({
        reviewGateSatisfied: false,
        storedArtifactPaths: [],
        notificationRegistered: false,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unmet).toEqual([
        "review-gate-satisfied",
        "required-artifacts-stored",
        "completion-notification-registered",
      ]);
    }
  });
});

function setup(): {
  repo: InMemoryTaskRepository;
  policy: FakeInteractionPolicy;
  state: TaskMachineState;
  event: DomainEvent;
} {
  const repo = new InMemoryTaskRepository();
  const task: Task = {
    id: "t1",
    workspaceId: "ws1",
    origin: "chat",
    pipeline: "coding",
    title: "t",
    intent: { summary: "t", projects: [], origin: "chat" },
    status: "reviewing",
    temporalWorkflowId: "task/t1",
    version: 7,
    createdAt: 0,
    updatedAt: 0,
  };
  repo.tasks.set(task.id, task);

  const base = createTaskMachineState({
    taskId: "t1",
    pipeline: "coding",
    lane: "durable",
    now: 0,
  });
  const state: TaskMachineState = { ...base, status: "reviewing" };

  return {
    repo,
    policy: new FakeInteractionPolicy(),
    state,
    event: {
      id: "e1",
      taskId: "t1",
      workspaceId: "ws1",
      type: "TaskCompleted",
      payload: { summary: "done" },
      createdAt: 0,
    },
  };
}

describe("completeTask", () => {
  it("writes the terminal status and the outbox row in one transaction", async () => {
    const { repo, policy, state, event } = setup();
    const result = await completeTask({
      state,
      taskVersion: 7,
      event,
      conditions: conditions(),
      now: 100,
      ports: { repository: repo, interactionPolicy: policy },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.status).toBe("completed");
    expect(repo.tasks.get("t1")?.status).toBe("completed");
    expect(repo.outbox).toHaveLength(1);
    expect(repo.events.map((e) => e.eventType)).toEqual(["TaskCompleted"]);
  });

  it("rolls the completion back when the outbox write fails", async () => {
    const { repo, policy, state, event } = setup();
    repo.enqueueNotification = () => {
      throw new Error("outbox down");
    };

    await expect(
      completeTask({
        state,
        taskVersion: 7,
        event,
        conditions: conditions(),
        now: 100,
        ports: { repository: repo, interactionPolicy: policy },
      }),
    ).rejects.toThrow("outbox down");

    expect(repo.tasks.get("t1")?.status).toBe("reviewing");
    expect(repo.events).toHaveLength(0);
  });

  it("refuses to complete when a condition is unmet", async () => {
    const { repo, policy, state, event } = setup();
    const result = await completeTask({
      state,
      taskVersion: 7,
      event,
      conditions: conditions({ reviewGateSatisfied: false }),
      now: 100,
      ports: { repository: repo, interactionPolicy: policy },
    });
    expect(result).toMatchObject({ ok: false, reason: "conditions-unmet" });
    expect(repo.tasks.get("t1")?.status).toBe("reviewing");
    // Deriving intents must not announce anything. Publishing before the
    // conditions were checked told every `task watch` client the task had
    // completed, and the task then went to `needs_attention`.
    expect(policy.published).toEqual([]);
  });

  it("announces completion to live subscribers only after the write commits", async () => {
    const { repo, policy, state, event } = setup();
    const ok = await completeTask({
      state,
      taskVersion: 7,
      event,
      conditions: conditions({}),
      now: 100,
      ports: { repository: repo, interactionPolicy: policy },
    });
    expect(ok).toMatchObject({ ok: true });
    expect(policy.published).toEqual([event]);
    expect(repo.tasks.get("t1")?.status).toBe("completed");
  });

  it("records the emit ledger only once the intents are durable", async () => {
    const { repo, policy, state, event } = setup();
    const ok = await completeTask({
      state,
      taskVersion: 7,
      event,
      conditions: conditions({}),
      now: 100,
      ports: { repository: repo, interactionPolicy: policy },
    });
    expect(ok).toMatchObject({ ok: true });
    expect(policy.recorded).toEqual(repo.outbox.map((intent) => intent.idempotencyKey));
  });

  it("does not record a ledger entry for a transaction that rolled back", async () => {
    // The ledger is what turns a repeat into an EDIT. Recorded before the
    // commit, a retried attempt would edit a row that was never inserted.
    const { repo, policy, state, event } = setup();
    repo.enqueueNotification = () => {
      throw new Error("outbox down");
    };
    await expect(
      completeTask({
        state,
        taskVersion: 7,
        event,
        conditions: conditions({}),
        now: 100,
        ports: { repository: repo, interactionPolicy: policy },
      }),
    ).rejects.toThrow("outbox down");
    expect(policy.recorded).toEqual([]);
  });

  it("does not announce a completion whose transaction rolled back", async () => {
    const { repo, policy, state, event } = setup();
    repo.enqueueNotification = () => {
      throw new Error("outbox down");
    };
    await expect(
      completeTask({
        state,
        taskVersion: 7,
        event,
        conditions: conditions({}),
        now: 100,
        ports: { repository: repo, interactionPolicy: policy },
      }),
    ).rejects.toThrow("outbox down");
    expect(policy.published).toEqual([]);
  });

  it("refuses to complete when the interaction policy produces no notification", async () => {
    const { repo, state, event } = setup();
    const silent = new FakeInteractionPolicy(["TaskCompleted"]);
    const result = await completeTask({
      state,
      taskVersion: 7,
      event,
      conditions: conditions(),
      now: 100,
      ports: { repository: repo, interactionPolicy: silent },
    });
    expect(result).toEqual({ ok: false, reason: "no-notification" });
    expect(repo.tasks.get("t1")?.status).toBe("reviewing");
  });

  it("reports a version conflict and leaves the task untouched", async () => {
    const { repo, policy, state, event } = setup();
    const result = await completeTask({
      state,
      taskVersion: 3,
      event,
      conditions: conditions(),
      now: 100,
      ports: { repository: repo, interactionPolicy: policy },
    });
    expect(result).toEqual({ ok: false, reason: "version-conflict" });
    expect(repo.tasks.get("t1")?.status).toBe("reviewing");
    expect(repo.outbox).toHaveLength(0);
  });

  it("rejects completion from a state that cannot reach completed", async () => {
    const { repo, policy, event } = setup();
    const base = createTaskMachineState({
      taskId: "t1",
      pipeline: "coding",
      lane: "durable",
      now: 0,
    });
    const cancelled = transition(base, { to: "cancelled" }, 1);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;

    const result = await completeTask({
      state: cancelled.state,
      taskVersion: 7,
      event,
      conditions: conditions(),
      now: 100,
      ports: { repository: repo, interactionPolicy: policy },
    });
    expect(result).toMatchObject({ ok: false, reason: "illegal-transition" });
  });
});
