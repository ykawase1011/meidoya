import {
  NODE_PROTOCOL_VERSION,
  type ExecutionNode,
  type NodeArchitecture,
  type NodePlatform,
  type NodeProfile,
  type NodeRegistration,
} from "@meidoya/node-protocol";

/**
 * Local (Control Plane) policy for a known node. Everything here comes from
 * operator configuration, never from the node itself.
 */
export type LocalNodePolicy = {
  nodeId: string;
  allowedProfiles: NodeProfile[];
  /** Capabilities the operator is willing to grant this node. */
  allowedCapabilities: string[];
  /** Workspaces the operator has bound to this node. */
  allowedWorkspaces: string[];
  maxConcurrencyCeiling: number;
  /** Optional pin: a node claiming a different platform/arch is rejected. */
  expectedPlatform?: NodePlatform;
  expectedArch?: NodeArchitecture;
  supportedProtocolVersions?: number[];
};

export type ReconciliationResult = {
  accepted: boolean;
  node: ExecutionNode | undefined;
  grantedCapabilities: string[];
  grantedWorkspaces: string[];
  strippedCapabilities: string[];
  strippedWorkspaces: string[];
  maxConcurrency: number;
  rejections: string[];
};

/**
 * Control Plane reconciliation (10 section 6): the node's self-report is
 * treated as a *claim*. Anything not independently allowed by local policy is
 * stripped, and identity-level mismatches reject the registration outright.
 */
export function reconcileRegistration(
  registration: NodeRegistration,
  policies: readonly LocalNodePolicy[],
): ReconciliationResult {
  const rejections: string[] = [];
  const policy = policies.find((p) => p.nodeId === registration.nodeId);

  if (policy === undefined) {
    return denied([`unknown node "${registration.nodeId}": no local policy`]);
  }

  const supported = policy.supportedProtocolVersions ?? [NODE_PROTOCOL_VERSION];
  if (!supported.includes(registration.protocolVersion)) {
    rejections.push(
      `protocol version ${registration.protocolVersion} is not supported (${supported.join(", ")})`,
    );
  }
  if (!policy.allowedProfiles.includes(registration.profile)) {
    rejections.push(`profile "${registration.profile}" is not allowed`);
  }
  if (
    policy.expectedPlatform !== undefined &&
    policy.expectedPlatform !== registration.platform
  ) {
    rejections.push(
      `platform mismatch: claimed ${registration.platform}, policy expects ${policy.expectedPlatform}`,
    );
  }
  if (
    policy.expectedArch !== undefined &&
    policy.expectedArch !== registration.arch
  ) {
    rejections.push(
      `arch mismatch: claimed ${registration.arch}, policy expects ${policy.expectedArch}`,
    );
  }

  const allowedCapabilities = new Set(policy.allowedCapabilities);
  const grantedCapabilities = registration.capabilities
    .filter((c) => allowedCapabilities.has(c))
    .sort();
  const strippedCapabilities = registration.capabilities
    .filter((c) => !allowedCapabilities.has(c))
    .sort();

  const allowedWorkspaces = new Set(policy.allowedWorkspaces);
  const grantedWorkspaces = registration.workspaceBindings
    .filter((w) => allowedWorkspaces.has(w))
    .sort();
  const strippedWorkspaces = registration.workspaceBindings
    .filter((w) => !allowedWorkspaces.has(w))
    .sort();

  for (const capability of strippedCapabilities) {
    rejections.push(`capability "${capability}" is not granted by local policy`);
  }
  for (const workspace of strippedWorkspaces) {
    rejections.push(`workspace "${workspace}" is not bound to this node`);
  }

  const maxConcurrency = Math.max(
    1,
    Math.min(registration.maxConcurrency, policy.maxConcurrencyCeiling),
  );

  const fatal =
    !supported.includes(registration.protocolVersion) ||
    !policy.allowedProfiles.includes(registration.profile) ||
    (policy.expectedPlatform !== undefined &&
      policy.expectedPlatform !== registration.platform) ||
    (policy.expectedArch !== undefined &&
      policy.expectedArch !== registration.arch);

  if (fatal) {
    return {
      accepted: false,
      node: undefined,
      grantedCapabilities: [],
      grantedWorkspaces: [],
      strippedCapabilities: [...registration.capabilities].sort(),
      strippedWorkspaces: [...registration.workspaceBindings].sort(),
      maxConcurrency: 0,
      rejections,
    };
  }

  const node: ExecutionNode = {
    id: registration.nodeId,
    protocolVersion: registration.protocolVersion,
    platform: policy.expectedPlatform ?? registration.platform,
    architecture: policy.expectedArch ?? registration.arch,
    profile: registration.profile,
    capabilities: grantedCapabilities,
    allowedWorkspaces: grantedWorkspaces,
    maxConcurrency,
    status: "online",
  };

  return {
    accepted: true,
    node,
    grantedCapabilities,
    grantedWorkspaces,
    strippedCapabilities,
    strippedWorkspaces,
    maxConcurrency,
    rejections,
  };
}

function denied(rejections: string[]): ReconciliationResult {
  return {
    accepted: false,
    node: undefined,
    grantedCapabilities: [],
    grantedWorkspaces: [],
    strippedCapabilities: [],
    strippedWorkspaces: [],
    maxConcurrency: 0,
    rejections,
  };
}

/** Routing check uses the reconciled node record, not the node's claim. */
export function canNodeRunWorkspace(
  node: ExecutionNode,
  workspaceId: string,
): boolean {
  return node.status !== "offline" && node.allowedWorkspaces.includes(workspaceId);
}
