import { describe, expect, it } from "vitest";

import { gateWaitStatus } from "./gates.js";
import {
  isQuickSoftDeadlineExceeded,
  promoteQuickToDurable,
  quickLaneWaivesGate,
  type QuickLaneConfig,
} from "./quick-lane.js";
import { createTaskMachineState, transition } from "./state-machine.js";

const config: QuickLaneConfig = { softDeadlineMs: 120_000, promoteTo: "coding" };

function quickTask() {
  const created = createTaskMachineState({
    taskId: "task-quick-1",
    pipeline: "quick",
    lane: "quick",
    now: 1_000,
  });
  const planning = transition(created, { to: "planning" }, 1_100);
  if (!planning.ok) throw new Error("setup");
  const running = transition(planning.state, { to: "running", stepKey: "work" }, 1_200);
  if (!running.ok) throw new Error("setup");
  return running.state;
}

describe("quick lane", () => {
  it("detects the soft deadline", () => {
    const task = quickTask();
    expect(isQuickSoftDeadlineExceeded(task, config, 1_000 + 119_999)).toBe(false);
    expect(isQuickSoftDeadlineExceeded(task, config, 1_000 + 120_000)).toBe(true);
  });

  it("promotes to durable keeping the same task id and posting no progress message", () => {
    const task = quickTask();
    const result = promoteQuickToDurable(task, { now: 130_000, pipeline: config.promoteTo });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.state.taskId).toBe(task.taskId);
    expect(result.promotion.taskId).toBe(task.taskId);
    expect(result.state.lane).toBe("durable");
    expect(result.state.pipeline).toBe("coding");
    expect(result.state.status).toBe(task.status);
    expect(result.state.currentStepKey).toBe(task.currentStepKey);
    expect(result.state.startedAt).toBe(task.startedAt);
    expect(result.promotion.emitProgressMessage).toBe(false);
  });

  it("unlocks the approval gates the quick lane forbade", () => {
    const promoted = promoteQuickToDurable(quickTask(), { now: 130_000, pipeline: "coding" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    const reviewing = transition(promoted.state, { to: "reviewing" }, 131_000);
    expect(reviewing.ok).toBe(true);
    if (!reviewing.ok) return;
    expect(transition(reviewing.state, { to: "waiting_review_approval" }, 132_000).ok).toBe(true);
  });

  it("refuses to promote a durable or terminal task", () => {
    const durable = createTaskMachineState({
      taskId: "t",
      pipeline: "coding",
      lane: "durable",
      now: 0,
    });
    expect(promoteQuickToDurable(durable, { now: 1, pipeline: "coding" })).toEqual({
      ok: false,
      reason: "not-quick-lane",
    });

    const cancelled = transition(quickTask(), { to: "cancelled" }, 5_000);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(promoteQuickToDurable(cancelled.state, { now: 6_000, pipeline: "coding" })).toEqual({
      ok: false,
      reason: "terminal-state",
    });
    expect(isQuickSoftDeadlineExceeded(cancelled.state, config, 999_999)).toBe(false);
  });
});

/**
 * The quick lane's gate carve-out.
 *
 * `TaskWorkflow` returns "granted" without asking anyone for the gates the
 * quick lane skips, so the SET matters more than any single member: widen it to
 * `side-effect-approval` and a quick task hands a Worker `network` + `shell`
 * with nobody asked. Nothing pinned that set while the condition lived inline in
 * the workflow.
 */
describe("quickLaneWaivesGate", () => {
  it("waives exactly the plan and completion approvals", () => {
    const waived = (
      [
        "clarification",
        "plan-approval",
        "review-approval",
        "side-effect-approval",
        "limit-exceeded",
      ] as const
    ).filter((kind) => quickLaneWaivesGate(kind));
    expect(waived).toEqual(["plan-approval", "review-approval"]);
  });

  it("never waives the side-effect gate", () => {
    // The one gate between a Worker and an effect outside the workspace. "The
    // quick lane has nowhere to park it" is not a reason to skip it.
    expect(quickLaneWaivesGate("side-effect-approval")).toBe(false);
  });

  /**
   * Waiving and parking are the same rule seen from two sides: a gate the lane
   * skips must be one the state machine would refuse to park in, and vice
   * versa. They are derived from one constant so they cannot drift apart.
   */
  it("agrees with the wait states the state machine forbids a quick task", () => {
    // From `planning`, where every gate below is otherwise flow-legal, so the
    // only thing that can refuse a park is the lane rule itself.
    const planning = transition(
      createTaskMachineState({ taskId: "q", pipeline: "quick", lane: "quick", now: 1_000 }),
      { to: "planning" },
      1_100,
    );
    if (!planning.ok) throw new Error("setup");
    for (const kind of [
      "clarification",
      "plan-approval",
      "review-approval",
      "side-effect-approval",
    ] as const) {
      const parked = transition(
        planning.state,
        { to: gateWaitStatus(kind), resumeStatus: "planning" },
        2_000,
      );
      expect(parked.ok, `${kind}`).toBe(!quickLaneWaivesGate(kind));
    }
  });
});
