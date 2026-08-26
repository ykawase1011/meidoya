import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IngressBinding } from "@meidoya/chat-vercel";

/**
 * Per-profile bearer credentials for local clients (the CLI).
 *
 * Why this exists: the unix socket's 0600 mode only proves the peer runs as the
 * daemon's user. Every agent process the daemon spawns runs as that same user,
 * so the socket cannot distinguish "the operator's CLI bound to work-it" from
 * "a compromised worker asserting work-it". `session.hello` therefore has to
 * prove possession of a secret tied to the binding, not merely assert the
 * binding's routing tuple.
 *
 * Peer credentials (SO_PEERCRED / LOCAL_PEERCRED) were considered and are not
 * enough on their own: Node exposes no binding for them, and even with one the
 * uid is identical for every local process, which is exactly the boundary we
 * need to cut across. The socket mode stays as the outer fence; this is the
 * inner one.
 *
 * Credentials live one file per binding under `<dataDir>/clients`, 0600, and
 * are generated on first start so a fresh install needs no manual ceremony.
 *
 * ONE FILE PER BINDING, and that is a load-bearing sentence. The file used to
 * be named after the ingress PROFILE alone, which is not an identity: two CLI
 * bindings in different workspaces may legally share a profile (they are told
 * apart by their channel), and two bindings with no profile at all both
 * collapsed onto `default.secret`. Both cases handed the two workspaces the
 * SAME secret, so a holder of workspace A's credential could send
 * `session.hello {source:"cli", channel:"<B's channel>", profile:"<shared>",
 * credential:"<A's secret>"}` and be minted a full-authority token for B —
 * exactly the thing the credential exists to make impossible.
 *
 * The naming rule below therefore keys on the binding, and keeps the
 * profile-shaped name only as an ALIAS, and only while that alias names exactly
 * one binding. The alias is what the CLI discovers from `--profile`; when it is
 * ambiguous nobody gets it, every colliding binding falls back to its own
 * binding-derived file, and the ambiguous `session.hello` fails closed rather
 * than authenticating as the wrong workspace.
 */

const CREDENTIAL_DIR = "clients";
const NODE_CREDENTIAL_DIR = "nodes";
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The profile-shaped alias a CLI client looks for (`<profile>.secret`, or
 * `default.secret` with no profile). `undefined` when the profile cannot be a
 * filename at all, in which case the binding-derived name is used instead.
 */
export function credentialAlias(profileRef: string | null): string | undefined {
  const name = profileRef ?? "default";
  return SAFE_NAME.test(name) ? name : undefined;
}

/**
 * Collision-proof name derived from the binding itself. `binding.id` is
 * `${source}:${workspaceId}`, which is unique by construction; the digest keeps
 * it unique after the characters a filename cannot carry are replaced.
 */
