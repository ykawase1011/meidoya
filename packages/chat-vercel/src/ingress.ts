import type { WorkspaceId } from "@meidoya/domain";
import type { InboundChatEvent } from "./platform-client.js";

/** `ingress_bindings.source` (schema-outline.sql). */
export type IngressSource = "slack" | "discord" | "cli" | "http";

/** One `ingress_bindings` row. `null` means "not constrained on this column". */
export type IngressBinding = {
  id: string;
  workspaceId: WorkspaceId;
  source: IngressSource;
  accountRef: string | null;
  channelRef: string | null;
  profileRef: string | null;
  enabled: boolean;
};

/**
 * The ONLY facts allowed to decide a workspace (04 section 8, 01 section 3).
 * Note there is no `text` field: message content is structurally incapable of
 * reaching binding resolution, so no prompt injection can redirect a workspace.
 */
export type IngressKey = {
  source: IngressSource;
  accountRef: string | null;
  channelRef: string | null;
  profileRef: string | null;
};

export type IngressRejectionReason =
  | "no-binding"
  | "binding-disabled"
  | "ambiguous-binding"
  | "unsupported-source";

export type IngressResolution =
  | { ok: true; binding: IngressBinding; workspaceId: WorkspaceId }
  | { ok: false; reason: IngressRejectionReason; key: IngressKey };

export class InvalidIngressBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIngressBindingError";
  }
}

export interface IngressBindingDirectory {
  /** Rows for a source, in no particular order. Resolution does the matching. */
  list(source: IngressSource): readonly IngressBinding[];
}

/**
 * A binding constrained on neither account nor channel would be a catch-all
 * default workspace, which is exactly what fail-closed forbids.
 */
export function assertBindable(binding: IngressBinding): void {
  if (binding.accountRef === null && binding.channelRef === null) {
    throw new InvalidIngressBindingError(
      `ingress binding ${binding.id} constrains neither account nor channel`
    );
  }
}

export class InMemoryIngressBindingDirectory implements IngressBindingDirectory {
  private readonly bySource = new Map<IngressSource, IngressBinding[]>();

  constructor(bindings: readonly IngressBinding[] = []) {
    for (const binding of bindings) this.register(binding);
  }

  register(binding: IngressBinding): void {
    assertBindable(binding);
    const rows = this.bySource.get(binding.source) ?? [];
    const duplicate = rows.some(
      (r) =>
        r.accountRef === binding.accountRef &&
        r.channelRef === binding.channelRef &&
        r.profileRef === binding.profileRef
    );
    if (duplicate) {
      throw new InvalidIngressBindingError(
        `duplicate ingress binding tuple for ${binding.source}`
      );
    }
    rows.push(binding);
    this.bySource.set(binding.source, rows);
  }

  list(source: IngressSource): readonly IngressBinding[] {
    return this.bySource.get(source) ?? [];
  }
}

function matches(value: string | null, candidate: string | null): boolean {
  return candidate === null || candidate === value;
}

function specificity(binding: IngressBinding): number {
  return (
    (binding.channelRef === null ? 0 : 4) +
    (binding.accountRef === null ? 0 : 2) +
    (binding.profileRef === null ? 0 : 1)
  );
}

/**
 * Fail-closed resolution: only an enabled binding whose constrained columns all
 * equal the inbound routing tuple yields a workspace. No fallback, no default.
 */
export function resolveIngressBinding(
  directory: IngressBindingDirectory,
  key: IngressKey
): IngressResolution {
  const candidates = directory
    .list(key.source)
    .filter(
      (b) =>
        matches(key.accountRef, b.accountRef) &&
        matches(key.channelRef, b.channelRef) &&
        matches(key.profileRef, b.profileRef)
    );

  if (candidates.length === 0) return { ok: false, reason: "no-binding", key };

  const maxSpecificity = Math.max(...candidates.map(specificity));
  const top = candidates.filter((b) => specificity(b) === maxSpecificity);
  if (top.length > 1) return { ok: false, reason: "ambiguous-binding", key };

  const binding = top[0];
  if (binding === undefined) return { ok: false, reason: "no-binding", key };
  if (!binding.enabled) return { ok: false, reason: "binding-disabled", key };
  return { ok: true, binding, workspaceId: binding.workspaceId };
}

const SOURCE_BY_TRANSPORT: Readonly<Record<string, IngressSource>> = {
  slack: "slack",
  discord: "discord",
  cli: "cli",
};

/** Extracts the routing tuple from an inbound event, dropping the text entirely. */
export function ingressKeyOf(
  event: InboundChatEvent,
  profileRef: string | null = event.profileRef ?? null
): IngressKey | undefined {
  const source = SOURCE_BY_TRANSPORT[event.transport];
  if (source === undefined) return undefined;
  return {
    source,
    accountRef: event.accountRef,
    // Threads bind through their parent channel, never through the thread id.
    channelRef: event.parentChannelRef ?? event.channelRef,
    profileRef,
  };
}
