import { describe, expect, it } from "vitest";
import type { ExecutionBudget } from "@meidoya/domain";
import { BudgetLedger, LIMIT_EXCEEDED_CHOICES } from "./ledger.js";
import { COUNTED_STEP_KINDS, stepCost, UNCOUNTED_STEP_KINDS } from "./steps.js";
import type { ProgressInputs } from "./fingerprint.js";

const budget: ExecutionBudget = {
  maxSteps: 4,
  maxStepVisits: 2,
  maxFixRounds: 2,
  maxReviewRounds: 2,
  maxNoProgressRounds: 2,
  maxParallelWorkers: 2,
  maxModelEscalations: 1,
  maxConsecutiveFailures: 2,
  maxWallTimeMs: 1_000,
};

function ledger(overrides: Partial<ExecutionBudget> = {}): BudgetLedger {
  return new BudgetLedger("task-root", { ...budget, ...overrides }, 0);
}

describe("step counting", () => {
  it("counts only agent runs, verification groups, review groups and manager replans", () => {
    for (const kind of COUNTED_STEP_KINDS) {
      expect(stepCost(kind)).toBe(1);
    }
    for (const kind of UNCOUNTED_STEP_KINDS) {
      expect(stepCost(kind)).toBe(0);
    }
  });

  it("does not consume budget for human waits, timers or projections", () => {
    const l = ledger();
    for (const kind of UNCOUNTED_STEP_KINDS) {
      expect(l.recordStep({ taskId: "task-root", stepKey: `k-${kind}`, kind }).status).toBe("ok");
    }
    expect(l.stepsUsed).toBe(0);
  });
});

describe("root budget", () => {
  it("cannot be bypassed by splitting work into child tasks", () => {
    const l = ledger();
    const childA = l.forChild("task-child-a");
    const childB = l.forChild("task-child-b");

    expect(l.recordStep({ taskId: "task-root", stepKey: "plan", kind: "manager-replan" }).status)
      .toBe("ok");
    expect(childA.recordStep("impl", "agent-run").status).toBe("ok");
    expect(childB.recordStep("impl", "agent-run").status).toBe("ok");
    expect(childB.recordStep("verify", "verification-group").status).toBe("ok");
    expect(l.stepsUsed).toBe(4);

    const overflow = childA.recordStep("more", "agent-run");
    expect(overflow.status).toBe("needs_attention");
    if (overflow.status === "needs_attention") {
      expect(overflow.violation.limit).toBe("max_steps");
    }
    expect(l.stepsUsed).toBe(4);
  });

  it("shares fix and review round counters with children", () => {
    const l = ledger();
    const child = l.forChild("task-child");
    expect(l.recordFixRound().status).toBe("ok");
    expect(child.recordFixRound().status).toBe("ok");
    expect(child.recordFixRound().status).toBe("needs_attention");
  });

  it("raises needs_attention rather than failing, with the section 8 choice set", () => {
    const l = ledger({ maxSteps: 1 });
    l.recordStep({ taskId: "task-root", stepKey: "a", kind: "agent-run" });
    const outcome = l.recordStep({ taskId: "task-root", stepKey: "b", kind: "agent-run" });
    expect(outcome.status).toBe("needs_attention");
    if (outcome.status === "needs_attention") {
      expect(outcome.checkpoint.kind).toBe("limit-exceeded");
      expect(outcome.checkpoint.choices.map((choice) => choice.id)).toEqual(
        LIMIT_EXCEEDED_CHOICES.map((choice) => choice.id),
      );
    }
  });
});

describe("loop guards", () => {
  it("limits visits to the same step", () => {
    const l = ledger({ maxSteps: 100 });
    const event = { taskId: "task-root", stepKey: "verify", kind: "verification-group" } as const;
    expect(l.recordStep(event).status).toBe("ok");
    expect(l.recordStep(event).status).toBe("ok");
    const third = l.recordStep(event);
    expect(third.status).toBe("needs_attention");
    if (third.status === "needs_attention") {
      expect(third.violation.limit).toBe("max_step_visits");
    }
  });

  it("scopes visit counts per task so distinct steps do not collide", () => {
    const l = ledger({ maxSteps: 100 });
    expect(l.recordStep({ taskId: "task-a", stepKey: "verify", kind: "review-group" }).status).toBe(
      "ok",
    );
    expect(l.recordStep({ taskId: "task-b", stepKey: "verify", kind: "review-group" }).status).toBe(
      "ok",
    );
  });

  it("limits review rounds", () => {
    const l = ledger();
    expect(l.recordReviewRound().status).toBe("ok");
    expect(l.recordReviewRound().status).toBe("ok");
    const third = l.recordReviewRound();
    expect(third.status).toBe("needs_attention");
    if (third.status === "needs_attention") {
      expect(third.violation.limit).toBe("max_review_rounds");
    }
  });

  it("limits consecutive failures and resets on success", () => {
    const l = ledger();
    expect(l.recordFailure().status).toBe("ok");
    l.recordSuccess();
    expect(l.recordFailure().status).toBe("ok");
    expect(l.recordFailure().status).toBe("needs_attention");
  });

  it("enforces wall time and parallel workers", () => {
    const l = ledger();
    expect(l.checkWallTime(999).status).toBe("ok");
    expect(l.checkWallTime(1_001).status).toBe("needs_attention");
    expect(l.checkParallelWorkers(2).status).toBe("ok");
    expect(l.checkParallelWorkers(3).status).toBe("needs_attention");
  });
});

