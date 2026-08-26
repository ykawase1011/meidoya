import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MeidoyaDatabase } from "@meidoya/store-sqlite";
import type { Role } from "@meidoya/domain";
import type { ResolvedScope } from "@meidoya/protocol";
import type { IngressBinding, IngressSource } from "@meidoya/chat-vercel";
import { InMemoryIngressBindingDirectory, resolveIngressBinding } from "@meidoya/chat-vercel";
import {
  deriveWorkspaceScope,
  mintScopeToken,
  scopeSecretFrom,
  verifyScopeToken,
  type ScopeSecret,
} from "@meidoya/workspace-scope";
import { authorize, type AuthorizationContext, type Capability } from "@meidoya/roles";
import { CLI_ACCOUNT_REF, type ResolvedControlPlaneConfig } from "./config.js";
import { ClientCredentialStore } from "./client-credentials.js";

/**
 * Control Plane method capability -> role capability (04 section 7). Cancelling
 * and answering a checkpoint are both "answering the task's control channel",
 * so they share `task.answer`. Anything unmapped is denied: fail closed.
 */
const METHOD_CAPABILITIES: Readonly<Record<string, Capability>> = {
  "task.create": "task.create",
  "task.answer": "task.answer",
  "task.cancel": "task.answer",
  "checkpoint.answer": "task.answer",
  "schedule.manage": "schedule.manage",
  "workspace.status.read": "workspace.status.read",
};

/**
 * Audience of a Control Plane session token. Signed into the token and required
 * on verify, so a token minted for another plane (or another environment) is
 * structurally unusable here even if the HMAC key were shared.
 */
export const CONTROL_PLANE_AUDIENCE = "meidoya:control-plane:session";

/** Sessions are interactive; hours, not days, and never unbounded. */
export const DEFAULT_SCOPE_TOKEN_TTL_MS = 8 * 60 * 60 * 1_000;

export type SessionIdentity = {
  source: IngressSource;
  accountRef: string | null;
  channelRef: string | null;
  profileRef: string | null;
};

export type ScopeGrant = {
  scopeToken: string;
  workspaceId: string;
  projects: string[];
  role: Role;
  expiresAt: number;
};

/**
 * One reason, always. A caller must not be able to tell "that workspace does
 * not exist here" from "that workspace exists and you are not it".
 */
export type ScopeRejection = { reason: "no-binding" };

const REJECTED: ScopeRejection = { reason: "no-binding" };

/** Binding id that can never exist, used to keep a miss as costly as a hit. */
const NO_SUCH_BINDING = "\u0000no-such-binding";

export type WorkspaceStatus = "active" | "suspended" | "retired";

/** What revocation applies to: this one binding, or the whole workspace. */
export type RevocationScope = "session" | "workspace";

export type RevocationResult = {
  workspaceId: string;
  scope: RevocationScope;
  /** Number of bindings whose epoch was bumped. */
  revoked: number;
};

/** One persisted binding epoch row. */
export type BindingEpochRecord = {
  bindingId: string;
  workspaceId: string;
  epoch: number;
  /** Digest of the binding's session credential; never the credential itself. */
  credentialFingerprint: string | null;
};

/**
 * Durable home of the revocation epochs. Without one, revocation lives only as
 * long as the process: a token revoked at 09:00 would verify again the moment
 * the daemon restarts, for the rest of its eight-hour lifetime.
 */
export type BindingEpochStore = {
  load(): BindingEpochRecord[];
  put(record: BindingEpochRecord): void;
};

