import {
  PIPELINE_END,
  type PipelineDefinition,
  type PipelineStep,
  type PipelineStepKind,
} from "@meidoya/task-engine";

/**
 * Properties of the shipped pipelines that `TaskWorkflow` relies on.
 *
 * The workflow is written against the pipelines as they are, and two of its
 * simplifications are only correct because of a property of those definitions
 * rather than of the workflow itself. A property nobody checks is a property
 * that quietly stops holding, so each one is a predicate here and an assertion
 * in `pipelines-guard.test.ts`.
 *
 * Pure: definitions in, verdict out. Nothing here runs inside workflow code.
 */

export type PipelineViolation = { pipeline: string; stepKey: string; reason: string };

/**
 * Every step that can RAISE a `review-approval` gate is a TERMINAL step.
 *
 * `TaskWorkflow` keeps one `reviewGateSatisfied` flag, set by any human answer
 * to a `review-approval` gate and read again at the completion check. That is
 * only sound while such an answer is always the LAST thing before completion —
 * otherwise an approval given at step 2 stands in for the completion question
 * about work that steps 3..n have changed since.
 *
 * ## Which steps can raise one
 *
 * Not "the steps that DECLARE `gate: "review-approval"`". That was the old
 * predicate, and it was checking the wrong thing: the pre-step gate is skipped
 * precisely when a `review` step declares one (`task.ts`), while
 * `applyManagerDecision` raises a `review-approval` gate from the body of ANY
 * `review` step, whatever gate that step declares — including none. So a
 * non-terminal `review` step with no declared gate would set
 * `reviewGateSatisfied` in the middle of a pipeline and this guard would have
 * stayed silent about it. Both shipped `review` steps happen to be terminal on
 * success, so the property held by accident.
 *
 * The predicate is therefore `kind === "review"`, plus any step that declares
 * the gate anyway (a declaration on a non-`review` kind IS honoured, as a
 * pre-step gate).
 *
 * A scoping mechanism for the flag existed and was removed: with these pipelines
 * it could not fire, so it was unreachable code that no test could make fail.
 * The day this predicate returns a violation is the day it has to come back —
 * and at that moment the completion check starts asking where it used to stay
 * silent, which is replay-visible and needs a patch id (see `patches.ts`).
 */
export function reviewApprovalGatesOnNonTerminalSteps(
  pipelines: Readonly<Record<string, PipelineDefinition>>,
): PipelineViolation[] {
  const violations: PipelineViolation[] = [];
  for (const [name, pipeline] of Object.entries(pipelines)) {
    for (const step of Object.values(pipeline.steps)) {
      const declares = step.gate === "review-approval";
      // `applyManagerDecision` can return a `review-approval` gate from any
      // review step; nothing about the step's own `gate` field prevents it.
      const raises = step.kind === "review";
      if (!declares && !raises) continue;
      if (step.next.success === PIPELINE_END) continue;
      violations.push({
        pipeline: name,
        stepKey: step.key,
        reason: declares
          ? "a review-approval gate declared on a non-terminal step: its answer would stand in " +
            "for the completion question about work done after it"
          : "a non-terminal review step: applyManagerDecision can raise a review-approval gate " +
            "from it, and that answer would stand in for the completion question about work " +
            "done after it",
      });
    }
  }
  return violations;
}

/**
 * Every `verify` step belongs to a pipeline whose plans are required to carry
 * verification commands.
 *
 * `TaskWorkflow` refuses to run a verify step with no commands, because an empty
 * command list evaluates to `passed` and a task must not complete on a quality
 * gate that ran nothing. Plan validation already rejects an empty verification
 * for the `coding` pipeline (`requireVerification`), so today that refusal is a
 * floor under a rule rather than a live path — which is true only while `coding`
 * is the one pipeline with a verify step. When another gains one, either that
 * pipeline requires verification in `validateExecutionPlan` too, or its tasks
 * start halting on the floor.
 */
export function verifyStepsOutsideRequiredVerification(
  pipelines: Readonly<Record<string, PipelineDefinition>>,
  pipelinesRequiringVerification: readonly string[],
): PipelineViolation[] {
  const violations: PipelineViolation[] = [];
  for (const [name, pipeline] of Object.entries(pipelines)) {
    if (pipelinesRequiringVerification.includes(name)) continue;
    for (const step of Object.values(pipeline.steps)) {
      if (step.kind !== "verify") continue;
      violations.push({
        pipeline: name,
        stepKey: step.key,
        reason:
          "a verify step in a pipeline whose plans are not required to carry verification " +
          "commands: the workflow halts rather than pass a task on zero commands",
      });
    }
  }
  return violations;
}

