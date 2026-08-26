import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, migrations, openDatabase, type MeidoyaDatabase } from "@meidoya/store-sqlite";
import { ControlPlaneError, type MethodParams, type ResolvedScope } from "@meidoya/protocol";
import { NODE_PROTOCOL_VERSION } from "@meidoya/node-protocol";
import { ControlPlaneService, createMethodHandlers } from "../api.js";
import {
  ClientCredentialStore,
  NodeCredentialStore,
  nodeCredentialFilePath,
} from "../client-credentials.js";
import {
  parseControlPlaneConfig,
  resolveControlPlaneConfig,
  type ResolvedControlPlaneConfig,
} from "../config.js";
import { ControlEventBus, type ControlEvent } from "../events.js";
import { SqliteTaskRepository, seedFromConfig } from "../repository.js";
import { ScopeRegistry, createSqliteBindingEpochStore, loadOrCreateScopeSecret } from "../scope.js";
import { ControlPlaneServer } from "../server.js";
import { SerialWriteQueue } from "../write-queue.js";
import type { CheckpointAnswerSignal, MailboxEntry, WorkflowGateway } from "../temporal.js";

/**
 * TWO TENANTS ON ONE DAEMON, and one of them acting.
 *
 * Why this fixture exists, stated plainly, because it is the systemic finding
 * this file answers:
 *
 * The suite was rich in POSITIVE tests ("this works") and in DOCUMENTED-REFUSAL
 * tests ("this refusal fires"), and nearly empty of NEGATIVE ISOLATION tests
 * ("workspace A cannot see or touch B's rows"). Every workspace guard that
 * survived mutation testing was a predicate living inside a query that also did
 * something useful: delete `workspace_id = ?` from `listTasks` and the suite
 * stayed entirely green while `task.list` returned every tenant's tasks, because
 * every existing test only ever ran one workspace's data through it — the row
 * that should have been hidden was never there to be leaked.
 *
 * The cure is structural, not another handful of tests: a fixture where a second
 * workspace's rows ALWAYS exist, so a missing predicate has something to leak
 * and any test that asserts "A sees exactly its own" fails on the spot.
 *
 * Use it for every read or write that carries a workspace predicate:
 *
 *   const two = await twoWorkspaces();
 *   await two.createTask(WORKSPACE_B, { title: "B's secret" });
 *   expect(two.service.listTasks(two.scopeOf(WORKSPACE_A), { limit: 50 }).tasks).toEqual([]);
 *
 * Everything here is real: the config parser, the migrated database, the scope
 * registry, provisioned client credentials, minted-and-verified scope tokens,
 * and (via `startServer`) the unix socket. The only fake is the Temporal
 * gateway, which records what it was asked to do.
 */

export const WORKSPACE_A = "ws-a";
export const WORKSPACE_B = "ws-b";
export const PROJECT_A = "proj-a";
export const PROJECT_B = "proj-b";

/**
 * Two execution nodes, because a node is a cross-tenant object in its own
 * right: `NODE_SHARED` is bound to BOTH workspaces, so a registration that
 * narrows its bindings has one of them to destroy, and `NODE_B_ONLY` is bound
 * to B alone, so a workspace-status read that forgets to filter has one to leak.
 */
export const NODE_SHARED = "node-shared";
export const NODE_B_ONLY = "node-b-only";

export type IngressOptions = {
  /** CLI ingress profile. `null` means the binding declares none. */
  profile?: string | null;
  /** CLI ingress channel, which is what makes two same-profile rows distinct. */
  channel?: string;
};

export type TwoWorkspaceOptions = {
  ingressA?: IngressOptions;
  ingressB?: IngressOptions;
  now?: number;
  tokenTtlMs?: number;
};

function ingressBlock(options: IngressOptions, fallbackProfile: string): string {
  const profile = options.profile === undefined ? fallbackProfile : options.profile;
  const lines = ["    ingress:", "      cli:"];
  if (profile !== null) lines.push(`        profile: ${profile}`);
  if (options.channel !== undefined) lines.push(`        channel: ${options.channel}`);
  return `${lines.join("\n")}\n`;
}

