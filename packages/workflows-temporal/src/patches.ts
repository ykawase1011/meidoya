/**
 * Workflow patch ids (Temporal "versioning").
 *
 * A patch id names ONE replay-visible change to workflow code: a command the
 * workflow now issues that it did not before, a command it no longer issues, or
 * a change in the order commands are issued. Activity *arguments* and pure
 * computation are not replay-visible; the sequence of activity invocations,
 * timers, child workflows and signals is.
 *
 * Naming: `<workflow>-<change>-<yyyymm>`, lower-kebab, where `<workflow>` is the
 * workflow the change lives in (`task`, `maid`, `head-maid`, `request`,
 * `cross-workspace`, `environment`), `<change>` is what moved, and `<yyyymm>` is
 * the month the change was written. The month makes the drain order obvious when
 * several patches are in flight at once.
 *
 * Lifecycle — see `README.md` § Workflow versioning:
 *   1. add `patched(id)` around the change, keeping the old branch intact;
 *   2. deploy; both branches now exist in the worker;
 *   3. wait for every execution started before the deploy to close;
 *   4. replace `patched(id)` with `deprecatePatch(id)` and delete the old branch;
 *   5. deploy again, wait again, then delete the `deprecatePatch(id)` call, drop
 *      the field from `TaskWorkflow`'s `version` object — the eager evaluation
 *      is what costs a marker on every execution — and retire the id from here.
 *
 * Ids are never reused or renamed once deployed: the id is written into the
 * history of every execution that ran through it.
 */

/**
 * What "before this patch" means
 * ------------------------------
 * The old branch a patch preserves is the code of the PREVIOUS RELEASE — the
 * commit the currently-running workers were built from — not some earlier,
 * more distant ancestor. An id whose legacy branch reconstructs the wrong
 * generation is worse than no id at all: `patched()` answers `false` for the
 * histories in flight, so those executions are steered into a branch that never
 * produced their history, and every one of them wedges on a workflow-task
 * failure that Temporal retries forever.
 *
 * Before adding an id, diff against the previous release and gate ONLY what
 * actually differs:
 *
 *   git show <previous-release>:packages/workflows-temporal/src/workflows/task.ts
 *
 * The seven `task-*-202608` ids that used to live here reconstructed the
 * command stream of a release two generations back; against the release
 * actually deployed they gated no difference at all, so they were removed
 * before they ever reached a history.
 */

/**
 * The side-effect gate's trigger is evaluated on the grant a step will ACTUALLY
 * be issued — its own request widened with the plan's external capabilities,
 * the way `grantForStep` widens it — instead of on each planned step's request
 * in isolation.
 *
 * Before this, an ordinary plan (a researcher step holding `network`, an
 * implementer step holding `repo.write` + `shell`) gated nothing, and the
 * implement step was then handed `network` + `shell` + `repo.write` with no
 * approval. Afterwards such a plan asks for a `side-effect-approval` — one more
 * `createCheckpoint`/`recordTaskStatus` pair, hence a patch.
 */
export const TASK_SIDE_EFFECT_GATE_GRANT = "task-side-effect-gate-grant-202608";

/**
 * The side-effect gate's trigger is evaluated on the grant an acting step of the
 * PIPELINE receives — the plan-wide union plus the unconditional
 * `BASE_CAPABILITIES` — instead of on the PLAN's own steps.
 *
 * Before this, a plan that declared no acting step tripped nothing: with steps
 * `[investigate/researcher, review/reviewer]`, writable projects and
 * verification commands, no planned step's widened request held both egress and
 * an ability to act, so no gate was asked — and the coding pipeline's fixed
 * `implement` step, which the plan does not author, was then handed
 * `repo.read, repo.write, shell, network` with no approval. Afterwards such a
 * plan asks for a `side-effect-approval` — one more
 * `createCheckpoint`/`recordTaskStatus` pair, hence a patch.
 *
 * Its legacy branch is `derivePlanSideEffectCapabilitiesPerStepGrant`, which is
 * the previous release's (d492edd) `derivePlanSideEffectCapabilities` verbatim.
 */
export const TASK_SIDE_EFFECT_GATE_UNION = "task-side-effect-gate-union-202608";

/**
 * The side-effect gate's trigger is evaluated on the grants the RUNNING
 * pipeline's steps will each receive, instead of on the plan-wide grant whole.
 *
 * Before this, `BASE_CAPABILITIES` (`repo.write` + `shell`) was unioned into the
 * set the trigger read, so ANY plan with a researcher step — hence `network` —
 * tripped it, on every pipeline. A read-only research task, whose Worker steps
 * are both `researcher` and receive `repo.read` + `network` and nothing to act
 * with, asked for a side-effect approval that could not correspond to any effect
 * it was able to have. Fail-closed, but a gate that fires on everything is one
 * people approve without reading.
 *
 * Afterwards such a plan on the `research` pipeline asks for NO
 * `side-effect-approval` — one `createCheckpoint`/`recordTaskStatus` pair FEWER,
 * hence a patch. Nothing changes for `coding`: its fixed `implement` step is an
 * `implementer`, so it still receives `repo.write` + `shell` + the plan's
 * externals, and both previously demonstrated escapes still gate.
 *
 * Its legacy branch is `derivePlanSideEffectCapabilities`, which is the previous
 * release's (4e663ee) trigger unchanged.
 */
export const TASK_SIDE_EFFECT_GATE_PIPELINE = "task-side-effect-gate-pipeline-202608";

/**
 * Routes logical model profiles from `model_policy` and runs repository review
 * on the selected execution node. Before this patch every call was hardcoded
 * to Codex and review ran on the control host with no checkout. The new path
 * adds `resolveWorkerRuntime` activities and changes the review activity queue.
 */
export const TASK_MODEL_POLICY_ROUTING = "task-model-policy-routing-202608";

/**
 * Every patch id currently live in `TaskWorkflow`, in the order the workflow
 * evaluates them. `patches.test.ts` asserts each one is still gated — and, in
 * the other direction, that `TaskWorkflow` calls `patched()` with nothing else.
 */
export const TASK_WORKFLOW_PATCH_IDS = [
  TASK_SIDE_EFFECT_GATE_GRANT,
  TASK_SIDE_EFFECT_GATE_UNION,
  TASK_SIDE_EFFECT_GATE_PIPELINE,
  TASK_MODEL_POLICY_ROUTING,
] as const;

/** Ids that have been deprecated but not yet removed (`deprecatePatch`). */
export const DEPRECATED_PATCH_IDS: readonly string[] = [];
