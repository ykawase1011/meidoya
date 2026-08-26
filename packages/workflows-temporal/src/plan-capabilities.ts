import type { ExecutionPlan, PlannedStep, WorkerCapability, WorkerProfile } from "@meidoya/domain";

/**
 * Phrases that describe an effect outside the workspace: push, PR creation,
 * deploy, external message, credential change (06 section 1.4).
 *
 * This detector is a SECONDARY, over-approximating signal. It is not the gate
 * trigger: a plan that simply declines to narrate its side effect ("Run
 * `scripts/sync.sh` to finish") matches nothing here, so the trigger below keys
 * on the capabilities a step is actually granted, which are structured data the
 * planning agent does not author. All this detector can do is ADD a request,
 * never remove one, so a false positive costs one approval.
 */
const SIDE_EFFECT_PATTERNS: readonly RegExp[] = [
  /\bgit\s+push\b/i,
  /\bpush(?:es|ed|ing)?\b[^.]{0,24}\b(?:remote|origin|upstream|branch|main|master)\b/i,
  /\bpull\s+request\b/i,
  /\bopen(?:s|ed|ing)?\s+(?:a\s+)?pr\b/i,
  /\bdeploy/i,
  /\bpublish/i,
  /\brelease\b/i,
  /\bwebhook/i,
  /\bsend(?:s|ed|ing)?\b[^.]{0,24}\b(?:email|mail|message|slack|discord|notification|sms)\b/i,
  /\b(?:rotate|revoke|change|update)\b[^.]{0,24}\b(?:credential|secret|api\s*key|token|password)\b/i,
  /\bcredential/i,
];