export function twoWorkspaceConfigYaml(
  dataDir: string,
  options: TwoWorkspaceOptions = {},
): string {
  const workspace = (
    workspaceId: string,
    project: string,
    ingress: IngressOptions,
    fallbackProfile: string,
  ): string =>
    `  ${workspaceId}:\n` +
    ingressBlock(ingress, fallbackProfile) +
    `    projects:\n      ${project}:\n        workspace_ref: ${project}\n`;

  return (
    `schema_version: 1\n\n` +
    `environment:\n  id: two-workspace-test\n  timezone: UTC\n  data_dir: ${dataDir}\n\n` +
    `control_plane:\n  listen:\n    unix_socket: ${path.join(dataDir, "meidoya.sock")}\n` +
    `  sqlite:\n    path: ${path.join(dataDir, "meidoya.sqlite")}\n` +
    `  temporal:\n    address: 127.0.0.1:7233\n    namespace: default\n` +
    `    control_task_queue: meidoya/control\n\n` +
    `workspaces:\n` +
    workspace(WORKSPACE_A, PROJECT_A, options.ingressA ?? {}, "profile-a") +
    workspace(WORKSPACE_B, PROJECT_B, options.ingressB ?? {}, "profile-b") +
    `\nnodes:\n` +
    `  ${NODE_SHARED}:\n` +
    `    profiles: [mac-restricted]\n` +
    `    capabilities: [repo.read]\n` +
    `    workspaces: [${WORKSPACE_A}, ${WORKSPACE_B}]\n` +
    `    max_concurrency: 2\n` +
    `  ${NODE_B_ONLY}:\n` +
    `    profiles: [mac-restricted]\n` +
    `    capabilities: [repo.read]\n` +
    `    workspaces: [${WORKSPACE_B}]\n` +
    `    max_concurrency: 2\n`
  );
}

/** What a node sends to `node.register`, with only its claim varying. */
export function nodeRegistration(
  nodeId: string,
  workspaceBindings: string[],
  credential?: string,
): MethodParams<"node.register"> {
  return {
    nodeId,
    nodeVersion: "0.1.0",
    protocolVersion: NODE_PROTOCOL_VERSION,
    platform: "darwin",
    arch: "arm64",
    profile: "mac-restricted",
    capabilities: ["repo.read"],
    workspaceBindings,
    maxConcurrency: 2,
    ...(credential === undefined ? {} : { credential }),
  };
}

/** Records what the control plane asked Temporal to do; answers nothing back. */
export class RecordingGateway implements WorkflowGateway {
  readonly submitted: { workspaceId: string; entry: MailboxEntry }[] = [];
  readonly answers: { taskId: string; answer: CheckpointAnswerSignal }[] = [];
  readonly schedules: { workspaceId: string; name: string; messageRef: string }[] = [];
  readonly triggered: { workspaceId: string; name: string }[] = [];
  readonly deleted: { workspaceId: string; name: string }[] = [];

  async submitRequest(workspaceId: string, entry: MailboxEntry): Promise<string> {
    this.submitted.push({ workspaceId, entry });
    return `maid/${workspaceId}`;
  }
  async submitDelegation(workspaceId: string, entry: MailboxEntry): Promise<string> {
    return this.submitRequest(workspaceId, entry);
  }
  async submitCoordination(): Promise<string> {
    return "head-maid/home";
  }
  async answerCheckpoint(taskId: string, answer: CheckpointAnswerSignal): Promise<void> {
    this.answers.push({ taskId, answer });
  }
  async cancelTask(): Promise<void> {}
  async createSchedule(definition: {
    workspaceId: string;
    name: string;
    messageRef: string;
  }): Promise<void> {
    this.schedules.push({
      workspaceId: definition.workspaceId,
      name: definition.name,
      messageRef: definition.messageRef,
    });
  }
  async pauseSchedule(): Promise<void> {}
  async resumeSchedule(): Promise<void> {}
  async triggerSchedule(workspaceId: string, name: string): Promise<void> {
    this.triggered.push({ workspaceId, name });
  }
  async deleteSchedule(workspaceId: string, name: string): Promise<void> {
    this.deleted.push({ workspaceId, name });
  }
}

export type CreateTaskOptions = {
  title?: string;
  summary?: string;
  projects?: string[];
  idempotencyKey?: string;
  parentTaskId?: string;
  conversationId?: string;
};

export type TwoWorkspaceFixture = {
  dataDir: string;
  socketPath: string;
  config: ResolvedControlPlaneConfig;
  db: MeidoyaDatabase;
  repo: SqliteTaskRepository;
  events: ControlEventBus;
  gateway: RecordingGateway;
  service: ControlPlaneService;
  scopes: ScopeRegistry;
  credentials: ClientCredentialStore;
  nodeCredentials: NodeCredentialStore;
  /** The provisioned registration token of a node, read off disk. */
  nodeSecretFor(nodeId: string): string;
  /** Handlers exactly as the daemon registers them, for socket-level tests. */
  handlers: ReturnType<typeof createMethodHandlers>;
  /** A real minted token, verified by the registry before it is handed out. */
  tokenFor(workspaceId: string): string;
  /** The scope a request for this workspace resolves to. Never hand-built. */
  scopeOf(workspaceId: string): ResolvedScope;
  /** The provisioned CLI credential of a workspace, read off disk. */
  secretFor(workspaceId: string): string;
  /** File the workspace's CLI credential lives in. */
  credentialFileFor(workspaceId: string): string;
  createTask(workspaceId: string, options?: CreateTaskOptions): Promise<{ taskId: string }>;
  /** Boots the real socket server over this fixture. Returns the socket path. */
  startServer(): Promise<string>;
  /** Every event the bus published, in order. */
  published: ControlEvent[];
  close(): Promise<void>;
};

