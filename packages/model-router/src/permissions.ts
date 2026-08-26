import {
  ROLE_CAPABILITIES,
  type ActorSpec,
  type WorkerCapability,
  type WorkerProfile,
} from "@meidoya/domain";

/**
 * 09 section 9: the maximum capability set a WorkerProfile may ever hold.
 * Head Maid / Maid / Manager hold none of these at all.
 */
export const WORKER_PROFILE_CAPABILITIES: Record<WorkerProfile, readonly WorkerCapability[]> = {
  researcher: ["repo.read", "network"],
  // `network` and `external-side-effect` are in the implementer's MAXIMUM, not
  // in its grant: a step only receives them when the control plane put them in
  // its run scope, which only happens after a human answered the side-effect
  // gate. Leaving them out of the maximum was what made that answer inert —
  // `derivePermissions` filtered the approved capability straight back out.
  implementer: [
    "repo.read",
    "repo.write",
    "shell",
    "package-install",
    "network",
    "external-side-effect",
  ],
  reviewer: ["repo.read"],
  "security-reviewer": ["repo.read"],
  tester: ["repo.read", "shell"],
  "mechanical-editor": ["repo.read", "repo.write"],
};

/**
 * Capabilities that only mean anything once a human has approved an effect
 * outside the workspace, plus the one that says so.
 */
const EXTERNAL_REACH: readonly WorkerCapability[] = ["network", "browser", "package-install"];

/**
 * Narrows a granted capability set to what may actually reach the vendor
 * runtime's permission surface.
 *
 * `external-side-effect` maps to no vendor flag of its own, so on its own it
 * would be a label. What it means here is: WITHOUT it, a run that can also
 * write the repository or run a shell gets no external reach at all. That is
 * the difference between `codex --sandbox danger-full-access` and
 * `workspace-write`, and between Claude's `WebFetch`/`WebSearch` sitting in
 * `--allowedTools` and sitting in `--disallowedTools`.
 *
 * A read-only researcher keeps `network`: fetching a document is not the side
 * effect 06 section 1.4 is about. Egress from a step that can also execute or
 * write is, because nothing downstream can tell `curl` from `curl -X POST`.
 */
export function containCapabilities(
  capabilities: readonly WorkerCapability[],
): WorkerCapability[] {
  if (capabilities.includes("external-side-effect")) return [...capabilities];
  const canAct = capabilities.includes("repo.write") || capabilities.includes("shell");
  if (!canAct) return [...capabilities];
  return capabilities.filter((capability) => !EXTERNAL_REACH.includes(capability));
}

export type StepCapabilityRequest = {
  readonly stepKey?: string;
  readonly requested: readonly WorkerCapability[];
};

export type DerivedPermissions = {
  readonly capabilities: readonly WorkerCapability[];
  /** Scoped Control Plane tools; the only surface a coordinating role gets. */
  readonly controlPlaneTools: readonly string[];
  readonly shell: boolean;
  readonly filesystemWrite: boolean;
  readonly repositoryAccess: "none" | "read" | "write";
  readonly denied: readonly WorkerCapability[];
  /** Outbound network reach at the vendor permission surface. */
  readonly network: boolean;
  /** True only when a human approved an effect outside the workspace. */
  readonly externalSideEffect: boolean;
};

/**
 * Derives the permitted capability set. Coordinating roles are hard-coded to
 * the empty set: no shell, no filesystem write, no repository access, whatever
 * the caller asks for.
 */
export function derivePermissions(
  actor: ActorSpec,
  step: StepCapabilityRequest = { requested: [] },
): DerivedPermissions {
  if (actor.role !== "worker") {
    return {
      capabilities: [],
      controlPlaneTools: ROLE_CAPABILITIES[actor.role],
      shell: false,
      filesystemWrite: false,
      repositoryAccess: "none",
      denied: [...step.requested],
      network: false,
      externalSideEffect: false,
    };
  }

  const max = WORKER_PROFILE_CAPABILITIES[actor.profile];
  // Two independent narrowings, in order: the profile's maximum, then the
  // containment that a missing side-effect approval imposes.
  const granted = containCapabilities(step.requested.filter((c) => max.includes(c)));
  const denied = step.requested.filter((c) => !granted.includes(c));

  return {
    capabilities: granted,
    network: granted.includes("network"),
    externalSideEffect: granted.includes("external-side-effect"),
    controlPlaneTools: ROLE_CAPABILITIES.worker,
    shell: granted.includes("shell"),
    filesystemWrite: granted.includes("repo.write"),
    repositoryAccess: granted.includes("repo.write")
      ? "write"
      : granted.includes("repo.read")
        ? "read"
        : "none",
    denied,
  };
}

export function maxCapabilitiesFor(actor: ActorSpec): readonly WorkerCapability[] {
  return actor.role === "worker" ? WORKER_PROFILE_CAPABILITIES[actor.profile] : [];
}
