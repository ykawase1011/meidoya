/**
 * Test-only workflow entry point: `TaskWorkflow` with every `patched()` answer
 * forced to `false`.
 *
 * This is NOT exported from `./index.ts` and no production worker registers it.
 * It exists because the legacy branches are otherwise reachable only by
 * replaying a pre-patch history, and a replay checks the sequence of activity
 * INVOCATIONS — it never sees an activity's arguments. That blind spot is how a
 * legacy branch handing out a capability nobody approved, or satisfying a review
 * gate nobody answered, passed the whole suite: the command stream is identical
 * either way.
 *
 * Recording a pre-patch FIXTURE from this file would be circular and is
 * forbidden (see the recipe at the bottom of `replay.test.ts`): a fixture must
 * come from the previous release's source. Driving assertions about what the
 * legacy branch PASSES to its activities is the opposite — the fixture pins the
 * shape, these tests pin the contents.
 */
import { runTaskWorkflow, type TaskWorkflowInput, type TaskWorkflowResult } from "./task.js";

export {
  taskAnswerCheckpointSignal,
  taskCancelTaskSignal,
  taskRefreshPolicySignal,
  taskSnapshotQuery,
} from "./task.js";

export async function TaskWorkflowPrePatch(
  input: TaskWorkflowInput,
): Promise<TaskWorkflowResult> {
  return runTaskWorkflow(input, {
    sideEffectGateGrant: false,
    sideEffectGateUnion: false,
    sideEffectGatePipeline: false,
    modelPolicyRouting: false,
  });
}

/**
 * The generation between the two side-effect-gate patches: an execution that
 * started after `task-side-effect-gate-grant-202608` deployed and before
 * `task-side-effect-gate-union-202608` did.
 *
 * Its trigger is each PLANNED step's request widened with the plan's externals,
 * so a plan that declares no acting step gates nothing while the pipeline's
 * `implement` step still takes the whole grant. That is the defect the union
 * patch closes — and the behaviour those in-flight executions committed to.
 */
export async function TaskWorkflowPreUnionPatch(
  input: TaskWorkflowInput,
): Promise<TaskWorkflowResult> {
  return runTaskWorkflow(input, {
    sideEffectGateGrant: true,
    sideEffectGateUnion: false,
    sideEffectGatePipeline: false,
    modelPolicyRouting: false,
  });
}

/**
 * The generation between `task-side-effect-gate-union-202608` and
 * `task-side-effect-gate-pipeline-202608`: an execution started on the previous
 * release (4e663ee).
 *
 * Its trigger reads the plan-wide grant WHOLE, `BASE_CAPABILITIES` included, so
 * a read-only research plan asks for a side-effect approval there. That is the
 * gate the pipeline patch stops asking — and the one those in-flight executions
 * are already parked on, so this branch has to keep asking it.
 */
export async function TaskWorkflowPrePipelinePatch(
  input: TaskWorkflowInput,
): Promise<TaskWorkflowResult> {
  return runTaskWorkflow(input, {
    sideEffectGateGrant: true,
    sideEffectGateUnion: true,
    sideEffectGatePipeline: false,
    modelPolicyRouting: false,
  });
}