export function twoWorkspaces(options: TwoWorkspaceOptions = {}): TwoWorkspaceFixture {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "meidoya-two-ws-"));
  const config = resolveControlPlaneConfig(
    parseControlPlaneConfig(twoWorkspaceConfigYaml(dataDir, options)),
  );
  const now = options.now ?? 1_700_000_000_000;
  const db = openDatabase(config.sqlitePath);
  migrate(db, migrations);
  seedFromConfig(db, config, now);

  const queue = new SerialWriteQueue();
  const repo = new SqliteTaskRepository(db, queue, () => now);
  const events = new ControlEventBus();
  const published: ControlEvent[] = [];
  events.subscribe((event) => void published.push(event));

  const credentials = ClientCredentialStore.provision(dataDir, config.ingressBindings);
  const scopes = new ScopeRegistry(config, loadOrCreateScopeSecret(dataDir), {
    credentials,
    epochs: createSqliteBindingEpochStore(db),
    ...(options.tokenTtlMs === undefined ? {} : { tokenTtlMs: options.tokenTtlMs }),
  });

  const nodeCredentials = NodeCredentialStore.provision(
    dataDir,
    config.nodePolicies.map((policy) => policy.nodeId),
  );

  const gateway = new RecordingGateway();
  const service = new ControlPlaneService({
    config,
    repository: repo,
    scopes,
    gateway,
    events,
    nodeCredentials,
    now: () => now,
    log: () => {},
  });
  const handlers = createMethodHandlers(service);

  const bindingIdOf = (workspaceId: string): string => `cli:${workspaceId}`;

  const credentialFileFor = (workspaceId: string): string => {
    const file = credentials.fileOf(bindingIdOf(workspaceId));
    if (file === undefined) throw new Error(`no CLI credential for ${workspaceId}`);
    return file;
  };

  const secretFor = (workspaceId: string): string =>
    readFileSync(credentialFileFor(workspaceId), "utf8").trim();

  const tokens = new Map<string, string>();
  const tokenFor = (workspaceId: string): string => {
    const cached = tokens.get(workspaceId);
    if (cached !== undefined) return cached;
    const binding = config.ingressBindings.find(
      (row) => row.id === bindingIdOf(workspaceId),
    );
    if (binding === undefined) throw new Error(`no CLI binding for ${workspaceId}`);
    const grant = scopes.mint(
      {
        source: "cli",
        accountRef: null,
        channelRef: binding.channelRef,
        profileRef: binding.profileRef,
      },
      secretFor(workspaceId),
    );
    if ("reason" in grant) throw new Error(`could not mint a token for ${workspaceId}`);
    tokens.set(workspaceId, grant.scopeToken);
    return grant.scopeToken;
  };

  const scopeOf = (workspaceId: string): ResolvedScope => {
    const scope = scopes.resolve(tokenFor(workspaceId));
    if (scope === undefined) throw new Error(`token for ${workspaceId} does not resolve`);
    return scope;
  };

  let server: ControlPlaneServer | undefined;

  return {
    dataDir,
    socketPath: config.socketPath,
    config,
    db,
    repo,
    events,
    gateway,
    service,
    scopes,
    credentials,
    nodeCredentials,
    nodeSecretFor: (nodeId: string): string =>
      readFileSync(nodeCredentialFilePath(dataDir, nodeId), "utf8").trim(),
    handlers,
    published,
    tokenFor,
    scopeOf,
    secretFor,
    credentialFileFor,
    async createTask(workspaceId, taskOptions = {}) {
      const title = taskOptions.title ?? `${workspaceId} task`;
      const result = await service.createTask(scopeOf(workspaceId), {
        title,
        intent: {
          summary: taskOptions.summary ?? title,
          projects: taskOptions.projects ?? [],
          origin: "cli",
        },
        ...(taskOptions.idempotencyKey === undefined
          ? { idempotencyKey: title }
          : { idempotencyKey: taskOptions.idempotencyKey }),
        ...(taskOptions.parentTaskId === undefined
          ? {}
          : { parentTaskId: taskOptions.parentTaskId }),
        ...(taskOptions.conversationId === undefined
          ? {}
          : { conversationId: taskOptions.conversationId }),
      });
      return { taskId: result.task.taskId };
    },
    async startServer() {
      server = new ControlPlaneServer({
        socketPath: config.socketPath,
        service,
        scopes,
        handlers,
        events,
      });
      await server.start();
      return config.socketPath;
    },
    async close() {
      if (server !== undefined) await server.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Runs `fn` and returns the Control Plane refusal it produced. Fails loudly
 * when the call SUCCEEDS, which is the outcome a cross-tenant test is really
 * asserting against.
 */
export async function refusalOf(
  fn: () => unknown,
): Promise<{ kind: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return { kind: error.kind, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a Control Plane refusal, but the call succeeded");
}
