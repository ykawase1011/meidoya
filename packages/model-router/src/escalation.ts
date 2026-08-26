import type { ModelProfile, RuntimeProfile, WorkerProfile } from "@meidoya/domain";
import { isAllowed, type ModelPolicy } from "./policy.js";

/** 09 section 7 ladder. */
const LADDER: Record<ModelProfile, ModelProfile | undefined> = {
  economy: "standard",
  standard: "high",
  high: undefined,
};

export type EscalationState = {
  readonly runtime: RuntimeProfile;
  readonly escalations: number;
  readonly lastFailureClass?: string;
};

export type AttemptOutcome = {
  readonly failed: boolean;
  readonly failureClass?: string;
  /** Whether the attempt moved the task forward at all. */
  readonly progress: boolean;
};

export type EscalationLimits = {
  readonly maxModelEscalations: number;
};

export type EscalationDecision =
  | { readonly type: "continue"; readonly state: EscalationState }
  | { readonly type: "retry"; readonly state: EscalationState; readonly rationale: string }
  | { readonly type: "escalate"; readonly state: EscalationState; readonly from: ModelProfile }
  | { readonly type: "needs_attention"; readonly reason: EscalationStopReason };

export type EscalationStopReason =
  | "no_progress_at_high"
  | "escalation_limit_reached"
  | "no_allowed_higher_profile";

export type EscalationContext = {
  readonly policy?: ModelPolicy;
  readonly workerProfile?: WorkerProfile;
};

/**
 * economy failure -> standard; the SAME failure again at standard -> high;
 * no progress at high -> needs_attention. Bounded by max_model_escalations.
 */
export function nextEscalation(
  state: EscalationState,
  outcome: AttemptOutcome,
  limits: EscalationLimits,
  ctx: EscalationContext = {},
): EscalationDecision {
  if (!outcome.failed) return { type: "continue", state };

  const current = state.runtime.modelProfile;

  if (current === "high") {
    if (outcome.progress) {
      return { type: "retry", state, rationale: "progress at the highest profile" };
    }
    return { type: "needs_attention", reason: "no_progress_at_high" };
  }

  // At standard, only a repeat of the SAME failure class earns an escalation.
  if (
    current === "standard" &&
    state.lastFailureClass !== undefined &&
    outcome.failureClass !== undefined &&
    state.lastFailureClass !== outcome.failureClass
  ) {
    return {
      type: "retry",
      state: {
        runtime: state.runtime,
        escalations: state.escalations,
        ...(outcome.failureClass === undefined ? {} : { lastFailureClass: outcome.failureClass }),
      },
      rationale: "different failure class at standard; retry before escalating",
    };
  }

  if (state.escalations >= limits.maxModelEscalations) {
    return { type: "needs_attention", reason: "escalation_limit_reached" };
  }

  const target = LADDER[current];
  if (target === undefined) return { type: "needs_attention", reason: "no_progress_at_high" };

  const nextRuntime: RuntimeProfile = { provider: state.runtime.provider, modelProfile: target };
  if (
    ctx.policy !== undefined &&
    ctx.workerProfile !== undefined &&
    !isAllowed(ctx.policy, ctx.workerProfile, nextRuntime)
  ) {
    return { type: "needs_attention", reason: "no_allowed_higher_profile" };
  }

  return {
    type: "escalate",
    from: current,
    state: {
      runtime: nextRuntime,
      escalations: state.escalations + 1,
      ...(outcome.failureClass === undefined ? {} : { lastFailureClass: outcome.failureClass }),
    },
  };
}