describe("no-progress detection", () => {
  const inputs: ProgressInputs = {
    gitDiffHash: "diff-1",
    verificationFailureSignature: "tests:2-failed",
    reviewFindingIds: ["F1", "F2"],
    artifactHashes: ["a1"],
    managerDecisionClass: "fix",
  };

  it("needs attention after the threshold number of identical consecutive rounds", () => {
    const l = ledger();
    expect(l.recordProgress(inputs).status).toBe("ok");
    expect(l.recordProgress(inputs).status).toBe("ok");
    const third = l.recordProgress(inputs);
    expect(third.status).toBe("needs_attention");
    if (third.status === "needs_attention") {
      expect(third.violation.limit).toBe("max_no_progress_rounds");
    }
  });

  it("resets when any fingerprint input changes", () => {
    const l = ledger();
    l.recordProgress(inputs);
    l.recordProgress(inputs);
    expect(l.recordProgress({ ...inputs, gitDiffHash: "diff-2" }).status).toBe("ok");
    expect(l.recordProgress({ ...inputs, gitDiffHash: "diff-2" }).status).toBe("ok");
    expect(
      l.recordProgress({ ...inputs, gitDiffHash: "diff-2", managerDecisionClass: "complete" })
        .status,
    ).toBe("ok");
  });
});

describe("model escalation", () => {
  it("escalates economy -> standard -> high within the cap", () => {
    const l = ledger({ maxModelEscalations: 2 });
    expect(l.escalateModel("economy")).toMatchObject({
      status: "escalated",
      from: "economy",
      to: "standard",
    });
    expect(l.escalateModel("standard")).toMatchObject({ status: "escalated", to: "high" });
  });

  it("needs attention once the escalation cap is reached", () => {
    const l = ledger({ maxModelEscalations: 1 });
    expect(l.escalateModel("economy").status).toBe("escalated");
    const capped = l.escalateModel("standard");
    expect(capped.status).toBe("needs_attention");
    if (capped.status === "needs_attention") {
      expect(capped.violation.limit).toBe("max_model_escalations");
    }
  });

  it("needs attention when already at the highest profile", () => {
    const l = ledger({ maxModelEscalations: 3 });
    const outcome = l.escalateModel("high");
    expect(outcome.status).toBe("needs_attention");
    if (outcome.status === "needs_attention") {
      expect(outcome.violation.detail).toContain("highest");
    }
  });
});

describe("budget extension", () => {
  it("extends exactly once and refuses a second extension", () => {
    const l = ledger({ maxSteps: 2 });
    l.recordStep({ taskId: "task-root", stepKey: "a", kind: "agent-run" });
    l.recordStep({ taskId: "task-root", stepKey: "b", kind: "agent-run" });
    expect(l.recordStep({ taskId: "task-root", stepKey: "c", kind: "agent-run" }).status).toBe(
      "needs_attention",
    );

    // One more budget's worth of steps, from policy — never a caller's number.
    expect(l.extendOnce()).toEqual({ ok: true, maxSteps: 4 });
    expect(l.recordStep({ taskId: "task-root", stepKey: "c", kind: "agent-run" }).status).toBe(
      "ok",
    );

    expect(l.extendOnce()).toEqual({ ok: false, reason: "already-extended" });
    expect(l.maxSteps).toBe(4);
  });

  it("drops the extend choice from the checkpoint after the extension is used", () => {
    const l = ledger({ maxSteps: 1 });
    l.recordStep({ taskId: "task-root", stepKey: "a", kind: "agent-run" });
    l.extendOnce();
    l.recordStep({ taskId: "task-root", stepKey: "b", kind: "agent-run" });
    const outcome = l.recordStep({ taskId: "task-root", stepKey: "c", kind: "agent-run" });
    expect(outcome.status).toBe("needs_attention");
    if (outcome.status === "needs_attention") {
      expect(outcome.checkpoint.choices.map((choice) => choice.id)).not.toContain("extend-once");
    }
  });
});

describe("state round-trip", () => {
  it("restores counters so a resumed workflow keeps the same budget", () => {
    const l = ledger();
    l.recordStep({ taskId: "task-root", stepKey: "a", kind: "agent-run" });
    l.recordFixRound();
    const restored = BudgetLedger.restore(budget, l.snapshot());
    expect(restored.stepsUsed).toBe(1);
    expect(restored.recordFixRound().status).toBe("ok");
    expect(restored.recordFixRound().status).toBe("needs_attention");
  });
});
