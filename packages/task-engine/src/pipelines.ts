import type { HumanCheckpointKind, PipelineName, TaskStatus, WorkerProfile } from "@meidoya/domain";

/**
 * 02 section 5: the MVP ships fixed pipelines as code. Only gates, limits,
 * quality gates and model policy are configurable; step transitions are not.
 */

export const PIPELINE_END = "__complete__" as const;
export type PipelineEnd = typeof PIPELINE_END;

export type PipelineStepKind =
  | "clarify"
  | "plan"
  | "work"
  | "research"
  | "synthesize"
  | "implement"
  | "verify"
  | "review"
  | "fix"
  | "assess"
  | "execute"
  | "compare"
  | "deliver"
  | "delegate"
  | "await-children"
  | "aggregate";

export type PipelineOutcome = "success" | "failure" | "findings" | "no-change";

export type PipelineStep = {
  key: string;
  kind: PipelineStepKind;
  /** Durable-lane status the task occupies while this step runs. */
  status: TaskStatus;
  /**
   * Who runs the step: a Manager agent, a Worker agent, a command group, or the
   * control plane alone.
   *
   * Not decorative. `TASK_WORKFLOW_DISPATCH` in
   * `@meidoya/workflows-temporal` records who the workflow ACTUALLY dispatches
   * a step of each kind to, and `pipelines-guard.test.ts` fails when the two
   * disagree — because for a while they did: nothing read this field, the
   * workflow's switch fell through to a Worker run for every kind it did not
   * name, and three `control`/`manager` steps were dispatched to an execution
   * node as `implementer` Worker runs.
   */
  executor: "manager" | "worker" | "commands" | "control";
  workerProfile?: WorkerProfile;
  /** Gate evaluated before entering the step. */
  gate?: HumanCheckpointKind;
  /** Steps that must be terminal for the task to complete. */
  required: boolean;
  next: Partial<Record<PipelineOutcome, string | PipelineEnd>>;
};

export type PipelineDefinition = {
  name: PipelineName;
  entry: string;
  /** Gate evaluated after the last step, before completion. */
  completionGate?: HumanCheckpointKind;
  steps: Record<string, PipelineStep>;
};

function def(d: PipelineDefinition): PipelineDefinition {
  return d;
}

/** Maid → inline Task → Manager → one Worker → result (05 section 2). */
const QUICK: PipelineDefinition = def({
  name: "quick",
  entry: "clarify",
  steps: {
    clarify: {
      key: "clarify",
      kind: "clarify",
      status: "planning",
      // Nothing runs: a clarify step IS its pre-step clarification gate, asked
      // by the control plane and answered by a human (see TASK_WORKFLOW_DISPATCH).
      executor: "control",
      gate: "clarification",
      required: false,
      next: { success: "work", failure: PIPELINE_END },
    },
    work: {
      key: "work",
      kind: "work",
      status: "running",
      executor: "worker",
      workerProfile: "researcher",
      required: true,
      next: { success: PIPELINE_END, failure: PIPELINE_END },
    },
  },
});

/** clarify → plan → research → synthesize → review → complete. */
const RESEARCH: PipelineDefinition = def({
  name: "research",
  entry: "clarify",
  steps: {
    clarify: {
      key: "clarify",
      kind: "clarify",
      status: "planning",
      // Nothing runs: a clarify step IS its pre-step clarification gate, asked
      // by the control plane and answered by a human (see TASK_WORKFLOW_DISPATCH).
      executor: "control",
      gate: "clarification",
      required: false,
      next: { success: "plan" },
    },
    plan: {
      key: "plan",
      kind: "plan",
      status: "planning",
      executor: "manager",
      gate: "plan-approval",
      required: true,
      next: { success: "research", failure: "plan" },
    },
    research: {
      key: "research",
      kind: "research",
      status: "running",
      executor: "worker",
      workerProfile: "researcher",
      required: true,
      next: { success: "synthesize", failure: "plan" },
    },
    synthesize: {
      key: "synthesize",
      kind: "synthesize",
      status: "running",
      executor: "worker",
      workerProfile: "researcher",
      required: true,
      next: { success: "review", failure: "research" },
    },
    review: {
      key: "review",
      kind: "review",
      status: "reviewing",
      // The Manager reviews and then decides the next action; no Worker run is
      // dispatched for a review step (see TASK_WORKFLOW_DISPATCH).
      executor: "manager",
      workerProfile: "reviewer",
      gate: "review-approval",
      required: true,
      next: { success: PIPELINE_END, findings: "synthesize", failure: "synthesize" },
    },
  },
});

