import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveWorkspaceScope, mintScopeToken, scopeSecretFrom } from "@meidoya/workspace-scope";
import {
  CLI_ACCOUNT_REF,
  parseControlPlaneConfig,
  resolveControlPlaneConfig,
} from "./config.js";
import { ClientCredentialStore } from "./client-credentials.js";
import { CONTROL_PLANE_AUDIENCE, ScopeRegistry, authorizeMethod } from "./scope.js";
import { testConfigYaml } from "./testing/harness.js";

/** Obvious dummies; the real ones are 32 random bytes from the daemon. */
const ALICE_SECRET = "dummy-credential-alice";
const IT_SECRET = "dummy-credential-it";

function registry(options: { tokenTtlMs?: number } = {}): ScopeRegistry {
  const config = resolveControlPlaneConfig(parseControlPlaneConfig(testConfigYaml("/tmp/meidoya")));
  return new ScopeRegistry(config, scopeSecretFrom("test-secret-that-is-long-enough"), {
    credentials: ClientCredentialStore.fromEntries([
      ["cli:work-grammarxiv", ALICE_SECRET],
      ["cli:work-it", IT_SECRET],
    ]),
    ...(options.tokenTtlMs === undefined ? {} : { tokenTtlMs: options.tokenTtlMs }),
  });
}

/** A second workspace reachable only through Slack, as in the reported defect. */
const BOB_YAML = `schema_version: 1

environment:
  id: test-env
  timezone: UTC
  data_dir: /tmp/meidoya

control_plane:
  listen:
    unix_socket: /tmp/meidoya/meidoya.sock
  sqlite:
    path: /tmp/meidoya/meidoya.sqlite
  temporal:
    address: 127.0.0.1:7233
    namespace: default
    control_task_queue: meidoya/control

workspaces:
  ws-bob:
    ingress:
      slack:
        account: T-BOB
        channel: C-BOB
    projects:
      bobs-secrets:
        workspace_ref: bobs-secrets
  ws-alice:
    ingress:
      cli:
        profile: alice
    projects:
      alices-repo:
        workspace_ref: alices-repo
`;

function bobRegistry(): ScopeRegistry {
  const config = resolveControlPlaneConfig(parseControlPlaneConfig(BOB_YAML));
  return new ScopeRegistry(config, scopeSecretFrom(randomBytes(32)), {
    credentials: ClientCredentialStore.fromEntries([["cli:ws-alice", ALICE_SECRET]]),
  });
}

const cli = (profileRef: string | null) =>
  ({ source: "cli", accountRef: null, channelRef: null, profileRef }) as const;

describe("scope registry", () => {
  it("derives the workspace from the CLI ingress profile, never from a caller value", () => {
    const scopes = registry();
    const grant = scopes.mint(cli("work-it"), IT_SECRET);
    expect(grant).toMatchObject({ workspaceId: "work-it", role: "maid" });

    const resolved = scopes.resolve((grant as { scopeToken: string }).scopeToken);
    expect(resolved?.workspaceId).toBe("work-it");
  });

  it("refuses to mint for an unknown profile", () => {
    expect(registry().mint(cli("work-somewhere-else"), ALICE_SECRET)).toEqual({
      reason: "no-binding",
    });
  });

  it("refuses a known profile presented without, or with the wrong, credential", () => {
    const scopes = registry();
    expect(scopes.mint(cli("work-it"), undefined)).toEqual({ reason: "no-binding" });
    expect(scopes.mint(cli("work-it"), "")).toEqual({ reason: "no-binding" });
    // Alice's own credential does not let her be work-it.
    expect(scopes.mint(cli("work-it"), ALICE_SECRET)).toEqual({ reason: "no-binding" });
    // ...and the refusal is byte-identical to "there is no such binding".
    expect(scopes.mint(cli("work-it"), ALICE_SECRET)).toEqual(
      scopes.mint(cli("nope"), ALICE_SECRET),
    );
  });

  it("does not hand out a token for another workspace's asserted ingress coordinates", () => {
    const scopes = bobRegistry();
    // Exactly the defect: assert Bob's Slack account/channel over the socket.
    const asserted = scopes.mint(
      { source: "slack", accountRef: "T-BOB", channelRef: "C-BOB", profileRef: null },
      undefined,
    );
    expect(asserted).toEqual({ reason: "no-binding" });
    // A credential the caller does own does not help either.
    expect(
      scopes.mint(
        { source: "slack", accountRef: "T-BOB", channelRef: "C-BOB", profileRef: null },
        ALICE_SECRET,
      ),
    ).toEqual({ reason: "no-binding" });
    // The refusal is indistinguishable from a workspace that does not exist.
    expect(asserted).toEqual(
      scopes.mint(
        { source: "slack", accountRef: "T-NOBODY", channelRef: "C-NOBODY", profileRef: null },
        undefined,
      ),
    );
    // Alice's legitimate handshake still works.
    expect(scopes.mint(cli("alice"), ALICE_SECRET)).toMatchObject({ workspaceId: "ws-alice" });
  });

  it("rejects a forged or tampered token", () => {
    const scopes = registry();
    const grant = scopes.mint(cli("work-grammarxiv"), ALICE_SECRET) as { scopeToken: string };
    const [body, mac] = grant.scopeToken.split(".");
    const forged = `${Buffer.from(
      JSON.stringify({ v: 2, e: "test-env", a: "x", w: "work-it", p: [], b: "cli:work-it", k: 1, i: 0, x: 1 }),
      "utf8",
    ).toString("base64url")}.${mac ?? ""}`;
    expect(body).toBeDefined();
    expect(scopes.resolve(forged)).toBeUndefined();
    expect(scopes.resolve("not-a-token")).toBeUndefined();
  });
});

