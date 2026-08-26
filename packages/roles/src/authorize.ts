import type { Role } from "@meidoya/domain";
import {
  ROLE_CAPABILITY_MATRIX,
  type AuthorizationContext,
  type AuthorizationDecision,
  type Capability,
  type DenyReason,
  type ScopeQualifier,
} from "./capabilities.js";

function deny(reason: DenyReason, message: string): AuthorizationDecision {
  return { allowed: false, reason, message };
}

function allow(qualifier: ScopeQualifier): AuthorizationDecision {
  return { allowed: true, qualifier };
}

function targetIsOwn(context: AuthorizationContext): boolean {
  return (
    context.targetWorkspaceId === undefined ||
    context.targetWorkspaceId === context.actorWorkspaceId
  );
}

function checkGrant(context: AuthorizationContext): AuthorizationDecision {
  if (context.delegationGranted !== true) {
    return deny(
      "no-delegation-grant",
      "no delegation grant for the target workspace; it must be treated as non-existent",
    );
  }
  return allow("grant");
}

function checkOwn(context: AuthorizationContext): AuthorizationDecision {
  if (!targetIsOwn(context)) {
    return deny("target-workspace-not-own", "actor is bound to a single workspace");
  }
  return allow("own");
}

function checkScopedStep(
  context: AuthorizationContext,
  capability: Capability,
): AuthorizationDecision {
  const step = context.stepScope;
  if (step === undefined) {
    return deny("step-scope-required", "worker capabilities require a bound step scope");
  }
  if (step.workspaceId !== context.actorWorkspaceId) {
    return deny("step-workspace-mismatch", "step is outside the actor workspace");
  }
  const allowedProjects = context.allowedProjects ?? [];
  if (!allowedProjects.includes(step.projectId)) {
    return deny("project-not-allowed", "project is not in the allowed project set for this step");
  }
  if (capability === "repository.read" && context.repositoryAccess === undefined) {
    return deny("repository-permission-missing", "repository access is not granted");
  }
  if (capability === "repository.read" && context.repositoryAccess === "none") {
    return deny("repository-permission-missing", "repository access is not granted");
  }
  if (capability === "repository.write" && context.repositoryAccess !== "write") {
    return deny("repository-permission-missing", "repository write access is not granted");
  }
  if (capability === "shell" && context.shellAllowed !== true) {
    return deny("shell-permission-missing", "shell is not enabled for this worker");
  }
  return allow("scoped");
}

export function authorize(
  role: Role,
  capability: Capability,
  context: AuthorizationContext,
): AuthorizationDecision {
  const qualifier = ROLE_CAPABILITY_MATRIX[capability][role];

  if (qualifier === "no") {
    const everyoneDenied = (Object.values(ROLE_CAPABILITY_MATRIX[capability]) as ScopeQualifier[])
      .every((entry) => entry === "no");
    if (everyoneDenied) {
      return deny(
        "capability-forbidden-for-everyone",
        `${capability} is not available to any role`,
      );
    }
    return deny("capability-not-in-role", `role ${role} may not use ${capability}`);
  }

  switch (qualifier) {
    case "yes":
      return allow("yes");
    case "grant":
      return checkGrant(context);
    case "own":
      return checkOwn(context);
    case "coordination": {
      if (capability === "task.create") {
        return context.taskScope === "coordination"
          ? allow("coordination")
          : deny("task-scope-not-allowed", "head maid may only create coordination tasks");
      }
      return context.answerScope === "coordination"
        ? allow("coordination")
        : deny("answer-scope-not-allowed", "head maid may only answer coordination tasks");
    }
    case "child-step-only": {
      if (context.taskScope !== "child-step") {
        return deny("task-scope-not-allowed", "manager may only create child step tasks");
      }
      if (context.parentTaskId === undefined) {
        return deny("parent-task-required", "child step tasks require a parent task");
      }
      return allow("child-step-only");
    }
    case "request-only":
      return context.answerScope === "request"
        ? allow("request-only")
        : deny("answer-scope-not-allowed", "manager may only answer its own request");
    case "summary":
      return context.artifactDetail === "full"
        ? deny("artifact-detail-not-allowed", "this role may only read artifact summaries")
        : allow("summary");
    case "full":
      return allow("full");
    case "scoped":
      if (capability === "artifact.read") {
        const step = context.stepScope;
        if (step === undefined) {
          return deny("step-scope-required", "workers may only read artifacts of their own step");
        }
        if (
          context.artifactWorkspaceId !== undefined &&
          context.artifactWorkspaceId !== context.actorWorkspaceId
        ) {
          return deny("step-workspace-mismatch", "artifact is outside the actor workspace");
        }
        return allow("scoped");
      }
      return checkScopedStep(context, capability);
    default:
      return deny("capability-not-in-role", `unhandled qualifier for ${capability}`);
  }
}

export class AuthorizationError extends Error {
  readonly reason: string;

  constructor(role: Role, capability: Capability, decision: AuthorizationDecision) {
    const reason = decision.allowed ? "allowed" : decision.reason;
    super(`${role} denied ${capability}: ${reason}`);
    this.name = "AuthorizationError";
    this.reason = reason;
  }
}

export function assertAuthorized(
  role: Role,
  capability: Capability,
  context: AuthorizationContext,
): void {
  const decision = authorize(role, capability, context);
  if (!decision.allowed) {
    throw new AuthorizationError(role, capability, decision);
  }
}