export function bindingCredentialName(binding: IngressBinding): string {
  const slug = `${binding.source}-${binding.workspaceId}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const digest = createHash("sha256").update(binding.id).digest("hex").slice(0, 8);
  return `${SAFE_NAME.test(slug) ? slug : "binding"}-${digest}`;
}

/**
 * File name per binding id. A profile alias is used only when it belongs to a
 * single binding; every other binding gets its own binding-derived name, so no
 * two bindings can ever be pointed at one file.
 */
export function credentialFileNames(
  bindings: readonly IngressBinding[],
): Map<string, string> {
  const local = bindings.filter((binding) => binding.source === "cli");
  const claimants = new Map<string, number>();
  for (const binding of local) {
    const alias = credentialAlias(binding.profileRef);
    if (alias === undefined) continue;
    claimants.set(alias, (claimants.get(alias) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const binding of local) {
    const alias = credentialAlias(binding.profileRef);
    names.set(
      binding.id,
      alias !== undefined && claimants.get(alias) === 1 ? alias : bindingCredentialName(binding),
    );
  }
  return names;
}

export function credentialFilePath(dataDir: string, name: string): string {
  return path.join(dataDir, CREDENTIAL_DIR, `${name}.secret`);
}

function readSecret(file: string): string | undefined {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Constant-time comparison that does not short-circuit on length, so a wrong
 * credential costs the same whether or not it happens to be the right size.
 */
function secretsMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  const width = Math.max(a.length, b.length);
  const padA = Buffer.alloc(width);
  const padB = Buffer.alloc(width);
  a.copy(padA);
  b.copy(padB);
  return timingSafeEqual(padA, padB) && a.length === b.length;
}

/** Reads the secret in `file`, generating and persisting one at 0600 if absent. */
function provisionSecret(file: string): string {
  let secret = readSecret(file);
  if (secret === undefined) {
    secret = randomBytes(32).toString("hex");
    writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  }
  chmodSync(file, 0o600);
  return secret;
}

export class ClientCredentialStore {
  readonly #byBindingId = new Map<string, string>();
  readonly #fileByBindingId = new Map<string, string>();

  private constructor(
    entries: Iterable<[string, string]>,
    files: Iterable<[string, string]> = [],
  ) {
    for (const [bindingId, secret] of entries) this.#byBindingId.set(bindingId, secret);
    for (const [bindingId, file] of files) this.#fileByBindingId.set(bindingId, file);
  }

  /** In-memory store, for tests. */
  static fromEntries(entries: Iterable<[string, string]>): ClientCredentialStore {
    return new ClientCredentialStore(entries);
  }

  /**
   * Loads (or generates) one credential per local-client binding. Bindings for
   * remote sources get none: a chat message authenticates through its platform,
   * never through `session.hello`.
   */
  static provision(dataDir: string, bindings: readonly IngressBinding[]): ClientCredentialStore {
    const dir = path.join(dataDir, CREDENTIAL_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const names = credentialFileNames(bindings);
    const entries: [string, string][] = [];
    const files: [string, string][] = [];
    for (const binding of bindings) {
      if (binding.source !== "cli" || !binding.enabled) continue;
      const name = names.get(binding.id) ?? bindingCredentialName(binding);
      const file = credentialFilePath(dataDir, name);
      entries.push([binding.id, provisionSecret(file)]);
      files.push([binding.id, file]);
    }
    return new ClientCredentialStore(entries, files);
  }

  has(bindingId: string): boolean {
    return this.#byBindingId.has(bindingId);
  }

  /** Where this binding's secret lives. Exposed so an operator can be told. */
  fileOf(bindingId: string): string | undefined {
    return this.#fileByBindingId.get(bindingId);
  }

  /**
   * Digest of a binding's credential, salted with the binding id and truncated:
   * the credential itself never leaves this object. Rotating the secret changes
   * the digest, which is what lets the scope registry retire every session
   * minted under the old one (see scope.ts).
   */
  fingerprintOf(bindingId: string): string | null {
    const secret = this.#byBindingId.get(bindingId);
    if (secret === undefined || secret === "") return null;
    return createHash("sha256")
      .update(bindingId)
      .update("\u0000")
      .update(secret)
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * True only for a binding that has a credential and a presented value that
   * matches it. An unknown binding still pays for a comparison so that "no such
   * binding" and "wrong secret" are not distinguishable by timing.
   */
  verify(bindingId: string, presented: string | undefined): boolean {
    const expected = this.#byBindingId.get(bindingId);
    if (typeof presented !== "string" || presented === "") {
      if (expected !== undefined) secretsMatch(expected, "");
      return false;
    }
    if (expected === undefined) {
      secretsMatch("0".repeat(64), presented);
      return false;
    }
    return secretsMatch(expected, presented);
  }
}

/**
 * Per-node registration tokens (11 section 7's "Node registration token").
 *
 * Same argument as the client credentials above, one layer over: the unix
 * socket proves only that the peer runs as the daemon's user, and every agent
 * process the daemon spawns does. `node.register` and `node.heartbeat` name a
 * node by id, and that id used to be a bare *selector* — a re-registration
 * rewrites the node's whole workspace binding set and a heartbeat flips its
 * status for every workspace at once, so an unauthenticated caller could
 * unbind one workspace's node from another workspace, durably, without ever
 * saying hello.
 *
 * The token is therefore what proves the caller IS that node. It is provisioned
 * exactly like a client credential — one 0600 file per node under
 * `<dataDir>/nodes`, generated on first start — and handed to the node process
 * by whoever launches it; nothing the node itself asserts can supply it, since
 * the self-report is the very thing being authenticated.
 *
 * A node with NO entry here can never authenticate: the store fails closed, so
 * a daemon that provisioned nothing serves no node rather than serving all of
 * them.
 */
export class NodeCredentialStore {
  readonly #byNodeId = new Map<string, string>();
  readonly #fileByNodeId = new Map<string, string>();

  private constructor(
    entries: Iterable<[string, string]>,
    files: Iterable<[string, string]> = [],
  ) {
    for (const [nodeId, secret] of entries) this.#byNodeId.set(nodeId, secret);
    for (const [nodeId, file] of files) this.#fileByNodeId.set(nodeId, file);
  }

  /** In-memory store, for tests. */
  static fromEntries(entries: Iterable<[string, string]>): NodeCredentialStore {
    return new NodeCredentialStore(entries);
  }

  /** Loads (or generates) one credential per node the operator configured. */
  static provision(dataDir: string, nodeIds: readonly string[]): NodeCredentialStore {
    const dir = path.join(dataDir, NODE_CREDENTIAL_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entries: [string, string][] = [];
    const files: [string, string][] = [];
    for (const nodeId of nodeIds) {
      const file = nodeCredentialFilePath(dataDir, nodeId);
      entries.push([nodeId, provisionSecret(file)]);
      files.push([nodeId, file]);
    }
    return new NodeCredentialStore(entries, files);
  }

  /** Where this node's token lives. Exposed so an operator can be told. */
  fileOf(nodeId: string): string | undefined {
    return this.#fileByNodeId.get(nodeId);
  }

  /**
   * True only for a node that has a token and a presented value that matches
   * it. An unknown node still pays for a comparison, so "no such node" and
   * "wrong token" are not distinguishable by timing — a node id must not become
   * an oracle for which nodes an operator has configured.
   */
  verify(nodeId: string, presented: string | undefined): boolean {
    const expected = this.#byNodeId.get(nodeId);
    if (typeof presented !== "string" || presented === "") {
      if (expected !== undefined) secretsMatch(expected, "");
      return false;
    }
    if (expected === undefined) {
      secretsMatch("0".repeat(64), presented);
      return false;
    }
    return secretsMatch(expected, presented);
  }
}

/**
 * Collision-proof file name for a node's token. A node id comes from a config
 * key and may hold characters a filename cannot, so the slug is sanitised and
 * the digest of the ORIGINAL id keeps two ids that sanitise alike apart — two
 * nodes must never be pointed at one file, for the same reason two ingress
 * bindings must not be.
 */
export function nodeCredentialName(nodeId: string): string {
  const slug = nodeId.replace(/[^A-Za-z0-9._-]/g, "_");
  const digest = createHash("sha256").update(nodeId).digest("hex").slice(0, 8);
  return `${SAFE_NAME.test(slug) ? slug : "node"}-${digest}`;
}

export function nodeCredentialFilePath(dataDir: string, nodeId: string): string {
  return path.join(dataDir, NODE_CREDENTIAL_DIR, `${nodeCredentialName(nodeId)}.secret`);
}
