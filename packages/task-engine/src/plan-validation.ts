import type {
  ExecutionBudget,
  ExecutionPlan,
  ModelProfile,
  ProjectId,
  Provider,
  WorkerCapability,
  WorkerProfile,
  WorkspacePolicy,
} from "@meidoya/domain";

import {
  DEFAULT_QUALITY_GATES,
  resolveQualityGate,
  type QualityGateCatalog,
} from "./quality-gates.js";

export type PlanRejectionCode =
  | "empty-plan"
  | "duplicate-step-key"
  | "project-not-in-workspace"
  | "project-write-not-granted"
  | "unknown-dependency"
  | "dependency-cycle"
  | "self-dependency"
  | "worker-profile-not-allowed"
  | "model-policy-violation"
  | "capability-not-granted"
  | "gate-policy-violation"
  | "budget-exceeded"
  | "missing-verification"
  | "verification-command-not-allowlisted";

export type PlanRejection = {
  code: PlanRejectionCode;
  message: string;
  stepKey?: string;
  detail?: Record<string, unknown>;
};

export type PlanValidationContext = {
  /** Projects that belong to the task's workspace. */
  workspaceProjectIds: ProjectId[];
  /** Projects the task is allowed to write to. */
  writableProjectIds: ProjectId[];
  workerProfileAllowlist: WorkerProfile[];
  allowedRuntimes: { provider: Provider; modelProfile: ModelProfile }[];
  requestedRuntime: { provider: Provider; modelProfile: ModelProfile };
  grantedCapabilities: WorkerCapability[];
  requestedCapabilities: WorkerCapability[];
  gates: WorkspacePolicy["humanGates"];
  /** Gates a mandatory security policy demands; cannot be relaxed (06 section 2). */
  mandatoryGates: Partial<WorkspacePolicy["humanGates"]>;
  budget: ExecutionBudget;
  stepsAlreadyUsed: number;
  /** Pipelines whose completion is machine-verified need a verification plan. */
  requireVerification: boolean;
  /**
   * The operator's configured quality gates. A plan may only SELECT one of
   * these by name; it can never supply a command line. Defaults to
   * {@link DEFAULT_QUALITY_GATES} when the workspace configured none.
   */
  qualityGates?: QualityGateCatalog;
};

export type PlanValidationResult =
  | { ok: true }
  | { ok: false; rejections: PlanRejection[] };

const CLARIFICATION_RANK: Record<string, number> = { never: 0, "when-needed": 1, always: 2 };
const PLAN_RANK: Record<string, number> = { never: 0, "on-risk": 1, always: 2 };
const REVIEW_RANK: Record<string, number> = {
  never: 0,
  "on-findings": 1,
  "before-complete": 2,
  always: 3,
};
const SIDE_EFFECT_RANK: Record<string, number> = { policy: 0, always: 1 };

function weaker(rank: Record<string, number>, actual: string, mandatory: string): boolean {
  return (rank[actual] ?? 0) < (rank[mandatory] ?? 0);
}

