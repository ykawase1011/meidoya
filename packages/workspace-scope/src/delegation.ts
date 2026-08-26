import type { WorkspaceId } from "@meidoya/domain";

export type DelegationCapability =
  | "status.read"
  | "task.delegate"
  | "task-summary.read"
  | "schedule.manage";

export type DelegationSource = WorkspaceId | "global";

export type DelegationGrant = {
  source: DelegationSource;
  target: WorkspaceId;
  capabilities: readonly DelegationCapability[];
};

/**
 * `not-found` is deliberately indistinguishable from "target workspace does not
 * exist": without a grant the target must be invisible, so a caller can never
 * probe for the existence of workspaces it was not granted.
 */
export type DelegationLookup =
  | { outcome: "granted"; capabilities: readonly DelegationCapability[] }
  | { outcome: "not-found" };

export type DelegationCheck =
  | { outcome: "granted"; capability: DelegationCapability }
  | { outcome: "capability-denied"; capability: DelegationCapability }
  | { outcome: "not-found" };

function key(source: DelegationSource, target: WorkspaceId): string {
  return `${source}\u0000${target}`;
}

export class DelegationRegistry {
  readonly #grants: Map<string, readonly DelegationCapability[]>;

  constructor(grants: readonly DelegationGrant[]) {
    this.#grants = new Map();
    for (const grant of grants) {
      const existing = this.#grants.get(key(grant.source, grant.target)) ?? [];
      const merged = new Set<DelegationCapability>([...existing, ...grant.capabilities]);
      this.#grants.set(key(grant.source, grant.target), Object.freeze([...merged].sort()));
    }
  }

  lookup(source: DelegationSource, target: WorkspaceId): DelegationLookup {
    const capabilities = this.#grants.get(key(source, target));
    if (capabilities === undefined || capabilities.length === 0) {
      return { outcome: "not-found" };
    }
    return { outcome: "granted", capabilities };
  }

  check(
    source: DelegationSource,
    target: WorkspaceId,
    capability: DelegationCapability,
  ): DelegationCheck {
    const found = this.lookup(source, target);
    if (found.outcome === "not-found") {
      return { outcome: "not-found" };
    }
    if (!found.capabilities.includes(capability)) {
      return { outcome: "capability-denied", capability };
    }
    return { outcome: "granted", capability };
  }

  visibleTargets(source: DelegationSource): readonly WorkspaceId[] {
    const targets: WorkspaceId[] = [];
    const prefix = `${source}\u0000`;
    for (const [entry, capabilities] of this.#grants) {
      if (entry.startsWith(prefix) && capabilities.length > 0) {
        targets.push(entry.slice(prefix.length));
      }
    }
    return targets.sort();
  }
}