describe("token lifetime", () => {
  it("stops resolving a token once its TTL has run out", () => {
    const scopes = registry({ tokenTtlMs: 60_000 });
    const now = 1_000_000;
    const grant = scopes.mint(cli("work-it"), IT_SECRET, now) as { scopeToken: string };
    expect(scopes.resolve(grant.scopeToken, now + 59_999)?.workspaceId).toBe("work-it");
    expect(scopes.resolve(grant.scopeToken, now + 60_000)).toBeUndefined();
    // Ten years later it is still refused, which is what the old code allowed.
    expect(scopes.resolve(grant.scopeToken, now + 315_360_000_000)).toBeUndefined();
  });

  it("refuses a token that is not yet valid", () => {
    const scopes = registry();
    const future = Date.now() + 315_360_000_000;
    const grant = scopes.mint(cli("work-it"), IT_SECRET, future) as { scopeToken: string };
    expect(scopes.resolve(grant.scopeToken, Date.now())).toBeUndefined();
  });
});

/**
 * Engine-level only: these call the registry directly, which is exactly why
 * they stayed green while revocation had no caller and no durability. The
 * properties that matter to an operator — that revocation is reachable from
 * `session.revoke`/`meidoya admin revoke`, and that it survives a restart —
 * are asserted through those surfaces in server.test.ts. Do not treat this
 * block as coverage of the feature.
 */