/** 02 section 6: clarify → plan → implement → verify ⇄ fix → review → complete. */
const CODING: PipelineDefinition = def({
  name: "coding",
  entry: "clarify",
  completionGate: "review-approval",
  steps: {
    clarify: {
      key: "clarify",
      kind: "clarify",
      status: "planning",
      // Nothing runs: a clarify step IS its pre-step clarification gate, asked
      // by the control plane and answered by a human (see TASK_WORKFLOW_DISPATCH).
      executor: "control",
      gate: "clarification",
      required: false,
      next: { success: "plan" },
    },
    plan: {
      key: "plan",
      kind: "plan",
      status: "planning",
      executor: "manager",
      gate: "plan-approval",
      required: true,
      next: { success: "implement", failure: "plan" },
    },
    implement: {
      key: "implement",
      kind: "implement",
      status: "running",
      executor: "worker",
      workerProfile: "implementer",
      required: true,
      next: { success: "verify", failure: "fix" },
    },
    verify: {
      key: "verify",
      kind: "verify",
      status: "verifying",
      executor: "commands",
      required: true,
      next: { success: "review", failure: "fix" },
    },
    review: {
      key: "review",
      kind: "review",
      status: "reviewing",
      // The Manager reviews and then decides the next action; no Worker run is
      // dispatched for a review step (see TASK_WORKFLOW_DISPATCH).
      executor: "manager",
      workerProfile: "reviewer",
      required: true,
      next: { success: PIPELINE_END, findings: "fix", failure: "fix" },
    },
    fix: {
      key: "fix",
      kind: "fix",
      status: "running",
      executor: "worker",
      workerProfile: "implementer",
      required: false,
      next: { success: "verify", failure: "fix" },
    },
  },
});

/** assess → execute → compare previous result → deliver by policy. */
const SCHEDULED: PipelineDefinition = def({
  name: "scheduled",
  entry: "assess",
  steps: {
    assess: {
      key: "assess",
      kind: "assess",
      status: "planning",
      executor: "manager",
      required: true,
      next: { success: "execute", "no-change": PIPELINE_END },
    },
    execute: {
      key: "execute",
      kind: "execute",
      status: "running",
      executor: "worker",
      workerProfile: "researcher",
      required: true,
      next: { success: "compare", failure: "compare" },
    },
    compare: {
      key: "compare",
      kind: "compare",
      status: "verifying",
      executor: "control",
      required: true,
      // delivery.mode = on-change: an unchanged result ends without delivery.
      next: { success: "deliver", "no-change": PIPELINE_END },
    },
    deliver: {
      key: "deliver",
      kind: "deliver",
      status: "reviewing",
      executor: "control",
      gate: "review-approval",
      required: true,
      next: { success: PIPELINE_END },
    },
  },
});

/** Head Maid plan → workspace delegations → wait children → aggregate → complete. */
const CROSS_WORKSPACE: PipelineDefinition = def({
  name: "cross-workspace",
  entry: "plan",
  completionGate: "review-approval",
  steps: {
    plan: {
      key: "plan",
      kind: "plan",
      status: "planning",
      executor: "manager",
      gate: "plan-approval",
      required: true,
      next: { success: "delegate", failure: "plan" },
    },
    delegate: {
      key: "delegate",
      kind: "delegate",
      status: "running",
      executor: "control",
      required: true,
      next: { success: "await-children", failure: "plan" },
    },
    "await-children": {
      key: "await-children",
      kind: "await-children",
      status: "running",
      executor: "control",
      required: true,
      next: { success: "aggregate", failure: "aggregate" },
    },
    aggregate: {
      key: "aggregate",
      kind: "aggregate",
      status: "reviewing",
      executor: "manager",
      required: true,
      next: { success: PIPELINE_END, failure: "aggregate" },
    },
  },
});

export const PIPELINES: Record<PipelineName, PipelineDefinition> = {
  quick: QUICK,
  research: RESEARCH,
  coding: CODING,
  scheduled: SCHEDULED,
  "cross-workspace": CROSS_WORKSPACE,
};

export function getPipeline(name: PipelineName): PipelineDefinition {
  return PIPELINES[name];
}

export function getPipelineStep(
  pipeline: PipelineDefinition,
  key: string,
): PipelineStep | undefined {
  return pipeline.steps[key];
}

export type PipelineAdvance =
  | { kind: "step"; step: PipelineStep }
  | { kind: "complete" }
  | { kind: "stuck"; reason: string };

export function advancePipeline(
  pipeline: PipelineDefinition,
  fromKey: string,
  outcome: PipelineOutcome,
): PipelineAdvance {
  const step = pipeline.steps[fromKey];
  if (!step) return { kind: "stuck", reason: `unknown step ${fromKey} in ${pipeline.name}` };
  const target = step.next[outcome];
  if (target === undefined) {
    return { kind: "stuck", reason: `step ${fromKey} has no ${outcome} edge` };
  }
  if (target === PIPELINE_END) return { kind: "complete" };
  const nextStep = pipeline.steps[target];
  if (!nextStep) return { kind: "stuck", reason: `step ${fromKey} points at unknown ${target}` };
  return { kind: "step", step: nextStep };
}

export function requiredStepKeys(pipeline: PipelineDefinition): string[] {
  return Object.values(pipeline.steps)
    .filter((s) => s.required)
    .map((s) => s.key);
}
