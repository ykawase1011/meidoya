import { describe, expect, it } from "vitest";
import type { MaidDecision, TaskBrief } from "@meidoya/domain";

import { handleMaidDecision, type IntakeContext } from "./intake.js";
import { enterGate, gateResumeStatus, resolveGate } from "./gates.js";
import { createTaskMachineState, transition } from "./state-machine.js";

const brief: TaskBrief = { summary: "fix build", projects: ["p1"], origin: "chat" };
const ctx: IntakeContext = { workspaceKind: "execution", defaultPipeline: "coding" };

describe("maid request intake", () => {
  it("maps every decision type to a control-plane outcome", () => {
    const cases: [MaidDecision, string][] = [
      [{ type: "administrative", command: { kind: "task.list" } }, "administrative"],
      [{ type: "respond", reply: { summary: "こんにちは。" } }, "respond"],
      [{ type: "quick", brief }, "start-task"],
      [{ type: "durable", brief }, "start-task"],
      [{ type: "answer_question", taskId: "t1", questionId: "q1", answer: "yes" }, "answer-checkpoint"],
      [{ type: "ask_user", question: "which repo?" }, "ask-user"],
      [{ type: "out_of_scope", reason: "other workspace" }, "rejected"],
    ];
    for (const [decision, kind] of cases) {
      expect(handleMaidDecision(decision, ctx).kind).toBe(kind);
    }
  });

  it("puts quick decisions on the quick lane and the quick pipeline", () => {
    expect(handleMaidDecision({ type: "quick", brief }, ctx)).toMatchObject({
      lane: "quick",
      pipeline: "quick",
    });
  });

  it("selects the pipeline for durable requests without asking the LLM", () => {
    expect(handleMaidDecision({ type: "durable", brief }, ctx)).toMatchObject({
      lane: "durable",
      pipeline: "coding",
    });
    expect(
      handleMaidDecision(
        { type: "durable", brief: { ...brief, origin: "schedule" } },
        ctx,
      ),
    ).toMatchObject({ pipeline: "scheduled" });
    expect(
      handleMaidDecision({ type: "durable", brief }, { ...ctx, workspaceKind: "coordination" }),
    ).toMatchObject({ pipeline: "cross-workspace" });
    expect(
      handleMaidDecision({ type: "durable", brief }, { ...ctx, pipelineHint: "research" }),
    ).toMatchObject({ pipeline: "research" });
  });
});

describe("human gates", () => {
  const base = createTaskMachineState({
    taskId: "t1",
    pipeline: "coding",
    lane: "durable",
    now: 0,
  });

  it("waits in the matching status and resumes where policy says", () => {
    const planning = transition(base, { to: "planning" }, 1);
    expect(planning.ok).toBe(true);
    if (!planning.ok) return;

    const gated = enterGate(planning.state, "plan-approval", 2);
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    expect(gated.state.status).toBe("waiting_plan_approval");

    const approved = resolveGate(gated.state, "plan-approval", "approved", 3);
    expect(approved.ok && approved.state.status).toBe("running");

    const rejected = resolveGate(gated.state, "plan-approval", "rejected", 3);
    expect(rejected.ok && rejected.state.status).toBe("planning");
  });

  it("returns a side-effect approval to the step that requested it", () => {
    const running = transition(base, { to: "planning" }, 1);
    if (!running.ok) return;
    const step = transition(running.state, { to: "running" }, 2);
    if (!step.ok) return;

    const gated = enterGate(step.state, "side-effect-approval", 3);
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    expect(gated.state.resumeStatus).toBe("running");
    expect(resolveGate(gated.state, "side-effect-approval", "approved", 4)).toMatchObject({
      ok: true,
      to: "running",
    });
    expect(resolveGate(gated.state, "side-effect-approval", "rejected", 4)).toMatchObject({
      ok: true,
      to: "needs_attention",
    });
  });

  it("sends a rejected limit-exceeded checkpoint to cancelled", () => {
    expect(gateResumeStatus("limit-exceeded", "rejected", "running")).toBe("cancelled");
    expect(gateResumeStatus("clarification", "answered", "running")).toBe("planning");
  });
});
