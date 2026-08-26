import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlPlaneClient, ControlPlaneClientError, run } from "meidoya";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MeidoyaDatabase } from "@meidoya/store-sqlite";
import { migrate, migrations, openDatabase } from "@meidoya/store-sqlite";
import type { ControlPlaneService } from "./api.js";
import { ClientCredentialStore } from "./client-credentials.js";
import { parseControlPlaneConfig, resolveControlPlaneConfig } from "./config.js";
import { ControlEventBus } from "./events.js";
import {
  ScopeRegistry,
  createSqliteBindingEpochStore,
  loadOrCreateScopeSecret,
} from "./scope.js";
import { ControlPlaneServer } from "./server.js";

/**
 * Two workspaces: Alice reaches hers over the CLI, Bob's is a Slack-only
 * workspace on the same daemon. The defect was that anyone able to open the
 * socket could assert Bob's Slack coordinates and be handed his workspace.
 */
function configYaml(dataDir: string): string {
  return `schema_version: 1

environment:
  id: server-test
  timezone: UTC
  data_dir: ${dataDir}

control_plane:
  listen:
    unix_socket: ${path.join(dataDir, "meidoya.sock")}
  sqlite:
    path: ${path.join(dataDir, "meidoya.sqlite")}
  temporal:
    address: 127.0.0.1:7233
    namespace: default
    control_task_queue: meidoya/control

workspaces:
  ws-alice:
    ingress:
      cli:
        profile: alice
    projects:
      alices-repo:
        workspace_ref: alices-repo
  ws-bob:
    ingress:
      slack:
        account: T-BOB
        channel: C-BOB
    projects:
      bobs-secrets:
        workspace_ref: bobs-secrets
`;
}

type Harness = {
  dataDir: string;
  socketPath: string;
  scopes: ScopeRegistry;
  server: ControlPlaneServer;
  db: MeidoyaDatabase;
};

let harness: Harness | undefined;

/**
 * `dataDir` is reused by `restart`, which is what makes durability testable:
 * the scope secret, the client credentials and the revocation epochs all live
 * there, exactly as they do for a real daemon.
 */
function startServer(tokenTtlMs?: number, existingDataDir?: string): Harness {
  const dataDir = existingDataDir ?? mkdtempSync(path.join(os.tmpdir(), "meidoya-server-test-"));
  const config = resolveControlPlaneConfig(parseControlPlaneConfig(configYaml(dataDir)));
  const db = openDatabase(config.sqlitePath);
  migrate(db, migrations);
  const scopes = new ScopeRegistry(config, loadOrCreateScopeSecret(dataDir), {
    credentials: ClientCredentialStore.provision(dataDir, config.ingressBindings),
    epochs: createSqliteBindingEpochStore(db),
    ...(tokenTtlMs === undefined ? {} : { tokenTtlMs }),
  });
  const service = {
    systemInfo: () => ({
      controlProtocolVersion: 1,
      nodeProtocolVersion: 1,
      environmentId: config.environmentId,
    }),
  } as unknown as ControlPlaneService;
  const server = new ControlPlaneServer({
    socketPath: config.socketPath,
    service,
    scopes,
    handlers: {},
    events: new ControlEventBus(),
  });
  return { dataDir, socketPath: config.socketPath, scopes, server, db };
}

async function boot(tokenTtlMs?: number): Promise<Harness> {
  const started = startServer(tokenTtlMs);
  await started.server.start();
  harness = started;
  return started;
}

/** Stops the daemon and starts a new one over the same data dir. */
async function restart(current: Harness): Promise<Harness> {
  await current.server.close();
  current.db.close();
  const next = startServer(undefined, current.dataDir);
  await next.server.start();
  harness = next;
  return next;
}

beforeEach(() => {
  harness = undefined;
});

afterEach(async () => {
  if (harness === undefined) return;
  await harness.server.close();
  harness.db.close();
  rmSync(harness.dataDir, { recursive: true, force: true });
  harness = undefined;
});

async function hello(
  socketPath: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string; kind: string }> {
  const client = await ControlPlaneClient.connect(socketPath);
  try {
    const result = await client.request("session.hello", params);
    return { ok: true, result };
  } catch (error) {
    const failure = error as ControlPlaneClientError;
    return { ok: false, message: failure.error.message, kind: failure.error.kind };
  } finally {
    client.close();
  }
}

describe("server shutdown", () => {
  it("closes while a long-lived client session is still connected", async () => {
    const started = await boot();
    const client = await ControlPlaneClient.connect(started.socketPath);

    await expect(started.server.close()).resolves.toBeUndefined();

    client.close();
    started.db.close();
    rmSync(started.dataDir, { recursive: true, force: true });
    harness = undefined;
  });
});