function mentionsSideEffect(text: string): boolean {
  return SIDE_EFFECT_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when anything in the plan DESCRIBES an effect outside the workspace. */
export function planRequestsSideEffects(plan: ExecutionPlan): boolean {
  if (mentionsSideEffect(plan.summary)) return true;
  return plan.steps.some((step) => mentionsSideEffect(step.description));
}

/**
 * Capabilities whose effect can leave the workspace (09 section 9 lists them as
 * distinct worker capabilities). Holding any of these is what makes a step
 * "side-effect capable"; `repo.read` / `repo.write` / `shell` on their own stay
 * inside the sandbox the execution node builds for the run (10 section 3).
 */
export const EXTERNAL_CAPABILITIES: readonly WorkerCapability[] = [
  "network",
  "browser",
  "package-install",
  "external-side-effect",
];

/**
 * The capabilities of a single step that require a human side-effect approval.
 *
 * `external-side-effect`, `package-install` and `browser` mutate something
 * outside the workspace by definition. `network` alone does not (a read-only
 * researcher fetching docs is not a side effect), but network egress held by
 * the SAME step that can also write the repo or run a shell is
 * indistinguishable from `git push` / `curl -X POST`, so it gates.
 *
 * Pure and total: same input, same answer, no clock and no IO. It runs inside
 * workflow code.
 */
export function sideEffectCapabilities(
  capabilities: readonly WorkerCapability[],
): WorkerCapability[] {
  const has = (c: WorkerCapability): boolean => capabilities.includes(c);
  const triggering: WorkerCapability[] = [];
  for (const capability of ["external-side-effect", "package-install", "browser"] as const) {
    if (has(capability)) triggering.push(capability);
  }
  if (has("network") && (has("repo.write") || has("shell"))) triggering.push("network");
  return triggering;
}

/**
 * The capabilities one step of a plan asks for, derived from its KIND, its
 * WorkerProfile and the plan's project access — never from its prose.
 *
 * Unknown territory fails closed: `kind: "other"` is an unclassified step, so
 * it is assumed to want a shell. That is precisely the shape an adversarial
 * plan takes when it wants to run something without saying what.
 */
export function stepCapabilities(
  step: Pick<PlannedStep, "kind" | "workerProfile">,
  options: { writableProjects: boolean } = { writableProjects: true },
): WorkerCapability[] {
  const capabilities = new Set<WorkerCapability>(["repo.read"]);

  const writes =
    step.kind === "implement" ||
    step.workerProfile === "implementer" ||
    step.workerProfile === "mechanical-editor";
  if (writes && options.writableProjects) capabilities.add("repo.write");

  // "other" is unclassified, so it is treated as able to execute anything.
  if (
    step.kind === "implement" ||
    step.kind === "test" ||
    step.kind === "other" ||
    step.workerProfile === "implementer" ||
    step.workerProfile === "tester"
  ) {
    capabilities.add("shell");
  }

  // 09 section 9: the researcher profile is the one that holds network egress.
  if (step.workerProfile === "researcher") capabilities.add("network");

  return [...capabilities];
}

/**
 * What every acting pipeline step starts from, whatever the plan says.
 *
 * `TaskWorkflow` unions this into the grant it decides for a plan (05 section 4:
 * a plan is validated against a grant, and a step that may not read or run
 * anything cannot be validated at all). It is unconditional, so it belongs to
 * the trigger's arithmetic: `repo.write` and `shell` are in the grant of any
 * acting step of any pipeline, whether or not a PLAN step asked for them.
 */
export const BASE_CAPABILITIES: readonly WorkerCapability[] = ["repo.read", "repo.write", "shell"];

export type StepCapabilityGrant = {
  readonly stepKey: string;
  readonly workerProfile: WorkerProfile;
  readonly capabilities: readonly WorkerCapability[];
  /** Non-empty when this step cannot run without a human side-effect approval. */
  readonly requiresSideEffectApproval: readonly WorkerCapability[];
};

/** What one plan step asks for on its own, before any plan-wide widening. */
type OwnStepRequest = {
  stepKey: string;
  workerProfile: WorkerProfile;
  capabilities: WorkerCapability[];
};

function ownStepRequests(plan: ExecutionPlan): OwnStepRequest[] {
  const writableProjects = plan.projects.some((access) => access.mode === "write");
  const narrated = mentionsSideEffect(plan.summary);
  return plan.steps.map((step) => {
    const capabilities = new Set<WorkerCapability>(stepCapabilities(step, { writableProjects }));
    // The prose detector only ever ADDS a request.
    if (narrated || mentionsSideEffect(step.description)) {
      capabilities.add("external-side-effect");
    }
    return {
      stepKey: step.key,
      workerProfile: step.workerProfile,
      capabilities: [...capabilities],
    };
  });
}

/**
 * The plan-wide union: exactly what {@link derivePlanCapabilities} requests and
 * therefore exactly what {@link grantForStep} later narrows a step's grant FROM.
 */
function planCapabilityUnion(
  plan: ExecutionPlan,
  requests: readonly OwnStepRequest[],
): WorkerCapability[] {
  const capabilities = new Set<WorkerCapability>(["repo.read"]);
  if (plan.projects.some((access) => access.mode === "write")) capabilities.add("repo.write");
  for (const request of requests) {
    for (const capability of request.capabilities) capabilities.add(capability);
  }
  if (plan.verification.commands.length > 0) capabilities.add("shell");
  return [...capabilities];
}

/**
 * The widening {@link grantForStep} performs, in isolation.
 *
 * A step that can act at all (`shell` or `repo.write`) receives every external
 * capability the PLAN holds, not merely the ones it asked for itself. That is
 * deliberate — an approved external effect belongs to the steps that can use it
 * — but it means a step's real grant is this widened set, so it is also the set
 * the side-effect trigger has to be evaluated on.
 */
function widenToPlanExternals(
  own: readonly WorkerCapability[],
  planWide: readonly WorkerCapability[],
): WorkerCapability[] {
  if (!own.includes("shell") && !own.includes("repo.write")) return [...own];
  const widened = new Set<WorkerCapability>(own);
  for (const capability of EXTERNAL_CAPABILITIES) {
    if (planWide.includes(capability)) widened.add(capability);
  }
  return [...widened];
}

/**
 * Per-step capability requests for a whole plan. Pure and deterministic.
 *
 * `requiresSideEffectApproval` is what a step of the PLAN would trip if the
 * pipeline ran that step. It is NOT the workflow's gate trigger and must not be
 * used as one: the steps that actually run are the PIPELINE's, which the plan
 * does not author, so a plan that declares no acting step trips nothing here
 * while the pipeline's fixed `implement` step is still handed the plan-wide
 * grant. {@link derivePlanSideEffectCapabilities} is the trigger.
 */
export function derivePlanStepCapabilities(plan: ExecutionPlan): StepCapabilityGrant[] {
  const requests = ownStepRequests(plan);
  const planWide = planCapabilityUnion(plan, requests);
  return requests.map((request) => ({
    stepKey: request.stepKey,
    workerProfile: request.workerProfile,
    capabilities: request.capabilities,
    requiresSideEffectApproval: sideEffectCapabilities(
      widenToPlanExternals(request.capabilities, planWide),
    ),
  }));
}

/**
 * The whole grant an acting step of ANY pipeline receives for this plan: the
 * plan-wide union plus {@link BASE_CAPABILITIES}, which `TaskWorkflow` adds
 * unconditionally.
 *
 * This — not a plan step's own request — is the set the gate trigger has to be
 * evaluated on. The plan's steps are narrative; the steps that RUN are the
 * pipeline's, fixed in `@meidoya/task-engine` and not authored by the planning
 * agent, and `grantForStep` hands each acting one of them everything in here
 * that a step of its kind can justify.
 */
export function planWideGrant(plan: ExecutionPlan): WorkerCapability[] {
  return [
    ...new Set<WorkerCapability>([...BASE_CAPABILITIES, ...derivePlanCapabilities(plan)]),
  ];
}

/**
 * The pre-`task-side-effect-gate-pipeline-202608` trigger, frozen.
 *
 * Evaluated on {@link planWideGrant} WHOLE: the coding pipeline's `implement`
 * step exists whatever the plan's own steps say, so a plan that declares only
 * `investigate` and `review` steps still results in `repo.write` + `shell` +
 * `network` being handed to a Worker, and keying on the plan's steps let exactly
 * that plan through ungated. Reading the grant whole closed that — and, because
 * {@link BASE_CAPABILITIES} is in it unconditionally, also made a read-only
 * research task ask for an approval no step of its pipeline could act on.
 * {@link derivePipelineSideEffectCapabilities} keeps the first property and
 * drops the second.
 *
 * It is not the behaviour we want; it is the behaviour an execution started
 * before that patch already committed to, so it must replay unchanged. Do not
 * "fix" anything in here.
 */
export function derivePlanSideEffectCapabilities(plan: ExecutionPlan): WorkerCapability[] {
  const granted = planWideGrant(plan);
  if (sideEffectCapabilities(granted).length === 0) return [];

  // Once the grant trips the trigger, every capability in it that can leave the
  // workspace waits for the same human answer. Fail closed: we do not hand out
  // half an escape route while asking about the other half.
  return granted.filter((capability) => EXTERNAL_CAPABILITIES.includes(capability));
}

/**
 * One step of the PIPELINE, as the side-effect trigger needs to see it.
 *
 * `kind` is pipeline vocabulary (`research`, `implement`, `verify`, …), mapped
 * to planned-step vocabulary by {@link plannedKindOfPipelineKind}. `undefined`
 * for `workerProfile` means the workflow's own default, which is `implementer`
 * — the widest one, so an unstated profile fails closed.
 */
export type ActingPipelineStep = {
  readonly kind: string;
  readonly workerProfile?: WorkerProfile;
};

/**
 * The capabilities a human must approve before THIS PIPELINE may run THIS PLAN.
 *
 * The difference from {@link derivePlanSideEffectCapabilities} is which set the
 * trigger is evaluated on. That one evaluates {@link planWideGrant} whole — and
 * {@link BASE_CAPABILITIES} puts `repo.write` + `shell` in it unconditionally,
 * so ANY plan with a researcher step (hence `network`) trips the trigger, on
 * every pipeline. A purely read-only research task therefore asked for a
 * side-effect approval it could not possibly need. That is fail-closed, but a
 * gate that fires on everything is a gate people approve without reading, which
 * is worse protection than no gate at all.
 *
 * So the trigger is evaluated on the grants the RUNNING pipeline's steps will
 * ACTUALLY receive — `grantForStep` per step, exactly as `runTaskWorkflow`
 * computes it at dispatch — and it must still catch both demonstrated escapes:
 *
 *  - the coding pipeline's fixed `implement` step is in this list whatever the
 *    plan declares, and it is an `implementer`, so it receives `repo.write` +
 *    `shell` + every external the plan holds: an unnarrated plan with a
 *    researcher step still gates;
 *  - the research pipeline's Worker steps are both `researcher` on an
 *    `investigate` kind, so they receive `repo.read` + `network` and NEITHER
 *    `shell` nor `repo.write` — network egress with nothing to act with, which
 *    is what `sideEffectCapabilities` has always said is not a side effect.
 *
 * A `verify` step is included even though `runVerification` carries no grant:
 * it runs the operator's commands in the workspace, so counting it can only ADD
 * a gate, never remove one.
 *
 * What is APPROVED does not change: once anything gates, the answer covers every
 * external capability in the plan-wide grant, because the grant assigned after
 * the gate is still the plan-wide one and any acting step may be widened to it.
 */
export function derivePipelineSideEffectCapabilities(
  plan: ExecutionPlan,
  actingSteps: readonly ActingPipelineStep[],
): WorkerCapability[] {
  const granted = planWideGrant(plan);
  const writableProjects = plan.projects.some((access) => access.mode === "write");
  const gates = actingSteps.some(
    (step) =>
      sideEffectCapabilities(
        grantForStep(
          granted,
          {
            kind: plannedKindOfPipelineKind(step.kind),
            workerProfile: step.workerProfile ?? "implementer",
          },
          { writableProjects },
        ),
      ).length > 0,
  );
  if (!gates) return [];
  return granted.filter((capability) => EXTERNAL_CAPABILITIES.includes(capability));
}

/**
 * The pre-`task-side-effect-gate-union-202608` trigger, frozen.
 *
 * It evaluated each PLANNED step's own request, widened with the plan's external
 * capabilities the way `grantForStep` widens it. That caught the narrated
 * researcher + implementer shape and missed the unnarrated one: a plan whose
 * steps are `investigate` + `review` holds `network` (researcher), `repo.write`
 * (project mode) and `shell` (verification commands) plan-wide, yet no PLANNED
 * step's own request holds both egress and an ability to act — so nothing
 * gated, while the coding pipeline's `implement` step was handed all four.
 *
 * It is not the behaviour we want; it is the behaviour an execution started
 * before the patch already committed to, so it must replay unchanged. Do not
 * "fix" anything in here.
 */
export function derivePlanSideEffectCapabilitiesPerStepGrant(
  plan: ExecutionPlan,
): WorkerCapability[] {
  const requests = ownStepRequests(plan);
  const planWide = planCapabilityUnion(plan, requests);
  const gates = requests.some(
    (request) =>
      sideEffectCapabilities(widenToPlanExternals(request.capabilities, planWide)).length > 0,
  );
  if (!gates) return [];

  const gating = new Set<WorkerCapability>();
  for (const request of requests) {
    for (const capability of request.capabilities) {
      if (EXTERNAL_CAPABILITIES.includes(capability)) gating.add(capability);
    }
  }
  return [...gating];
}

/**
 * True when this plan may not run until a human approves a side effect —
 * PLAN-WIDE, i.e. the pre-`task-side-effect-gate-pipeline-202608` question.
 * The workflow asks {@link derivePipelineSideEffectCapabilities} instead, which
 * needs the pipeline that is going to run; this stays as the plan-only form.
 *
 * The trigger is STRUCTURED: it is the capability set an acting step will be
 * granted, not what the plan says about itself and not what the plan's own
 * steps ask for. A plan whose grant holds nothing that can leave the workspace
 * does not gate, however alarming its wording; a plan whose grant holds network
 * + shell gates even if it describes itself as "tidy up" and even if it lists
 * no step that would use either.
 */
export function planRequiresSideEffectApproval(plan: ExecutionPlan): boolean {
  return derivePlanSideEffectCapabilities(plan).length > 0;
}

/**
 * The capabilities a plan actually asks for, derived from the plan itself.
 *
 * 05 section 4: the Control Plane decides whether a plan is runnable, and it can
 * only do that against what the plan really requests. A hardcoded capability
 * list makes every capability rule in plan validation vacuous.
 */
export function derivePlanCapabilities(plan: ExecutionPlan): WorkerCapability[] {
  return planCapabilityUnion(plan, ownStepRequests(plan));
}

/**
 * The pre-`task-side-effect-gate-grant-202608` trigger, frozen.
 *
 * It evaluated every planned step IN ISOLATION, so a plan whose researcher step
 * held `network` and whose implementer step held `repo.write` + `shell` never
 * gated — even though the implementer step was then granted `network` from the
 * plan-wide union. It is not the behaviour we want; it is the behaviour an
 * execution started before the patch already committed to, so it must replay
 * unchanged. Do not "fix" anything in here.
 */
export function derivePlanSideEffectCapabilitiesIsolated(plan: ExecutionPlan): WorkerCapability[] {
  const requests = ownStepRequests(plan);
  if (!requests.some((request) => sideEffectCapabilities(request.capabilities).length > 0)) {
    return [];
  }
  const gating = new Set<WorkerCapability>();
  for (const request of requests) {
    for (const capability of request.capabilities) {
      if (EXTERNAL_CAPABILITIES.includes(capability)) gating.add(capability);
    }
  }
  return [...gating];
}

/**
 * The capabilities handed to ONE pipeline step's Worker run: the plan-wide
 * grant narrowed to what a step of this kind and profile can justify.
 *
 * The narrowing matters because the grant is the run scope: a `review` step
 * must not inherit the `external-side-effect` a human approved for the
 * `implement` step of the same plan.
 */
/**
 * Pipeline step kinds are control-plane vocabulary; PlannedStep kinds are the
 * plan's. An unmapped pipeline kind falls back to the NARROWEST planned kind,
 * because narrowing a grant is the safe direction.
 */
const PLANNED_KIND_OF_PIPELINE_KIND: Readonly<Record<string, PlannedStep["kind"]>> = {
  research: "investigate",
  synthesize: "investigate",
  work: "implement",
  implement: "implement",
  execute: "implement",
  fix: "implement",
  verify: "test",
  review: "review",
};

export function plannedKindOfPipelineKind(kind: string): PlannedStep["kind"] {
  return PLANNED_KIND_OF_PIPELINE_KIND[kind] ?? "investigate";
}

export function grantForStep(
  granted: readonly WorkerCapability[],
  step: Pick<PlannedStep, "kind" | "workerProfile">,
  options: { writableProjects: boolean } = { writableProjects: true },
): WorkerCapability[] {
  const wanted = new Set<WorkerCapability>(stepCapabilities(step, options));
  // An approved external effect belongs to the steps that can act at all.
  if (wanted.has("shell") || wanted.has("repo.write")) {
    for (const capability of EXTERNAL_CAPABILITIES) {
      if (granted.includes(capability)) wanted.add(capability);
    }
  }
  return granted.filter((capability) => wanted.has(capability));
}