/**
 * Who runs a step of each kind, as `runTaskWorkflow`'s dispatch switch ACTUALLY
 * decides it.
 *
 * `PipelineStep.executor` was read by nothing: the switch keyed on `kind` alone
 * and every unhandled kind fell into a `default:` that dispatched a Worker run
 * on the execution node with `workerProfile: "implementer"`. The whole
 * `cross-workspace` body — `delegate`, `await-children`, `aggregate`, declared
 * `control` / `manager` — went out as implementer Worker runs, and a field that
 * says who runs a step while nothing reads it is worse than no field at all.
 *
 * So this table is the workflow's dispatch, written down once:
 *  - `control` — the workflow itself, no agent and no node (a `clarify` step is
 *    only its pre-step gate; `compare` and `deliver` are control-plane calls);
 *  - `manager` — a Manager agent activity on the control plane's queue;
 *  - `commands` — the quality-gate command groups, on the NODE's queue;
 *  - `worker` — `worker.runWorkerStep`, on the node's queue.
 *
 * A kind absent from this table is one the workflow does not implement: it
 * pauses the task rather than guessing, and {@link stepsTaskWorkflowCannotRun}
 * keeps such a kind out of any pipeline the workflow is allowed to drive.
 */
export const TASK_WORKFLOW_DISPATCH: Readonly<
  Partial<Record<PipelineStepKind, PipelineStep["executor"]>>
> = {
  clarify: "control",
  plan: "manager",
  assess: "manager",
  verify: "commands",
  compare: "control",
  deliver: "control",
  review: "manager",
  work: "worker",
  research: "worker",
  synthesize: "worker",
  implement: "worker",
  execute: "worker",
  fix: "worker",
};

/**
 * The steps of a pipeline that RUN something in the workspace, and are therefore
 * the ones the side-effect gate's trigger is evaluated on.
 *
 * That is the `worker` steps (a Worker run, handed `grantForStep(planGrant, …)`
 * as its authoritative run scope) and the `commands` step (quality gates, run by
 * the node in the same sandbox). `control` steps run inside the workflow and
 * `manager` steps are agent calls on the control plane: neither is handed a
 * capability grant, and counting them would put an `implementer`'s `repo.write`
 * + `shell` behind every `plan` step in the repository — which is precisely the
 * over-approximation the trigger is being narrowed away from.
 *
 * Derived from {@link TASK_WORKFLOW_DISPATCH}, so it cannot drift from who the
 * workflow really dispatches a step to.
 */
export function capabilityGrantedSteps(pipeline: PipelineDefinition): PipelineStep[] {
  return Object.values(pipeline.steps).filter((step) => {
    const dispatch = TASK_WORKFLOW_DISPATCH[step.kind];
    return dispatch === "worker" || dispatch === "commands";
  });
}

/** The step kinds `runTaskWorkflow` implements. */
export const TASK_WORKFLOW_STEP_KINDS: readonly PipelineStepKind[] = Object.keys(
  TASK_WORKFLOW_DISPATCH,
) as PipelineStepKind[];

/**
 * Steps whose kind `TaskWorkflow` does not implement.
 *
 * Today that is exactly the `cross-workspace` pipeline, which
 * `CrossWorkspaceWorkflow` drives instead — its delegation, its child wait and
 * its aggregation are workflow-level constructs (child workflows and signals),
 * not activities a task step can call. `runTaskWorkflow` refuses such a
 * pipeline at the top rather than walking into it, and the test pins that the
 * refused set is exactly the pipelines this predicate flags.
 */
export function stepsTaskWorkflowCannotRun(
  pipelines: Readonly<Record<string, PipelineDefinition>>,
): PipelineViolation[] {
  const violations: PipelineViolation[] = [];
  for (const [name, pipeline] of Object.entries(pipelines)) {
    for (const step of Object.values(pipeline.steps)) {
      if (TASK_WORKFLOW_DISPATCH[step.kind] !== undefined) continue;
      violations.push({
        pipeline: name,
        stepKey: step.key,
        reason: `a ${step.kind} step, which TaskWorkflow does not implement`,
      });
    }
  }
  return violations;
}

/** The pipelines {@link stepsTaskWorkflowCannotRun} rules out, by name. */
export function pipelinesTaskWorkflowCannotRun(
  pipelines: Readonly<Record<string, PipelineDefinition>>,
): string[] {
  return [...new Set(stepsTaskWorkflowCannotRun(pipelines).map((v) => v.pipeline))].sort();
}

/**
 * Steps whose declared `executor` disagrees with who the workflow really runs
 * them through.
 *
 * This is what stops `executor` being decorative again: a `review` step
 * declared `worker` while `runStep` calls `manager.runReview`, or an
 * `implement` step declared `control` while it is dispatched to the node, is a
 * documentation defect one refactor away from being a routing defect.
 */
export function stepsWhoseExecutorMisstatesDispatch(
  pipelines: Readonly<Record<string, PipelineDefinition>>,
): PipelineViolation[] {
  const violations: PipelineViolation[] = [];
  for (const [name, pipeline] of Object.entries(pipelines)) {
    for (const step of Object.values(pipeline.steps)) {
      const dispatch = TASK_WORKFLOW_DISPATCH[step.kind];
      if (dispatch === undefined || dispatch === step.executor) continue;
      violations.push({
        pipeline: name,
        stepKey: step.key,
        reason: `declares executor "${step.executor}" but TaskWorkflow runs a ${step.kind} step through ${dispatch}`,
      });
    }
  }
  return violations;
}