/** SQLite-backed epoch store (migration 0003). */
export function createSqliteBindingEpochStore(db: MeidoyaDatabase): BindingEpochStore {
  return {
    load(): BindingEpochRecord[] {
      const rows = db
        .prepare(
          "SELECT binding_id, workspace_id, epoch, credential_fingerprint FROM binding_epochs",
        )
        .all() as {
        binding_id: string;
        workspace_id: string;
        epoch: number;
        credential_fingerprint: string | null;
      }[];
      return rows.map((row) => ({
        bindingId: row.binding_id,
        workspaceId: row.workspace_id,
        epoch: row.epoch,
        credentialFingerprint: row.credential_fingerprint,
      }));
    },
    put(record: BindingEpochRecord): void {
      db.prepare(
        `INSERT INTO binding_epochs (binding_id, workspace_id, epoch, credential_fingerprint, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(binding_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           epoch = excluded.epoch,
           credential_fingerprint = excluded.credential_fingerprint,
           updated_at = excluded.updated_at`,
      ).run(
        record.bindingId,
        record.workspaceId,
        record.epoch,
        record.credentialFingerprint,
        Date.now(),
      );
    },
  };
}

export type ScopeRegistryOptions = {
  credentials?: ClientCredentialStore;
  audience?: string;
  tokenTtlMs?: number;
  /** Durable epoch storage. Omitted in unit tests that never restart. */
  epochs?: BindingEpochStore;
  /**
   * Routes an epoch write. The daemon hands in the serial write queue so an
   * epoch row can never join (and be rolled back with) another component's open
   * transaction. Defaults to writing inline.
   */
  persist?: (write: () => void) => void;
};

