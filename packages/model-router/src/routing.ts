import type { Provider, RuntimeProfile, WorkerProfile } from "@meidoya/domain";
import { z } from "zod";
import { resolveModel, type ModelMapping } from "./model-mapping.js";
import { allowedRuntimes, isAllowed, type ModelPolicy } from "./policy.js";

const WORKER_PROFILES: readonly WorkerProfile[] = [
  "researcher",
  "implementer",
  "reviewer",
  "security-reviewer",
  "tester",
  "mechanical-editor",
];

/**
 * 09 section 6: the Manager PROPOSES; it may never name a node or a credential.
 * Any such field is a rejection, not something to strip and continue with.
 */
export const FORBIDDEN_PROPOSAL_FIELDS: readonly string[] = [
  "node",
  "nodeId",
  "nodePath",
  "executionNode",
  "executionNodeId",
  "host",
  "hostname",
  "sshTarget",
  "binaryPath",
  "credential",
  "credentials",
  "apiKey",
  "api_key",
  "token",
  "secret",
  "env",
  "resolvedModel",
  "model",
];

export const ManagerRoutingProposalSchema = z
  .object({
    workerProfile: z.string(),
    provider: z.enum(["codex", "claude"]),
    modelProfile: z.enum(["high", "standard", "economy"]),
    rationale: z.string().optional(),
  })
  .passthrough();

export type ManagerRoutingProposal = {
  readonly workerProfile: WorkerProfile;
  readonly provider: Provider;
  readonly modelProfile: RuntimeProfile["modelProfile"];
  readonly rationale?: string;
};

export type RuntimeCapabilityIndex = {
  /** Which logical profiles a provider can actually serve right now. */
  readonly supported: Partial<Record<Provider, readonly RuntimeProfile["modelProfile"][]>>;
};

export type QuotaState = {
  readonly remainingByProvider?: Partial<Record<Provider, number>>;
};

export type GatePolicy = {
  /** Runtime keys that require a human gate before dispatch. */
  readonly requiresApproval?: readonly string[];
  readonly approvals?: readonly string[];
};

export type RoutingContext = {
  readonly mapping: ModelMapping;
  readonly policy: ModelPolicy;
  readonly capabilities?: RuntimeCapabilityIndex;
  readonly quota?: QuotaState;
  readonly gates?: GatePolicy;
};

export type RoutingRejectionReason =
  | "malformed_proposal"
  | "forbidden_field"
  | "unknown_worker_profile"
  | "no_policy_for_worker_profile"
  | "not_allowed_by_policy"
  | "capability_unsupported"
  | "quota_exhausted"
  | "gate_required";

export type ResolvedRouting = {
  readonly workerProfile: WorkerProfile;
  readonly runtime: RuntimeProfile;
  readonly resolvedModel: string;
};

export type RoutingValidation =
  | { readonly ok: true; readonly routing: ResolvedRouting }
  | {
      readonly ok: false;
      readonly reason: RoutingRejectionReason;
      readonly message: string;
      readonly offendingFields?: readonly string[];
    };

function reject(
  reason: RoutingRejectionReason,
  message: string,
  offendingFields?: readonly string[],
): RoutingValidation {
  return offendingFields === undefined
    ? { ok: false, reason, message }
    : { ok: false, reason, message, offendingFields };
}

/**
 * 09 section 6: Control Plane validation of a Manager proposal.
 * Rejects outright; never silently clamps to an allowed value.
 */
export function validateManagerProposal(raw: unknown, ctx: RoutingContext): RoutingValidation {
  const parsed = ManagerRoutingProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return reject("malformed_proposal", parsed.error.issues.map((i) => i.message).join("; "));
  }

  const offending = FORBIDDEN_PROPOSAL_FIELDS.filter((f) =>
    Object.prototype.hasOwnProperty.call(parsed.data, f),
  );
  if (offending.length > 0) {
    return reject(
      "forbidden_field",
      `Manager may not specify execution node or credential fields: ${offending.join(", ")}`,
      offending,
    );
  }

  const workerProfile = parsed.data.workerProfile as WorkerProfile;
  if (!WORKER_PROFILES.includes(workerProfile)) {
    return reject("unknown_worker_profile", `unknown worker profile "${parsed.data.workerProfile}"`);
  }

  const runtime: RuntimeProfile = {
    provider: parsed.data.provider,
    modelProfile: parsed.data.modelProfile,
  };

  if (allowedRuntimes(ctx.policy, workerProfile).length === 0) {
    return reject(
      "no_policy_for_worker_profile",
      `workspace model_policy has no worker_profiles entry for "${workerProfile}"`,
    );
  }

  if (!isAllowed(ctx.policy, workerProfile, runtime)) {
    return reject(
      "not_allowed_by_policy",
      `${runtime.provider}-${runtime.modelProfile} is not in the allowed list for "${workerProfile}"`,
    );
  }

  const supported = ctx.capabilities?.supported[runtime.provider];
  if (supported !== undefined && !supported.includes(runtime.modelProfile)) {
    return reject(
      "capability_unsupported",
      `provider ${runtime.provider} cannot serve the ${runtime.modelProfile} profile`,
    );
  }

  const remaining = ctx.quota?.remainingByProvider?.[runtime.provider];
  if (remaining !== undefined && remaining <= 0) {
    return reject("quota_exhausted", `quota exhausted for provider ${runtime.provider}`);
  }

  const key = `${runtime.provider}-${runtime.modelProfile}`;
  if (
    ctx.gates?.requiresApproval?.includes(key) === true &&
    ctx.gates.approvals?.includes(key) !== true
  ) {
    return reject("gate_required", `human approval required before using ${key}`);
  }

  return {
    ok: true,
    routing: { workerProfile, runtime, resolvedModel: resolveModel(ctx.mapping, runtime) },
  };
}
