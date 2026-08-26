import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@meidoya/domain";

import {
  ALL_TASK_STATUSES,
  INTERRUPT_STATUSES,
  IllegalTransitionError,
  TERMINAL_STATUSES,
  canTransition,
  createTaskMachineState,
  isTerminal,
  transition,
  transitionOrThrow,
  type TaskMachineState,
} from "./state-machine.js";

function state(overrides: Partial<TaskMachineState> = {}): TaskMachineState {
  return {
    ...createTaskMachineState({ taskId: "t1", pipeline: "coding", lane: "durable", now: 0 }),
    ...overrides,
  };
}

const LEGAL_FLOW: [TaskStatus, TaskStatus][] = [
  ["received", "planning"],
  ["planning", "waiting_clarification"],
  ["planning", "waiting_plan_approval"],
  ["planning", "running"],
  ["waiting_clarification", "planning"],
  ["waiting_plan_approval", "running"],
  ["waiting_plan_approval", "planning"],
  ["running", "verifying"],
  ["running", "reviewing"],
  ["verifying", "reviewing"],
  ["verifying", "running"],
  ["reviewing", "running"],
  ["reviewing", "waiting_review_approval"],
  ["reviewing", "completed"],
  ["waiting_review_approval", "completed"],
  ["waiting_review_approval", "running"],
  ["needs_attention", "planning"],
  ["needs_attention", "running"],
  ["needs_attention", "verifying"],
  ["needs_attention", "reviewing"],
  ["needs_attention", "completed"],
];

describe("durable lane state machine", () => {
  it.each(LEGAL_FLOW)("allows %s -> %s", (from, to) => {
    const result = transition(state({ status: from }), { to }, 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.status).toBe(to);
      expect(result.state.version).toBe(1);
      expect(result.state.updatedAt).toBe(10);
    }
  });

  it("allows every interrupt target from every non-terminal state", () => {
    for (const from of ALL_TASK_STATUSES) {
      if (isTerminal(from)) continue;
      for (const to of INTERRUPT_STATUSES) {
        const result = transition(state({ status: from, lane: "durable" }), { to }, 1);
        expect(result.ok, `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it("rejects every transition out of a terminal state", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of ALL_TASK_STATUSES) {
        const result = transition(state({ status: from }), { to }, 1);
        expect(result.ok, `${from} -> ${to}`).toBe(false);
        if (!result.ok) expect(result.code).toBe("terminal-state");
      }
    }
  });

  it("rejects transitions that are not in the flow graph", () => {
    const illegal: [TaskStatus, TaskStatus][] = [
      ["received", "running"],
      ["received", "completed"],
      ["planning", "verifying"],
      ["planning", "completed"],
      ["running", "completed"],
      ["running", "planning"],
      ["verifying", "completed"],
      ["waiting_clarification", "running"],
      ["waiting_review_approval", "verifying"],
    ];
    for (const [from, to] of illegal) {
      const result = transition(state({ status: from }), { to }, 1);
      expect(result.ok, `${from} -> ${to}`).toBe(false);
      if (!result.ok) expect(result.code).toBe("not-in-flow");
    }
  });

  it("does not silently ignore an illegal transition", () => {
    const before = state({ status: "received" });
    const result = transition(before, { to: "completed" }, 5);
    expect(result.ok).toBe(false);
    expect(before.status).toBe("received");
    expect(() => transitionOrThrow(before, { to: "completed" }, 5)).toThrow(
      IllegalTransitionError,
    );
  });

  it("records and enforces the resume status of a dynamic wait", () => {
    const running = state({ status: "running" });
    const waiting = transition(running, { to: "waiting_user_input" }, 2);
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    expect(waiting.state.resumeStatus).toBe("running");

    const wrong = transition(waiting.state, { to: "reviewing" }, 3);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe("resume-mismatch");

    const resumed = transition(waiting.state, { to: "running" }, 3);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.state.resumeStatus).toBeUndefined();
  });

  it("uses an explicit resume status for side-effect approval", () => {
    const verifying = state({ status: "verifying" });
    const waiting = transition(
      verifying,
      { to: "waiting_side_effect_approval", resumeStatus: "running" },
      4,
    );
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    expect(transition(waiting.state, { to: "running" }, 5).ok).toBe(true);
    expect(transition(waiting.state, { to: "verifying" }, 5).ok).toBe(false);
  });

  it("rejects a dynamic wait whose resume status is terminal", () => {
    const result = transition(
      state({ status: "running" }),
      { to: "waiting_user_input", resumeStatus: "completed" },
      1,
    );
    expect(result.ok).toBe(false);
  });

  it("forbids approval gates on the quick lane", () => {
    const quick = state({ status: "planning", lane: "quick", pipeline: "quick" });
    const plan = canTransition(quick, "waiting_plan_approval");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("quick-lane-forbidden");
    expect(canTransition(quick, "waiting_clarification").ok).toBe(true);
  });

  it("tracks the current step key when supplied", () => {
    const result = transition(state({ status: "planning" }), { to: "running", stepKey: "implement" }, 1);
    expect(result.ok && result.state.currentStepKey).toBe("implement");
  });
});