function ttlFromEnv(): number | undefined {
  const raw = process.env["MEIDOYA_SCOPE_TOKEN_TTL_MS"];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Mints and verifies scope tokens. The workspace of a request is decided here
 * from immutable ingress binding rows and nothing else (04 section 8): no
 * request payload, prompt or agent output participates.
 *
 * Two properties beyond that, both enforced on every call:
 *
 * - a token is only minted for a caller that proved possession of the binding's
 *   credential (see client-credentials.ts); asserting the routing tuple is not
 *   enough and never was meant to be;
 * - a token is only accepted while its binding is still enabled at the epoch it
 *   was issued under and its signed lifetime has not run out.
 */
export class ScopeRegistry {
  readonly #directory: InMemoryIngressBindingDirectory;
  readonly #secret: ScopeSecret;
  readonly #projectsByWorkspace = new Map<string, string[]>();
  readonly #coordinationWorkspaces = new Set<string>();
  readonly #bindings = new Map<string, IngressBinding>();
  /** Bumped whenever a binding is disabled, re-enabled, removed or revoked. */
  readonly #epochs = new Map<string, number>();
  readonly #workspaceStatus = new Map<string, WorkspaceStatus>();
  readonly #credentials: ClientCredentialStore;
  readonly #environmentId: string;
  readonly #audience: string;
  readonly #ttlMs: number;
  /** Credential digest last written per binding, so a bump preserves it. */
  readonly #fingerprints = new Map<string, string | null>();
  readonly #epochStore: BindingEpochStore | undefined;
  readonly #persist: (write: () => void) => void;

  constructor(
    config: ResolvedControlPlaneConfig,
    secret: ScopeSecret,
    options: ScopeRegistryOptions = {},
  ) {
    // The directory keeps the same binding objects, so toggling `enabled` here
    // is what resolution sees.
    const bindings = config.ingressBindings.map((binding) => ({ ...binding }));
    this.#directory = new InMemoryIngressBindingDirectory(bindings);
    // Before the loop below: it fingerprints each binding's credential, and the
    // store is the only thing that knows which FILE a binding's secret came
    // from. Deriving that path here a second time is what let two bindings
    // sharing an ingress profile share a secret (see client-credentials.ts).
    this.#credentials = options.credentials ?? ClientCredentialStore.fromEntries([]);
    this.#epochStore = options.epochs;
    this.#persist = options.persist ?? ((write) => write());
    // Epochs are reloaded before the first token can be minted or verified, so
    // a revocation performed by a previous process is already in force here.
    const persisted = new Map<string, BindingEpochRecord>(
      (this.#epochStore?.load() ?? []).map((row) => [row.bindingId, row]),
    );
    for (const binding of bindings) {
      this.#bindings.set(binding.id, binding);
      const fingerprint = this.#credentials.fingerprintOf(binding.id);
      this.#fingerprints.set(binding.id, fingerprint);
      const row = persisted.get(binding.id);
      if (row === undefined) {
        this.#epochs.set(binding.id, 1);
        this.#writeEpoch(binding, 1, fingerprint);
        continue;
      }
      // A rotated credential must not leave sessions minted under the old one
      // usable, and nothing else in the system would notice the rotation.
      const rotated = row.credentialFingerprint !== fingerprint;
      const epoch = rotated ? row.epoch + 1 : row.epoch;
      this.#epochs.set(binding.id, epoch);
      if (rotated) this.#writeEpoch(binding, epoch, fingerprint);
    }
    this.#secret = secret;
    this.#environmentId = config.environmentId;
    this.#audience = options.audience ?? CONTROL_PLANE_AUDIENCE;
    this.#ttlMs = options.tokenTtlMs ?? ttlFromEnv() ?? DEFAULT_SCOPE_TOKEN_TTL_MS;
    for (const workspace of config.workspaces) {
      this.#projectsByWorkspace.set(workspace.workspaceId, workspace.projects);
      this.#workspaceStatus.set(workspace.workspaceId, "active");
      if (workspace.kind === "coordination") {
        this.#coordinationWorkspaces.add(workspace.workspaceId);
      }
    }
    if (config.headMaid?.enabled === true) {
      this.#coordinationWorkspaces.add(config.headMaid.workspaceId);
    }
  }

  get tokenTtlMs(): number {
    return this.#ttlMs;
  }

  /**
   * Sole entry point for a local client obtaining a token. The routing tuple
   * selects a candidate binding; the credential decides whether the caller is
   * allowed to be that binding. Both must hold, and every failure looks alike.
   */
  mint(
    identity: SessionIdentity,
    credential: string | undefined,
    now: number = Date.now(),
  ): ScopeGrant | ScopeRejection {
    const resolution = resolveIngressBinding(this.#directory, {
      source: identity.source,
      // A CLI client is always the local host; only its profile selects a row.
      accountRef: identity.source === "cli" ? CLI_ACCOUNT_REF : identity.accountRef,
      channelRef: identity.channelRef,
      profileRef: identity.profileRef,
    });
    if (!resolution.ok) {
      // Still pay for a comparison so a miss is not measurably cheaper.
      this.#credentials.verify(NO_SUCH_BINDING, credential);
      return REJECTED;
    }
    if (!this.#credentials.verify(resolution.binding.id, credential)) {
      return REJECTED;
    }
    return this.mintForBinding(resolution.binding, now);
  }

  /**
   * Mints for a binding that has already been authenticated by its own channel
   * (a platform-verified chat event). Not reachable from the socket.
   */
  mintForBinding(binding: IngressBinding, now: number = Date.now()): ScopeGrant | ScopeRejection {
    if (!binding.enabled) return REJECTED;
    if ((this.#workspaceStatus.get(binding.workspaceId) ?? "active") !== "active") return REJECTED;
    const projects = this.#projectsByWorkspace.get(binding.workspaceId) ?? [];
    const derived = deriveWorkspaceScope(
      {
        channel: binding.source === "http" ? "internal" : binding.source,
        accountRef: binding.accountRef ?? "",
        externalRef: binding.channelRef ?? binding.profileRef ?? binding.id,
        workspaceId: binding.workspaceId,
        projects,
      },
      now,
    );
    if (!derived.ok) return REJECTED;
    const expiresAt = now + this.#ttlMs;
    return {
      scopeToken: mintScopeToken(derived.scope, this.#secret, {
        environmentId: this.#environmentId,
        audience: this.#audience,
        bindingId: binding.id,
        bindingEpoch: this.#epochs.get(binding.id) ?? 1,
        expiresAt,
      }),
      workspaceId: binding.workspaceId,
      projects,
      role: this.roleFor(binding.workspaceId),
      expiresAt,
    };
  }

  roleFor(workspaceId: string): Role {
    return this.#coordinationWorkspaces.has(workspaceId) ? "head-maid" : "maid";
  }

  /**
   * Server-side resolution. A token that does not verify, has run out, or was
   * issued under a superseded binding epoch yields nothing.
   */
  resolve(token: string, now: number = Date.now()): ResolvedScope | undefined {
    const verified = verifyScopeToken(token, this.#secret, {
      environmentId: this.#environmentId,
      audience: this.#audience,
      now,
    });
    if (!verified.ok) return undefined;
    const workspaceId = verified.scope.workspaceId;
    if (!this.#projectsByWorkspace.has(workspaceId)) return undefined;
    if ((this.#workspaceStatus.get(workspaceId) ?? "active") !== "active") return undefined;

    const binding = this.#bindings.get(verified.claims.bindingId);
    if (binding === undefined || !binding.enabled) return undefined;
    // The token signs the workspace and the binding as two SEPARATE claims, and
    // this is where they are made to agree. It is not redundant with the id
    // `config.ts` happens to build (`${source}:${workspaceId}`, from which the
    // workspace could be read back): that convention belongs to another module
    // and nothing here may depend on it. Resolution has to hold for any binding
    // id — one supplied by a future ingress source, a renamed row, a token
    // minted with a mismatched pair — and a token whose two claims disagree
    // names two workspaces at once. It resolves to neither.
    if (binding.workspaceId !== workspaceId) return undefined;
    if ((this.#epochs.get(binding.id) ?? 0) !== verified.claims.bindingEpoch) return undefined;

    return {
      workspaceId,
      role: this.roleFor(workspaceId),
      capabilities: Object.keys(METHOD_CAPABILITIES),
    };
  }

  /* ------------------------------------------------------------ revocation */

  /**
   * The reachable revocation surface: `session.revoke` on the socket and
   * `meidoya admin revoke` on the CLI both land here.
   *
   * Authenticated exactly like `mint`, and deliberately so. Possession of a
   * binding's own credential is what proves the caller is that binding, and it
   * is the only thing that can revoke it. There is no ambient operator identity
   * on this socket to check instead, and a *scope token* must not be enough:
   * revocation has to stay available to a caller who believes their token was
   * stolen, and must not be available to whoever stole it.
   *
   * `scope: "workspace"` widens it to every binding of the caller's workspace —
   * a Slack binding of the same workspace cannot present a credential here, so
   * this is the only way its sessions can be cut.
   */
  revoke(
    identity: SessionIdentity,
    credential: string | undefined,
    options: { scope?: RevocationScope; disable?: boolean } = {},
  ): RevocationResult | ScopeRejection {
    const resolution = resolveIngressBinding(this.#directory, {
      source: identity.source,
      accountRef: identity.source === "cli" ? CLI_ACCOUNT_REF : identity.accountRef,
      channelRef: identity.channelRef,
      profileRef: identity.profileRef,
    });
    if (!resolution.ok) {
      // Same constant-cost miss as `mint`: revocation must not become an oracle
      // for which bindings exist.
      this.#credentials.verify(NO_SUCH_BINDING, credential);
      return REJECTED;
    }
    if (!this.#credentials.verify(resolution.binding.id, credential)) return REJECTED;

    const binding = resolution.binding;
    const scope: RevocationScope = options.scope ?? "session";
    if (scope === "workspace") {
      const revoked = this.revokeWorkspace(binding.workspaceId, options.disable ?? false);
      return { workspaceId: binding.workspaceId, scope, revoked };
    }
    if (options.disable === true) binding.enabled = false;
    this.#bumpEpoch(binding.id);
    return { workspaceId: binding.workspaceId, scope, revoked: 1 };
  }

  /** Bumps every binding of a workspace, optionally disabling them as well. */
  revokeWorkspace(workspaceId: string, disable = false): number {
    let revoked = 0;
    for (const binding of this.#bindings.values()) {
      if (binding.workspaceId !== workspaceId) continue;
      if (disable) binding.enabled = false;
      this.#bumpEpoch(binding.id);
      revoked += 1;
    }
    return revoked;
  }

  /**
   * Disabling or re-enabling a binding bumps its epoch, so tokens issued before
   * the change stop resolving immediately and do not come back on re-enable.
   */
  setBindingEnabled(bindingId: string, enabled: boolean): void {
    const binding = this.#bindings.get(bindingId);
    if (binding === undefined) return;
    binding.enabled = enabled;
    this.#bumpEpoch(bindingId);
  }

  /** Removes a binding entirely: no new sessions, no surviving tokens. */
  removeBinding(bindingId: string): void {
    const binding = this.#bindings.get(bindingId);
    if (binding === undefined) return;
    binding.enabled = false;
    // Bump *before* forgetting the binding: the row is what config puts back on
    // the next boot, and it must come back at an epoch the old tokens fail.
    this.#bumpEpoch(bindingId);
    this.#bindings.delete(bindingId);
    this.#epochs.delete(bindingId);
  }

  /** Suspending or retiring a workspace revokes every token bound to it. */
  setWorkspaceStatus(workspaceId: string, status: WorkspaceStatus): void {
    this.#workspaceStatus.set(workspaceId, status);
    for (const binding of this.#bindings.values()) {
      if (binding.workspaceId !== workspaceId) continue;
      if (status !== "active") binding.enabled = false;
      this.#bumpEpoch(binding.id);
    }
  }

  workspaceStatusOf(workspaceId: string): WorkspaceStatus {
    return this.#workspaceStatus.get(workspaceId) ?? "active";
  }

  projectsOf(workspaceId: string): readonly string[] {
    return this.#projectsByWorkspace.get(workspaceId) ?? [];
  }

  /** Current epoch of a binding. Exposed so a restart can be asserted on. */
  epochOf(bindingId: string): number | undefined {
    return this.#epochs.get(bindingId);
  }

  #bumpEpoch(bindingId: string): void {
    const epoch = (this.#epochs.get(bindingId) ?? 1) + 1;
    // In memory first: the revocation is in force on the very next `resolve`,
    // whether or not the durable write has drained yet.
    this.#epochs.set(bindingId, epoch);
    const binding = this.#bindings.get(bindingId);
    if (binding !== undefined) this.#writeEpoch(binding, epoch, this.#fingerprints.get(bindingId));
  }

  #writeEpoch(binding: IngressBinding, epoch: number, fingerprint: string | null | undefined): void {
    this.#fingerprints.set(binding.id, fingerprint ?? null);
    const store = this.#epochStore;
    if (store === undefined) return;
    const record: BindingEpochRecord = {
      bindingId: binding.id,
      workspaceId: binding.workspaceId,
      epoch,
      credentialFingerprint: fingerprint ?? null,
    };
    this.#persist(() => store.put(record));
  }
}

/**
 * Server-side authorization for one dispatched method. Never consults the
 * request payload; the scope comes from the verified token only.
 */
export function authorizeMethod(scope: ResolvedScope, methodCapability: string): boolean {
  const capability = METHOD_CAPABILITIES[methodCapability];
  if (capability === undefined) return false;
  const context: AuthorizationContext = {
    actorWorkspaceId: scope.workspaceId,
    taskScope: scope.role === "head-maid" ? "coordination" : "own",
    answerScope: scope.role === "head-maid" ? "coordination" : "own",
    artifactDetail: "summary",
    delegationGranted: scope.role === "head-maid",
  };
  return authorize(scope.role, capability, context).allowed;
}

/** HMAC key for scope tokens. Generated once, kept 0600 in the data dir. */
export function loadOrCreateScopeSecret(dataDir: string): ScopeSecret {
  const file = path.join(dataDir, "scope-secret");
  try {
    const existing = readFileSync(file);
    if (existing.length >= 32) return scopeSecretFrom(existing);
  } catch {
    // fall through and create
  }
  mkdirSync(dataDir, { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(file, generated, { mode: 0o600 });
  chmodSync(file, 0o600);
  return scopeSecretFrom(generated);
}
