import { describe, expect, it } from "vitest";
import type { PipelineName } from "@meidoya/domain";

import {
  PIPELINES,
  PIPELINE_END,
  advancePipeline,
  getPipeline,
  requiredStepKeys,
} from "./pipelines.js";
import { canTransition, createTaskMachineState } from "./state-machine.js";

const names: PipelineName[] = ["quick", "research", "coding", "scheduled", "cross-workspace"];

describe("fixed pipelines", () => {
  it.each(names)("%s has a reachable, well-formed graph", (name) => {
    const pipeline = getPipeline(name);
    expect(pipeline.steps[pipeline.entry]).toBeDefined();

    const reachable = new Set<string>([pipeline.entry]);
    const queue = [pipeline.entry];
    while (queue.length > 0) {
      const key = queue.shift();
      if (key === undefined) break;
      const step = pipeline.steps[key];
      expect(step, `${name}.${key}`).toBeDefined();
      if (!step) continue;
      for (const target of Object.values(step.next)) {
        if (target === PIPELINE_END) continue;
        expect(pipeline.steps[target], `${name}.${key} -> ${target}`).toBeDefined();
        if (!reachable.has(target)) {
          reachable.add(target);
          queue.push(target);
        }
      }
    }
    expect([...reachable].sort()).toEqual(Object.keys(pipeline.steps).sort());
  });

  it("each step status is a legal durable-lane status for that step", () => {
    const base = createTaskMachineState({
      taskId: "t",
      pipeline: "coding",
      lane: "durable",
      now: 0,
    });
    for (const pipeline of Object.values(PIPELINES)) {
      for (const step of Object.values(pipeline.steps)) {
        // every step status must be enterable from at least one state
        const enterable = (
          ["received", "planning", "running", "verifying", "reviewing", "needs_attention"] as const
        ).some((s) =>
          canTransition({ ...base, status: s }, step.status).ok,
        );
        expect(enterable, `${pipeline.name}.${step.key} -> ${step.status}`).toBe(true);
      }
    }
  });

  it("research runs clarify -> plan -> research -> synthesize -> review -> complete", () => {
    const p = getPipeline("research");
    const order = ["clarify", "plan", "research", "synthesize", "review"];
    for (let i = 0; i < order.length - 1; i += 1) {
      const from = order[i] as string;
      const to = order[i + 1] as string;
      expect(advancePipeline(p, from, "success")).toEqual({ kind: "step", step: p.steps[to] });
    }
    expect(advancePipeline(p, "review", "success")).toEqual({ kind: "complete" });
  });

  it("coding matches the diagram in 02 section 6", () => {
    const p = getPipeline("coding");
    expect(advancePipeline(p, "clarify", "success")).toMatchObject({ step: { key: "plan" } });
    expect(p.steps["plan"]?.gate).toBe("plan-approval");
    expect(advancePipeline(p, "plan", "success")).toMatchObject({ step: { key: "implement" } });
    expect(advancePipeline(p, "implement", "success")).toMatchObject({ step: { key: "verify" } });
    // verify: pass -> review, fail -> fix
    expect(advancePipeline(p, "verify", "success")).toMatchObject({ step: { key: "review" } });
    expect(advancePipeline(p, "verify", "failure")).toMatchObject({ step: { key: "fix" } });
    // review: approved -> complete, findings -> fix
    expect(advancePipeline(p, "review", "success")).toEqual({ kind: "complete" });
    expect(advancePipeline(p, "review", "findings")).toMatchObject({ step: { key: "fix" } });
    // fix -> verify -> review closes the loop
    expect(advancePipeline(p, "fix", "success")).toMatchObject({ step: { key: "verify" } });
    expect(p.completionGate).toBe("review-approval");
  });

  it("scheduled runs assess -> execute -> compare -> deliver and can stop on no-change", () => {
    const p = getPipeline("scheduled");
    expect(advancePipeline(p, "assess", "success")).toMatchObject({ step: { key: "execute" } });
    expect(advancePipeline(p, "execute", "success")).toMatchObject({ step: { key: "compare" } });
    expect(advancePipeline(p, "compare", "success")).toMatchObject({ step: { key: "deliver" } });
    expect(advancePipeline(p, "compare", "no-change")).toEqual({ kind: "complete" });
    expect(advancePipeline(p, "deliver", "success")).toEqual({ kind: "complete" });
  });

  it("cross-workspace runs plan -> delegate -> await-children -> aggregate -> complete", () => {
    const p = getPipeline("cross-workspace");
    expect(advancePipeline(p, "plan", "success")).toMatchObject({ step: { key: "delegate" } });
    expect(advancePipeline(p, "delegate", "success")).toMatchObject({
      step: { key: "await-children" },
    });
    expect(advancePipeline(p, "await-children", "success")).toMatchObject({
      step: { key: "aggregate" },
    });
    expect(advancePipeline(p, "aggregate", "success")).toEqual({ kind: "complete" });
  });

  it("quick delegates to exactly one worker step", () => {
    const p = getPipeline("quick");
    const workerSteps = Object.values(p.steps).filter((s) => s.executor === "worker");
    expect(workerSteps).toHaveLength(1);
    expect(advancePipeline(p, "work", "success")).toEqual({ kind: "complete" });
  });

  it("reports missing edges and unknown steps instead of guessing", () => {
    const p = getPipeline("coding");
    expect(advancePipeline(p, "implement", "no-change")).toMatchObject({ kind: "stuck" });
    expect(advancePipeline(p, "nope", "success")).toMatchObject({ kind: "stuck" });
  });

  it("marks the steps completion depends on", () => {
    expect(requiredStepKeys(getPipeline("coding")).sort()).toEqual([
      "implement",
      "plan",
      "review",
      "verify",
    ]);
  });
});