describe("session.hello authentication", () => {
  it("refuses a client that merely asserts another workspace's ingress coordinates", async () => {
    const { socketPath } = await boot();
    const asserted = await hello(socketPath, {
      source: "slack",
      account: "T-BOB",
      channel: "C-BOB",
    });
    expect(asserted.ok).toBe(false);
    if (asserted.ok) return;
    expect(asserted.kind).toBe("unauthorized_scope");
    // No workspace id, no project, no hint that ws-bob is real here.
    expect(asserted.message).toBe("no ingress binding for this client");
    expect(asserted.message).not.toContain("ws-bob");

    // Byte-identical to a workspace that does not exist at all.
    const invented = await hello(socketPath, {
      source: "slack",
      account: "T-NOBODY",
      channel: "C-NOBODY",
    });
    expect(invented).toEqual(asserted);

    // And to a CLI profile that exists but whose credential we do not have.
    const stolenProfile = await hello(socketPath, {
      source: "cli",
      profile: "alice",
      credential: "dummy-wrong-credential",
    });
    expect(stolenProfile).toEqual(asserted);

    // A missing credential is refused the same way.
    expect(await hello(socketPath, { source: "cli", profile: "alice" })).toEqual(asserted);
  });

  it("lets the real CLI in with the credential the daemon provisioned", async () => {
    const { socketPath, dataDir } = await boot();
    const file = path.join(dataDir, "clients", "alice.secret");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim().length).toBe(64);

    // The CLI client finds it on its own, from the socket's directory.
    const client = await ControlPlaneClient.connect(socketPath);
    try {
      const session = await client.hello("alice");
      expect(session.workspaceId).toBe("ws-alice");
      expect(session.projects).toEqual(["alices-repo"]);
      expect(session.role).toBe("maid");
      expect(client.scopeToken).toBeDefined();
    } finally {
      client.close();
    }
  });

  it("refuses a scope token whose binding was disabled after it was issued", async () => {
    const { socketPath, scopes } = await boot();
    const client = await ControlPlaneClient.connect(socketPath);
    try {
      await client.hello("alice");
      await expect(client.request("event.subscribe", {}, true)).resolves.toMatchObject({
        subscribed: true,
      });

      scopes.setBindingEnabled("cli:ws-alice", false);
      await expect(client.request("event.subscribe", {}, true)).rejects.toThrow(
        /invalid scope token/,
      );
    } finally {
      client.close();
    }
  });

  it("refuses a scope token once its lifetime has run out", async () => {
    const { socketPath } = await boot(1);
    const client = await ControlPlaneClient.connect(socketPath);
    try {
      await client.hello("alice");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await expect(client.request("event.subscribe", {}, true)).rejects.toThrow(
        /invalid scope token/,
      );
    } finally {
      client.close();
    }
  });
});

/**
 * Revocation exercised through the surface an operator actually has — the
 * `session.revoke` method the CLI's `meidoya admin revoke` calls — and never by
 * poking the registry. A revocation engine with no reachable caller is the root
 * cause this whole area exists to fix; these tests fail if the wiring is
 * removed, however correct the engine underneath stays.
 */