describe("revocation", () => {
  it("invalidates outstanding tokens when the ingress binding is disabled", () => {
    const scopes = registry();
    const grant = scopes.mint(cli("work-it"), IT_SECRET) as { scopeToken: string };
    expect(scopes.resolve(grant.scopeToken)?.workspaceId).toBe("work-it");

    scopes.setBindingEnabled("cli:work-it", false);
    expect(scopes.resolve(grant.scopeToken)).toBeUndefined();
    expect(scopes.mint(cli("work-it"), IT_SECRET)).toEqual({ reason: "no-binding" });

    // Re-enabling issues a new epoch: the old token stays dead.
    scopes.setBindingEnabled("cli:work-it", true);
    expect(scopes.resolve(grant.scopeToken)).toBeUndefined();
    const fresh = scopes.mint(cli("work-it"), IT_SECRET) as { scopeToken: string };
    expect(scopes.resolve(fresh.scopeToken)?.workspaceId).toBe("work-it");
  });

  it("invalidates outstanding tokens when the binding is removed", () => {
    const scopes = registry();
    const grant = scopes.mint(cli("work-it"), IT_SECRET) as { scopeToken: string };
    scopes.removeBinding("cli:work-it");
    expect(scopes.resolve(grant.scopeToken)).toBeUndefined();
  });

  it("invalidates outstanding tokens when the workspace is suspended or retired", () => {
    const scopes = registry();
    const grant = scopes.mint(cli("work-grammarxiv"), ALICE_SECRET) as { scopeToken: string };
    expect(scopes.resolve(grant.scopeToken)?.workspaceId).toBe("work-grammarxiv");
    scopes.setWorkspaceStatus("work-grammarxiv", "suspended");
    expect(scopes.resolve(grant.scopeToken)).toBeUndefined();
    expect(scopes.mint(cli("work-grammarxiv"), ALICE_SECRET)).toEqual({ reason: "no-binding" });
    // Other workspaces are untouched.
    expect(scopes.mint(cli("work-it"), IT_SECRET)).toMatchObject({ workspaceId: "work-it" });
  });

  it("does not accept a token from another environment or audience", () => {
    const config = resolveControlPlaneConfig(parseControlPlaneConfig(testConfigYaml("/tmp/meidoya")));
    const secret = scopeSecretFrom("shared-by-accident-secret");
    const credentials = ClientCredentialStore.fromEntries([["cli:work-it", IT_SECRET]]);
    const envA = new ScopeRegistry(config, secret, { credentials });
    const envB = new ScopeRegistry(
      { ...config, environmentId: "other-env" },
      secret,
      { credentials },
    );
    const otherAudience = new ScopeRegistry(config, secret, {
      credentials,
      audience: "meidoya:node-plane:session",
    });

    const grant = envA.mint(cli("work-it"), IT_SECRET) as { scopeToken: string };
    expect(envA.resolve(grant.scopeToken)?.workspaceId).toBe("work-it");
    expect(envB.resolve(grant.scopeToken)).toBeUndefined();
    expect(otherAudience.resolve(grant.scopeToken)).toBeUndefined();
    // And the reverse direction.
    const fromB = envB.mint(cli("work-it"), IT_SECRET) as { scopeToken: string };
    expect(envA.resolve(fromB.scopeToken)).toBeUndefined();
  });

  it("does not accept a token whose workspace and binding claims disagree", () => {
    // The token carries the workspace and the binding as two INDEPENDENT signed
    // claims, and `resolve` requires them to name the same workspace. Nothing
    // reachable mints a crossed pair today, only because `config.ts` derives
    // binding ids as `${source}:${workspaceId}` — a convention `scope.ts` must
    // not know about and cannot rely on. So the pair is crossed here directly,
    // with the registry's OWN secret, environment, audience and current epoch:
    // every other check passes and the disagreement is the only thing left to
    // refuse it. Without that check, a valid signature over "workspace
    // work-grammarxiv, binding cli:work-it" resolves — one token naming two
    // tenants, honoured as the wrong one.
    const secret = scopeSecretFrom("test-secret-that-is-long-enough");
    const scopes = registry();
    const now = Date.now();
    const derived = deriveWorkspaceScope(
      {
        channel: "cli",
        accountRef: CLI_ACCOUNT_REF,
        externalRef: "work-grammarxiv",
        workspaceId: "work-grammarxiv",
        projects: [...scopes.projectsOf("work-grammarxiv")],
      },
      now,
    );
    if (!derived.ok) throw new Error("could not derive the scope under test");

    const crossed = mintScopeToken(derived.scope, secret, {
      environmentId: "test-env",
      audience: CONTROL_PLANE_AUDIENCE,
      bindingId: "cli:work-it",
      bindingEpoch: scopes.epochOf("cli:work-it") ?? 1,
      expiresAt: now + 60_000,
    });
    expect(scopes.resolve(crossed)).toBeUndefined();

    // The same mint with the claims AGREEING does resolve, so the test is about
    // the disagreement and not about hand-built tokens being rejected wholesale.
    const consistent = mintScopeToken(derived.scope, secret, {
      environmentId: "test-env",
      audience: CONTROL_PLANE_AUDIENCE,
      bindingId: "cli:work-grammarxiv",
      bindingEpoch: scopes.epochOf("cli:work-grammarxiv") ?? 1,
      expiresAt: now + 60_000,
    });
    expect(scopes.resolve(consistent)?.workspaceId).toBe("work-grammarxiv");
  });
});

describe("method authorization", () => {
  const maid = { workspaceId: "work-it", role: "maid", capabilities: [] } as const;

  it("allows a Maid its own workspace operations", () => {
    expect(authorizeMethod(maid, "task.create")).toBe(true);
    expect(authorizeMethod(maid, "checkpoint.answer")).toBe(true);
    expect(authorizeMethod(maid, "workspace.status.read")).toBe(true);
  });

  it("denies capabilities that are not mapped at all", () => {
    expect(authorizeMethod(maid, "repository.write")).toBe(false);
    expect(authorizeMethod(maid, "anything.else")).toBe(false);
  });

  it("denies a worker every control plane method", () => {
    const worker = { workspaceId: "work-it", role: "worker", capabilities: [] } as const;
    expect(authorizeMethod(worker, "task.create")).toBe(false);
    expect(authorizeMethod(worker, "workspace.status.read")).toBe(false);
  });
});