function detectCycle(steps: { key: string; dependsOn: string[] }[]): string[] | undefined {
  const graph = new Map<string, string[]>();
  for (const s of steps) graph.set(s.key, s.dependsOn);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (key: string): string[] | undefined => {
    const mark = state.get(key);
    if (mark === 1) return [...stack.slice(stack.indexOf(key)), key];
    if (mark === 2) return undefined;
    state.set(key, 1);
    stack.push(key);
    for (const dep of graph.get(key) ?? []) {
      if (!graph.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(key, 2);
    return undefined;
  };

  for (const s of steps) {
    const cycle = visit(s.key);
    if (cycle) return cycle;
  }
  return undefined;
}

/** 05 section 4: the Control Plane, not the Manager, decides whether a plan is runnable. */
export function validateExecutionPlan(
  plan: ExecutionPlan,
  ctx: PlanValidationContext,
): PlanValidationResult {
  const rejections: PlanRejection[] = [];

  if (plan.steps.length === 0) {
    rejections.push({ code: "empty-plan", message: "plan has no steps" });
  }

  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.key)) {
      rejections.push({
        code: "duplicate-step-key",
        message: `duplicate step key ${step.key}`,
        stepKey: step.key,
      });
    }
    seen.add(step.key);
  }

  for (const access of plan.projects) {
    if (!ctx.workspaceProjectIds.includes(access.projectId)) {
      rejections.push({
        code: "project-not-in-workspace",
        message: `project ${access.projectId} is not in this workspace`,
        detail: { projectId: access.projectId },
      });
      continue;
    }
    if (access.mode === "write" && !ctx.writableProjectIds.includes(access.projectId)) {
      rejections.push({
        code: "project-write-not-granted",
        message: `write access to ${access.projectId} is not granted`,
        detail: { projectId: access.projectId },
      });
    }
  }

  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.key) {
        rejections.push({
          code: "self-dependency",
          message: `step ${step.key} depends on itself`,
          stepKey: step.key,
        });
        continue;
      }
      if (!seen.has(dep)) {
        rejections.push({
          code: "unknown-dependency",
          message: `step ${step.key} depends on unknown step ${dep}`,
          stepKey: step.key,
        });
      }
    }
  }

  const cycle = detectCycle(plan.steps.map((s) => ({ key: s.key, dependsOn: s.dependsOn })));
  if (cycle) {
    rejections.push({
      code: "dependency-cycle",
      message: `dependency cycle: ${cycle.join(" -> ")}`,
      detail: { cycle },
    });
  }

  for (const step of plan.steps) {
    if (!ctx.workerProfileAllowlist.includes(step.workerProfile)) {
      rejections.push({
        code: "worker-profile-not-allowed",
        message: `worker profile ${step.workerProfile} is not allowed`,
        stepKey: step.key,
      });
    }
  }

  const runtimeAllowed = ctx.allowedRuntimes.some(
    (r) =>
      r.provider === ctx.requestedRuntime.provider &&
      r.modelProfile === ctx.requestedRuntime.modelProfile,
  );
  if (!runtimeAllowed) {
    rejections.push({
      code: "model-policy-violation",
      message: `${ctx.requestedRuntime.provider}/${ctx.requestedRuntime.modelProfile} is not in the model policy`,
      detail: { requested: ctx.requestedRuntime },
    });
  }

  for (const cap of ctx.requestedCapabilities) {
    if (!ctx.grantedCapabilities.includes(cap)) {
      rejections.push({
        code: "capability-not-granted",
        message: `capability ${cap} is not granted`,
        detail: { capability: cap },
      });
    }
  }

  const m = ctx.mandatoryGates;
  if (m.clarification && weaker(CLARIFICATION_RANK, ctx.gates.clarification, m.clarification)) {
    rejections.push({
      code: "gate-policy-violation",
      message: `clarification gate ${ctx.gates.clarification} is weaker than mandatory ${m.clarification}`,
    });
  }
  if (m.plan && weaker(PLAN_RANK, ctx.gates.plan, m.plan)) {
    rejections.push({
      code: "gate-policy-violation",
      message: `plan gate ${ctx.gates.plan} is weaker than mandatory ${m.plan}`,
    });
  }
  if (m.review && weaker(REVIEW_RANK, ctx.gates.review, m.review)) {
    rejections.push({
      code: "gate-policy-violation",
      message: `review gate ${ctx.gates.review} is weaker than mandatory ${m.review}`,
    });
  }
  if (m.sideEffect && weaker(SIDE_EFFECT_RANK, ctx.gates.sideEffect, m.sideEffect)) {
    rejections.push({
      code: "gate-policy-violation",
      message: `side-effect gate ${ctx.gates.sideEffect} is weaker than mandatory ${m.sideEffect}`,
    });
  }
  if (
    ctx.requestedCapabilities.includes("external-side-effect") &&
    ctx.gates.sideEffect !== "always" &&
    !ctx.grantedCapabilities.includes("external-side-effect")
  ) {
    rejections.push({
      code: "gate-policy-violation",
      message: "external side effects require a side-effect gate",
    });
  }

  // 06 section 4: max_steps is a root budget, including steps already spent.
  const projected = ctx.stepsAlreadyUsed + plan.steps.length;
  if (projected > ctx.budget.maxSteps) {
    rejections.push({
      code: "budget-exceeded",
      message: `plan needs ${projected} steps but max_steps is ${ctx.budget.maxSteps}`,
      detail: { projected, maxSteps: ctx.budget.maxSteps },
    });
  }

  if (ctx.requireVerification && plan.verification.commands.length === 0) {
    rejections.push({
      code: "missing-verification",
      message: "pipeline requires a verification plan with at least one command",
    });
  }

  // 10 section 2: the plan selects a gate; the operator owns the argv. Anything
  // the plan names that is not configured never reaches a runner.
  const catalog = ctx.qualityGates ?? DEFAULT_QUALITY_GATES;
  for (const cmd of plan.verification.commands) {
    const resolved = resolveQualityGate(catalog, cmd.name);
    if (resolved.ok) continue;
    rejections.push({
      code: "verification-command-not-allowlisted",
      message:
        resolved.reason === "invalid-selector"
          ? `verification command name ${JSON.stringify(cmd.name)} is not a plain quality-gate name`
          : `verification command ${JSON.stringify(cmd.name)} is not a configured quality gate`,
      detail: {
        name: cmd.name,
        reason: resolved.reason,
        configured: catalog.map((c) => c.name),
      },
    });
  }

  return rejections.length === 0 ? { ok: true } : { ok: false, rejections };
}
