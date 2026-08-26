import type { AgentRunScope } from "@meidoya/node-protocol";
import { deriveRunScope, ScopeViolationError } from "@meidoya/node-runtime";

export type ControlPlaneGrant = {
  readonly workspaceId: string;
  /** The grant the Control Plane computed for this run (10 section 7). */
  readonly capabilities: readonly string[];
  readonly projectAccess: readonly { projectId: string; mode: "read" | "write" }[];
};

export type LocalNodeGrant = {
  /** Capabilities this node's operator granted, after registration reconcile. */
  readonly capabilities: readonly string[];
  /** Project ids this node actually has a validated binding for. */
  readonly projectIds: readonly string[];
  readonly networkPolicy: string;
};

/**
 * The capabilities a run may hold: the INTERSECTION of the Control Plane's
 * grant and this node's local policy.
 *
 * Never a union and never one side alone. 10 section 6: the Control Plane does
 * not trust a node's self-report, so a node claiming `external-side-effect`
 * gets nothing unless the control plane granted it for this run. 10 section 7:
 * the run scope is derived from the task's workspace, so a control plane (or a
 * tampered activity input) asking for more than the node's operator permits
 * gets nothing either.
 */
export function intersectCapabilities(
  controlPlane: readonly string[],
  local: readonly string[],
): string[] {
  const allowed = new Set(local);
  return [...new Set(controlPlane)].filter((capability) => allowed.has(capability)).sort();
}

/**
 * Builds the authoritative run scope for one Worker run.
 *
 * Fails CLOSED: a run that arrives with no control-plane grant at all is
 * refused rather than silently handed this node's own capabilities, which is
 * exactly the hole that made approving the side-effect gate a no-op.
 */
export function buildWorkerRunScope(
  controlPlane: ControlPlaneGrant,
  local: LocalNodeGrant,
): AgentRunScope {
  const capabilities = intersectCapabilities(controlPlane.capabilities, local.capabilities);
  if (controlPlane.capabilities.length === 0) {
    throw new ScopeViolationError(
      `run for workspace ${controlPlane.workspaceId} carries no control-plane capability grant`,
    );
  }

  const bound = new Set(local.projectIds);
  const canWrite = capabilities.includes("repo.write");
  const projectAccess =
    controlPlane.projectAccess.length === 0
      ? // A plan that named no project still needs a cwd. Read-only on this
        // node's own bindings is a narrowing, never an escalation.
        [...local.projectIds].sort().map((projectId) => ({
          projectId,
          mode: "read" as const,
        }))
      : controlPlane.projectAccess
          .filter((access) => bound.has(access.projectId))
          .map((access) => ({
            projectId: access.projectId,
            mode: (access.mode === "write" && canWrite ? "write" : "read") as "read" | "write",
          }));

  return deriveRunScope({
    workspaceId: controlPlane.workspaceId,
    projectAccess,
    capabilities,
    // Network egress is part of the grant, not a standing node property: a run
    // that was not granted `network` gets none whatever the node config says.
    networkPolicy: capabilities.includes("network") ? local.networkPolicy : "none",
    // 06 section 1.4: only a human answer at the side-effect gate can turn
    // this to "allow", and it arrives here as a capability, not as prose.
    sideEffectPolicy: capabilities.includes("external-side-effect") ? "allow" : "deny",
  });
}
