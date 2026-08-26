import {
  AgentRunScopeSchema,
  type AgentRunScope,
  type RunRequest,
} from "@meidoya/node-protocol";

export type TaskScopeSource = {
  /** Comes from the Task's immutable workspace binding, never from a prompt. */
  workspaceId: string;
  projectAccess: { projectId: string; mode: "read" | "write" }[];
  capabilities: string[];
  networkPolicy: string;
  sideEffectPolicy: string;
};

/**
 * Run scope is derived from the Task's workspace (10 section 7). Nothing the
 * worker says can widen it.
 */
export function deriveRunScope(source: TaskScopeSource): AgentRunScope {
  return AgentRunScopeSchema.parse({
    workspaceId: source.workspaceId,
    projectAccess: [...source.projectAccess]
      .map((p) => ({ projectId: p.projectId, mode: p.mode }))
      .sort((a, b) => a.projectId.localeCompare(b.projectId)),
    capabilities: [...new Set(source.capabilities)].sort(),
    networkPolicy: source.networkPolicy,
    sideEffectPolicy: source.sideEffectPolicy,
  });
}

export type ScopeEscalationAttempt = {
  field: string;
  claimed: string;
  authoritative: string;
};

export type SealedRunRequest = {
  request: RunRequest;
  /** Escalation attempts observed and dropped; logged, never honoured. */
  ignoredEscalations: ScopeEscalationAttempt[];
};

/**
 * Overwrites whatever scope a request carries with the authoritative scope.
 * Used on the node right before execution, so a prompt-injected scope (or a
 * tampered request field) is discarded rather than merged.
 */
export function sealRunScope(
  request: RunRequest,
  authoritative: AgentRunScope,
): SealedRunRequest {
  const ignored: ScopeEscalationAttempt[] = [];
  const claimed = request.scope;

  if (claimed.workspaceId !== authoritative.workspaceId) {
    ignored.push({
      field: "workspaceId",
      claimed: claimed.workspaceId,
      authoritative: authoritative.workspaceId,
    });
  }
  for (const capability of claimed.capabilities) {
    if (!authoritative.capabilities.includes(capability)) {
      ignored.push({
        field: "capabilities",
        claimed: capability,
        authoritative: authoritative.capabilities.join(","),
      });
    }
  }
  for (const access of claimed.projectAccess) {
    const granted = authoritative.projectAccess.find(
      (p) => p.projectId === access.projectId,
    );
    if (granted === undefined || (access.mode === "write" && granted.mode !== "write")) {
      ignored.push({
        field: "projectAccess",
        claimed: `${access.projectId}:${access.mode}`,
        authoritative: granted === undefined ? "none" : `${granted.projectId}:${granted.mode}`,
      });
    }
  }
  if (claimed.networkPolicy !== authoritative.networkPolicy) {
    ignored.push({
      field: "networkPolicy",
      claimed: claimed.networkPolicy,
      authoritative: authoritative.networkPolicy,
    });
  }
  if (claimed.sideEffectPolicy !== authoritative.sideEffectPolicy) {
    ignored.push({
      field: "sideEffectPolicy",
      claimed: claimed.sideEffectPolicy,
      authoritative: authoritative.sideEffectPolicy,
    });
  }

  return {
    request: { ...request, scope: authoritative },
    ignoredEscalations: ignored,
  };
}

export function hasCapability(
  scope: AgentRunScope,
  capability: string,
): boolean {
  return scope.capabilities.includes(capability);
}

export function projectMode(
  scope: AgentRunScope,
  projectId: string,
): "read" | "write" | "none" {
  return (
    scope.projectAccess.find((p) => p.projectId === projectId)?.mode ?? "none"
  );
}

export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolationError";
  }
}

/**
 * Fail closed on a capability the run does not hold. Called by
 * `SandboxRunAssignment` before it hands a run a working directory.
 */
export function assertCapability(
  scope: AgentRunScope,
  capability: string,
): void {
  if (!hasCapability(scope, capability)) {
    throw new ScopeViolationError(
      `capability "${capability}" is not in the run scope`,
    );
  }
}

/** The capability that must back any project handed out in write mode. */
export const REPO_WRITE_CAPABILITY = "repo.write";

/*
 * There is deliberately no `assertProjectWrite` here.
 *
 * It existed and had no production caller, because nothing on the node has an
 * "I am about to write to project X" signal that is independent of
 * `scope.projectAccess`: asserting write mode on the project the scope itself
 * named is a tautology that no mutation can make fail. The one non-tautological
 * check the node CAN make is the cross-field one above — write mode must be
 * backed by `repo.write` — and that is what `SandboxRunAssignment` now runs.
 *
 * If a caller ever gains a real write signal (a step kind, or a worker profile
 * that declares it edits the repo), reintroduce the assertion there, driven by
 * that signal — not by re-reading the field it is supposed to check.
 */
