import { describe, expect, it } from "vitest";
import { PIPELINES, PIPELINE_END, type PipelineDefinition } from "@meidoya/task-engine";

import {
  TASK_WORKFLOW_STEP_KINDS,
  pipelinesTaskWorkflowCannotRun,
  reviewApprovalGatesOnNonTerminalSteps,
  stepsTaskWorkflowCannotRun,
  stepsWhoseExecutorMisstatesDispatch,
  verifyStepsOutsideRequiredVerification,
} from "./pipelines-guard.js";

/**
 * `TaskWorkflow` leans on two properties of the shipped pipelines. Each is
 * checked twice here: against a synthetic pipeline that breaks it (so the
 * predicate itself has a failing case and is not vacuously true), and against
 * the pipelines actually shipped.
 */

function pipeline(steps: PipelineDefinition["steps"]): PipelineDefinition {
  return { name: "coding", entry: Object.keys(steps)[0] ?? "", steps };
}

describe("review-approval gates", () => {
  it("flags one declared on a non-terminal step", () => {
    const broken = pipeline({
      review: {
        key: "review",
        kind: "review",
        status: "reviewing",
        executor: "worker",
        gate: "review-approval",
        required: true,
        next: { success: "deliver" },
      },
      deliver: {
        key: "deliver",
        kind: "deliver",
        status: "reviewing",
        executor: "control",
        required: true,
        next: { success: PIPELINE_END },
      },
    });

    expect(reviewApprovalGatesOnNonTerminalSteps({ broken })).toEqual([
      expect.objectContaining({ pipeline: "broken", stepKey: "review" }),
    ]);
  });

  /**
   * The shape the old predicate could not see, and the one that actually
   * happens: `applyManagerDecision` raises a `review-approval` gate from the
   * BODY of a review step whenever the review gate policy says to ask, whatever
   * the step declares. A `review` step that declares no gate at all therefore
   * still sets `reviewGateSatisfied` — and while `step.gate` was the predicate,
   * a non-terminal one passed this file in silence.
   */
  it("flags a non-terminal review step that declares no gate at all", () => {
    const broken = pipeline({
      review: {
        key: "review",
        kind: "review",
        status: "reviewing",
        executor: "manager",
        required: true,
        next: { success: "deliver" },
      },
      deliver: {
        key: "deliver",
        kind: "deliver",
        status: "reviewing",
        executor: "control",
        required: true,
        next: { success: PIPELINE_END },
      },
    });

    expect(reviewApprovalGatesOnNonTerminalSteps({ broken })).toEqual([
      expect.objectContaining({ pipeline: "broken", stepKey: "review" }),
    ]);
  });

  it("accepts a terminal review step", () => {
    const fine = pipeline({
      review: {
        key: "review",
        kind: "review",
        status: "reviewing",
        executor: "manager",
        required: true,
        next: { success: PIPELINE_END, failure: "review" },
      },
    });

    expect(reviewApprovalGatesOnNonTerminalSteps({ fine })).toEqual([]);
  });

  /**
   * The property that let the review answer's scoping mechanism be deleted: an
   * approval is always the last thing before completion, so the single
   * `reviewGateSatisfied` flag cannot be a stale answer. Break this and the
   * scoping has to come back — behind a patch id, because the completion gate
   * would start asking where it used to stay silent.
   */
  it("can only be raised by terminal steps in the shipped pipelines", () => {
    expect(reviewApprovalGatesOnNonTerminalSteps(PIPELINES)).toEqual([]);
  });
});

describe("verify steps", () => {
  it("flags one in a pipeline that does not require verification", () => {
    const research = pipeline({
      verify: {
        key: "verify",
        kind: "verify",
        status: "verifying",
        executor: "commands",
        required: true,
        next: { success: PIPELINE_END },
      },
    });

    expect(verifyStepsOutsideRequiredVerification({ research }, ["coding"])).toEqual([
      expect.objectContaining({ pipeline: "research", stepKey: "verify" }),
    ]);
  });

  /**
   * `runTaskWorkflow` passes `requireVerification: machine.pipeline === "coding"`
   * to plan validation, so `coding` is the one pipeline whose plans must carry
   * commands. Any other pipeline that gains a verify step would reach the
   * workflow's fail-closed floor (`isVacuousVerification`) and halt.
   */
  it("appear only in the pipeline whose plans must carry commands", () => {
    expect(verifyStepsOutsideRequiredVerification(PIPELINES, ["coding"])).toEqual([]);
  });
});

describe("step kinds TaskWorkflow implements", () => {
  it("flags a step whose kind the workflow has no case for", () => {
    const coordination = pipeline({
      delegate: {
        key: "delegate",
        kind: "delegate",
        status: "running",
        executor: "control",
        required: true,
        next: { success: PIPELINE_END },
      },
    });

    expect(stepsTaskWorkflowCannotRun({ coordination })).toEqual([
      expect.objectContaining({ pipeline: "coordination", stepKey: "delegate" }),
    ]);
  });

  /**
   * The three coordination kinds are the whole `cross-workspace` body, and
   * `CrossWorkspaceWorkflow` — not `TaskWorkflow` — implements them. Before the
   * workflow's dispatch switch named its kinds, they fell into a `default:` that
   * sent each of them to an execution node as an `implementer` Worker run.
   *
   * If this list changes, `runTaskWorkflow` must gain the kind or keep refusing
   * the pipeline; it may never fall through to a Worker again.
   */
  it("rules out exactly the cross-workspace pipeline", () => {
    expect(pipelinesTaskWorkflowCannotRun(PIPELINES)).toEqual(["cross-workspace"]);
    const kinds = [...new Set(stepsTaskWorkflowCannotRun(PIPELINES).map((v) => v.stepKey))].sort();
    expect(kinds).toEqual(["aggregate", "await-children", "delegate"]);
  });

  it("covers every step of every pipeline the workflow does run", () => {
    for (const [name, definition] of Object.entries(PIPELINES)) {
      if (pipelinesTaskWorkflowCannotRun(PIPELINES).includes(name)) continue;
      for (const step of Object.values(definition.steps)) {
        expect(TASK_WORKFLOW_STEP_KINDS, `${name}/${step.key}`).toContain(step.kind);
      }
    }
  });
});

describe("the executor field", () => {
  it("flags a step whose declared executor is not who runs it", () => {
    const lying = pipeline({
      implement: {
        key: "implement",
        kind: "implement",
        status: "running",
        // The workflow dispatches an `implement` step to the node as a Worker
        // run whatever this says.
        executor: "control",
        required: true,
        next: { success: PIPELINE_END },
      },
    });

    expect(stepsWhoseExecutorMisstatesDispatch({ lying })).toEqual([
      expect.objectContaining({ pipeline: "lying", stepKey: "implement" }),
    ]);
  });

  /**
   * `executor` was read by NOTHING, and it had drifted: `review` steps declared
   * `worker` while the workflow runs them through `manager.runReview`, and
   * `clarify` declared `manager` while nothing runs at all. A field describing
   * who executes a step, disagreeing with who executes it, is one refactor away
   * from being a routing bug — this is what makes it load-bearing.
   */
  it("agrees with the workflow's dispatch for every shipped pipeline", () => {
    expect(stepsWhoseExecutorMisstatesDispatch(PIPELINES)).toEqual([]);
  });
});