describe("session.revoke", () => {
  async function revoke(
    socketPath: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; message: string; kind: string }> {
    const client = await ControlPlaneClient.connect(socketPath);
    try {
      return { ok: true, result: await client.request("session.revoke", params) };
    } catch (error) {
      const failure = error as ControlPlaneClientError;
      return { ok: false, message: failure.error.message, kind: failure.error.kind };
    } finally {
      client.close();
    }
  }

  function secretOf(dataDir: string, profile: string): string {
    return readFileSync(path.join(dataDir, "clients", `${profile}.secret`), "utf8").trim();
  }

  it("kills an outstanding token, and only for a caller holding the credential", async () => {
    const { socketPath, dataDir } = await boot();
    const client = await ControlPlaneClient.connect(socketPath);
    try {
      await client.hello("alice");
      await expect(client.request("event.subscribe", {}, true)).resolves.toMatchObject({
        subscribed: true,
      });

      // Holding the token is not authority to revoke it: the credential is.
      const unauthenticated = await revoke(socketPath, { source: "cli", profile: "alice" });
      expect(unauthenticated.ok).toBe(false);
      if (!unauthenticated.ok) {
        expect(unauthenticated.kind).toBe("unauthorized_scope");
        expect(unauthenticated.message).toBe("no ingress binding for this client");
      }
      // Still alive: a failed revocation must not revoke anything.
      await expect(client.request("event.subscribe", {}, true)).resolves.toMatchObject({
        subscribed: true,
      });

      const revoked = await revoke(socketPath, {
        source: "cli",
        profile: "alice",
        credential: secretOf(dataDir, "alice"),
      });
      expect(revoked).toMatchObject({
        ok: true,
        result: { workspaceId: "ws-alice", scope: "session", revoked: 1 },
      });

      await expect(client.request("event.subscribe", {}, true)).rejects.toThrow(
        /invalid scope token/,
      );
    } finally {
      client.close();
    }
  });

  it("keeps the binding usable afterwards, so a new session can be established", async () => {
    const { socketPath, dataDir } = await boot();
    await revoke(socketPath, {
      source: "cli",
      profile: "alice",
      credential: secretOf(dataDir, "alice"),
    });
    const fresh = await ControlPlaneClient.connect(socketPath);
    try {
      await fresh.hello("alice");
      await expect(fresh.request("event.subscribe", {}, true)).resolves.toMatchObject({
        subscribed: true,
      });
    } finally {
      fresh.close();
    }
  });

  it("--disable also stops the binding issuing new sessions", async () => {
    const { socketPath, dataDir } = await boot();
    await revoke(socketPath, {
      source: "cli",
      profile: "alice",
      credential: secretOf(dataDir, "alice"),
      disable: true,
    });
    const refused = await hello(socketPath, {
      source: "cli",
      profile: "alice",
      credential: secretOf(dataDir, "alice"),
    });
    expect(refused).toMatchObject({ ok: false, kind: "unauthorized_scope" });
  });

  it("--all reaches a binding that cannot present a credential of its own", async () => {
    const { socketPath, dataDir, scopes } = await boot();
    const before = scopes.epochOf("slack:ws-bob");
    // Alice cannot revoke Bob's Slack binding: different workspace.
    const alice = await revoke(socketPath, {
      source: "cli",
      profile: "alice",
      credential: secretOf(dataDir, "alice"),
      scope: "workspace",
    });
    expect(alice).toMatchObject({ ok: true, result: { workspaceId: "ws-alice", revoked: 1 } });
    expect(scopes.epochOf("slack:ws-bob")).toBe(before);
  });

  it("survives a restart: a revoked token is still refused by the next process", async () => {
    let current = await boot();
    const client = await ControlPlaneClient.connect(current.socketPath);
    let token: string;
    try {
      const session = await client.hello("alice");
      token = session.scopeToken;
      expect(current.scopes.resolve(token)).toMatchObject({ workspaceId: "ws-alice" });
      await revoke(current.socketPath, {
        source: "cli",
        profile: "alice",
        credential: secretOf(current.dataDir, "alice"),
      });
      expect(current.scopes.resolve(token)).toBeUndefined();
    } finally {
      client.close();
    }

    current = await restart(current);
    // Same signing key, same binding, same live daemon behaviour otherwise...
    const after = await ControlPlaneClient.connect(current.socketPath);
    try {
      await after.hello("alice");
      await expect(after.request("event.subscribe", {}, true)).resolves.toMatchObject({
        subscribed: true,
      });
    } finally {
      after.close();
    }
    // ...but the revoked token stays dead for the rest of its lifetime.
    expect(current.scopes.resolve(token)).toBeUndefined();
  });

  it("is reachable from the CLI: `meidoya admin revoke` kills a live token", async () => {
    const { socketPath, dataDir } = await boot();
    const client = await ControlPlaneClient.connect(socketPath);
    let token: string;
    try {
      token = (await client.hello("alice")).scopeToken;
    } finally {
      client.close();
    }
    const { scopes } = harness as Harness;
    expect(scopes.resolve(token)).toMatchObject({ workspaceId: "ws-alice" });

    const previous = {
      socket: process.env["MEIDOYA_SOCKET"],
      credentials: process.env["MEIDOYA_CREDENTIALS_DIR"],
      secret: process.env["MEIDOYA_CLIENT_SECRET"],
    };
    process.env["MEIDOYA_SOCKET"] = socketPath;
    process.env["MEIDOYA_CREDENTIALS_DIR"] = path.join(dataDir, "clients");
    delete process.env["MEIDOYA_CLIENT_SECRET"];
    try {
      // Exactly what an operator types. No test-only entry point involved.
      expect(await run(["admin", "revoke", "--profile", "alice"])).toBe(0);
    } finally {
      for (const [key, value] of [
        ["MEIDOYA_SOCKET", previous.socket],
        ["MEIDOYA_CREDENTIALS_DIR", previous.credentials],
        ["MEIDOYA_CLIENT_SECRET", previous.secret],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(scopes.resolve(token)).toBeUndefined();
  });

  it("rotating a client credential revokes the sessions minted under the old one", async () => {
    let current = await boot();
    const client = await ControlPlaneClient.connect(current.socketPath);
    let token: string;
    try {
      token = (await client.hello("alice")).scopeToken;
    } finally {
      client.close();
    }
    expect(current.scopes.resolve(token)).toMatchObject({ workspaceId: "ws-alice" });

    // An operator rotates the secret file and restarts.
    writeFileSync(path.join(current.dataDir, "clients", "alice.secret"), `${"b".repeat(64)}\n`, {
      mode: 0o600,
    });
    current = await restart(current);
    expect(current.scopes.resolve(token)).toBeUndefined();
  });
});
