import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { MeidoyaDatabase } from "@meidoya/store-sqlite";
import { migrate, migrations } from "@meidoya/store-sqlite";
import type { ResolvedScope } from "@meidoya/protocol";
import { ControlPlaneError } from "@meidoya/protocol";
import { SqliteTaskRepository, seedFromConfig } from "./repository.js";
import { SerialWriteQueue } from "./write-queue.js";
import { ControlPlaneService } from "./api.js";
import { ControlEventBus } from "./events.js";
import type { ScopeRegistry } from "./scope.js";
import { parseControlPlaneConfig, resolveControlPlaneConfig } from "./config.js";
import { rootTaskIdOfChain } from "./daemon.js";
import { createDelegationPort } from "./delegation.js";
import { DelegationRegistry } from "@meidoya/workspace-scope";
import {
  BUDGET_SNAPSHOT_EVENT,
  createExecutionBudgetPort,
  createSqliteBudgetStateStore,
} from "./ports.js";
import type { MailboxEntry, WorkflowGateway } from "./temporal.js";

/**
 * Two tenants on one daemon. `work-grammarxiv` is the victim; `work-it` is the
 * attacker, and holds a scope token for its own workspace and nothing else.
 */
const CONFIG_YAML = `schema_version: 1

environment:
  id: test-env
  timezone: UTC
  data_dir: /tmp/meidoya-api-test

control_plane:
  listen:
    unix_socket: /tmp/meidoya-api-test/meidoya.sock
  sqlite:
    path: /tmp/meidoya-api-test/meidoya.sqlite
  temporal:
    address: 127.0.0.1:7233
    namespace: default
    control_task_queue: meidoya/control

head_maid:
  enabled: true
  workspace_id: head-maid
  grants:
    work-grammarxiv: [status.read, task.delegate, task-summary.read]
    work-it: [status.read, task.delegate, task-summary.read]

workspaces:
  head-maid:
    kind: coordination
    ingress:
      cli:
        profile: global
    request_policy:
      default_pipeline: cross-workspace
  work-grammarxiv:
    ingress:
      cli:
        profile: work-grammarxiv
    projects:
      grammarxiv:
        workspace_ref: grammarxiv
    limits:
      max_steps: 40
  work-it:
    ingress:
      cli:
        profile: work-it
    projects:
      product-a:
        workspace_ref: product-a
    limits:
      max_steps: 3
  work-secret:
    projects:
      secret:
        workspace_ref: secret
`;

const VICTIM = "work-grammarxiv";
const ATTACKER = "work-it";

class FakeGateway implements WorkflowGateway {
  readonly submitted: { workspaceId: string; entry: MailboxEntry }[] = [];
  readonly coordinated: Parameters<WorkflowGateway["submitCoordination"]>[0][] = [];

  async submitRequest(workspaceId: string, entry: MailboxEntry): Promise<string> {
    this.submitted.push({ workspaceId, entry });
    return `maid/${workspaceId}`;
  }
  async submitDelegation(workspaceId: string, entry: MailboxEntry): Promise<string> {
    return this.submitRequest(workspaceId, entry);
  }
  async submitCoordination(
    input: Parameters<WorkflowGateway["submitCoordination"]>[0],
  ): Promise<string> {
    this.coordinated.push(input);
    return "head-maid/test-env";
  }
  async answerCheckpoint(): Promise<void> {}
  async cancelTask(): Promise<void> {}
  async createSchedule(): Promise<void> {}
  async pauseSchedule(): Promise<void> {}
  async resumeSchedule(): Promise<void> {}
  async triggerSchedule(): Promise<void> {}
  async deleteSchedule(): Promise<void> {}
}

type Fixture = {
  config: ReturnType<typeof resolveControlPlaneConfig>;
  db: MeidoyaDatabase;
  repo: SqliteTaskRepository;
  service: ControlPlaneService;
  gateway: FakeGateway;
  scopeOf: (workspaceId: string) => ResolvedScope;
};

function fixture(): Fixture {
  const config = resolveControlPlaneConfig(parseControlPlaneConfig(CONFIG_YAML));
  const db: MeidoyaDatabase = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, migrations);
  seedFromConfig(db, config, 1_700_000_000);
  const repo = new SqliteTaskRepository(db, new SerialWriteQueue(), () => 1_700_000_000);
  const scopes = {
    projectsOf: (workspaceId: string) =>
      config.workspaces.find((w) => w.workspaceId === workspaceId)?.projects ?? [],
  } as unknown as ScopeRegistry;
  const gateway = new FakeGateway();
  const service = new ControlPlaneService({
    config,
    repository: repo,
    scopes,
    gateway,
    events: new ControlEventBus(),
    now: () => 1_700_000_000,
  });
  return {
    config,
    db,
    repo,
    service,
    gateway,
    scopeOf: (workspaceId) => ({
      workspaceId,
      role: workspaceId === "head-maid" ? "head-maid" : "maid",
      capabilities: [],
    }),
  };
}

function createParams(options: {
  title: string;
  idempotencyKey?: string;
  parentTaskId?: string;
  conversationId?: string;
}) {
  return {
    title: options.title,
    intent: { summary: options.title, projects: [], origin: "cli" as const },
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
  };
}

describe("task.create ownership of caller-supplied ids", () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.db.close();
  });

  it("refuses to parent a task to another workspace's task, and charges no budget to it", async () => {
    const victim = await f.service.createTask(
      f.scopeOf(VICTIM),
      createParams({ title: "victim root", idempotencyKey: "root" }),
    );
    const victimRoot = victim.task.taskId;

    // The attacker knows (or guesses) the victim's task id; that must not be
    // enough to attach to it.
    await expect(
      f.service.createTask(
        f.scopeOf(ATTACKER),
        createParams({ title: "hijack", idempotencyKey: "hijack", parentTaskId: victimRoot }),
      ),
    ).rejects.toMatchObject({ kind: "not_found" });

    // No row anywhere points at the victim's task...
    const children = f.db
      .prepare("SELECT id FROM tasks WHERE parent_task_id = ?")
      .all(victimRoot) as { id: string }[];
    expect(children).toEqual([]);
    // ...and the rejected task was not written at all.
    expect(
      (f.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?").get(ATTACKER) as {
        n: number;
      }).n,
    ).toBe(0);

    // And the consequence the check exists for: the attacker's own task roots
    // at itself, so its steps are spent against its own workspace's ledger and
    // no budget snapshot ever lands on the victim's root.
    const attacker = await f.service.createTask(
      f.scopeOf(ATTACKER),
      createParams({ title: "honest", idempotencyKey: "honest" }),
    );
    const attackerTaskId = attacker.task.taskId;
    expect(rootTaskIdOfChain((id) => f.repo.loadTaskSync(id), attackerTaskId)).toBe(attackerTaskId);

    const budget = createExecutionBudgetPort({
      policyOf: (taskId) => {
        const task = f.repo.loadTaskSync(taskId);
        return task === undefined
          ? undefined
          : resolveControlPlaneConfig(parseControlPlaneConfig(CONFIG_YAML)).workspaces.find(
              (w) => w.workspaceId === task.workspaceId,
            )?.policy;
      },
      rootOf: (taskId) => rootTaskIdOfChain((id) => f.repo.loadTaskSync(id), taskId),
      store: createSqliteBudgetStateStore(f.db, (args) => f.repo.appendTaskEvent(args)),
    });
    const decision = await budget.charge({ taskId: attackerTaskId, kind: "agent-run" });
    expect(decision.allowed).toBe(true);

    const snapshots = f.db
      .prepare("SELECT task_id FROM task_events WHERE event_type = ?")
      .all(BUDGET_SNAPSHOT_EVENT) as { task_id: string }[];
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.map((row) => row.task_id)).not.toContain(victimRoot);
    expect(new Set(snapshots.map((row) => row.task_id))).toEqual(new Set([attackerTaskId]));
  });

  it("refuses a dangling parent explicitly instead of rooting the budget on a ghost id", async () => {
    await expect(
      f.service.createTask(
        f.scopeOf(ATTACKER),
        createParams({ title: "orphan", idempotencyKey: "orphan", parentTaskId: "task-nowhere" }),
      ),
    ).rejects.toBeInstanceOf(ControlPlaneError);
    await expect(
      f.service.createTask(
        f.scopeOf(ATTACKER),
        createParams({ title: "orphan", idempotencyKey: "orphan2", parentTaskId: "task-nowhere" }),
      ),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(
      (f.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n,
    ).toBe(0);
  });

  it("accepts a parent inside the caller's own workspace", async () => {
    const parent = await f.service.createTask(
      f.scopeOf(ATTACKER),
      createParams({ title: "parent", idempotencyKey: "parent" }),
    );
    const child = await f.service.createTask(
      f.scopeOf(ATTACKER),
      createParams({ title: "child", idempotencyKey: "child", parentTaskId: parent.task.taskId }),
    );
    expect(f.repo.loadTaskSync(child.task.taskId)?.parentTaskId).toBe(parent.task.taskId);
    // The budget still belongs to the root, which is the point of the field.
    expect(rootTaskIdOfChain((id) => f.repo.loadTaskSync(id), child.task.taskId)).toBe(
      parent.task.taskId,
    );
  });

  it("refuses a conversation belonging to another workspace", async () => {
    f.db
      .prepare(
        "INSERT INTO conversations (id, workspace_id, external_thread_ref, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("conv-victim", VICTIM, "thread-1", 1_700_000_000);
    await expect(
      f.service.createTask(
        f.scopeOf(ATTACKER),
        createParams({ title: "borrowed thread", conversationId: "conv-victim" }),
      ),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("idempotency keys are per-workspace", () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.db.close();
  });

  it("does not collide across workspaces and does not leak that a key is taken", async () => {
    const victim = await f.service.createTask(
      f.scopeOf(VICTIM),
      createParams({ title: "victim secret", idempotencyKey: "shared-key" }),
    );

    // Same key, different tenant: a fresh create, byte for byte what it would
    // have been had the victim never used the key.
    const attacker = await f.service.createTask(
      f.scopeOf(ATTACKER),
      createParams({ title: "attacker task", idempotencyKey: "shared-key" }),
    );
    expect(attacker.task.taskId).not.toBe(victim.task.taskId);
    expect(attacker.task.title).toBe("attacker task");
    expect(attacker.task.createdAt).toBe(1_700_000_000);
    expect(f.gateway.submitted.map((s) => s.workspaceId)).toEqual([VICTIM, ATTACKER]);

    // A control run in a *third* fixture where the victim never created
    // anything produces the identical result for the attacker: nothing about
    // the response distinguishes "that key is taken next door" from "it is free".
    const control = fixture();
    try {
      const alone = await control.service.createTask(
        control.scopeOf(ATTACKER),
        createParams({ title: "attacker task", idempotencyKey: "shared-key" }),
      );
      expect(alone.task).toEqual(attacker.task);
      expect(alone.temporalWorkflowId).toBe(attacker.temporalWorkflowId);
    } finally {
      control.db.close();
    }

    // The task id no longer contains the caller's key, so ids in one workspace
    // say nothing about ids in another.
    expect(victim.task.taskId).not.toContain("shared-key");
    expect(attacker.task.taskId).not.toContain("shared-key");
  });

  it("still replays the same task for the same key inside one workspace", async () => {
    const first = await f.service.createTask(
      f.scopeOf(VICTIM),
      createParams({ title: "once", idempotencyKey: "same" }),
    );
    const second = await f.service.createTask(
      f.scopeOf(VICTIM),
      createParams({ title: "once again", idempotencyKey: "same" }),
    );
    expect(second.task.taskId).toBe(first.task.taskId);
    expect(second.task.title).toBe("once");
    expect(f.gateway.submitted).toHaveLength(1);
  });

  it("carries the dedicated CLI schedule hint into the Maid mailbox", async () => {
    await f.service.createTask(f.scopeOf(VICTIM), {
      ...createParams({ title: "平日の朝9時にREADMEを確認して" }),
      interpretation: "schedule",
    });

    expect(f.gateway.submitted).toMatchObject([
      {
        workspaceId: VICTIM,
        entry: {
          origin: "cli",
          interpretation: "schedule",
        },
      },
    ]);
  });
});

describe("Head Maid coordination ingress", () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.db.close();
  });

  it("creates one coordination task and submits only granted targets", async () => {
    const storedGrants = f.db
      .prepare(
        "SELECT target_workspace_id AS target, enabled FROM delegation_grants ORDER BY target_workspace_id",
      )
      .all() as { target: string; enabled: number }[];
    expect(storedGrants).toEqual([
      { target: VICTIM, enabled: 1 },
      { target: ATTACKER, enabled: 1 },
    ]);

    const result = await f.service.createTask(f.scopeOf("head-maid"), {
      title: "compare both workspaces",
      intent: {
        summary: "compare both workspaces",
        projects: [],
        origin: "cli",
      },
      targetWorkspaceIds: [VICTIM, ATTACKER],
      idempotencyKey: "coordination-1",
    });

    expect(result.task.pipeline).toBe("cross-workspace");
    expect(result.temporalWorkflowId).toBe(`cross-workspace/${result.task.taskId}`);
    expect(f.gateway.coordinated).toEqual([
      expect.objectContaining({
        coordinationWorkspaceId: "head-maid",
        taskId: result.task.taskId,
        targetWorkspaceIds: [VICTIM, ATTACKER],
      }),
    ]);
    expect(f.gateway.submitted).toEqual([]);
  });

  it("makes an ungranted workspace indistinguishable from an unknown one", async () => {
    const create = (targetWorkspaceId: string) =>
      f.service.createTask(f.scopeOf("head-maid"), {
        title: "probe",
        intent: { summary: "probe", projects: [], origin: "cli" },
        targetWorkspaceIds: [targetWorkspaceId],
      });

    const ungranted = await create("work-secret").catch((error: unknown) => error);
    const unknown = await create("does-not-exist").catch((error: unknown) => error);
    expect(ungranted).toMatchObject({ kind: "not_found", message: "workspace work-secret not found" });
    expect(unknown).toMatchObject({ kind: "not_found", message: "workspace does-not-exist not found" });
    expect(f.gateway.coordinated).toEqual([]);
  });

  it("reports global status for granted workspaces and no others", async () => {
    await f.service.createTask(
      f.scopeOf(VICTIM),
      createParams({ title: "visible A", idempotencyKey: "visible-a" }),
    );
    await f.service.createTask(
      f.scopeOf(ATTACKER),
      createParams({ title: "visible B", idempotencyKey: "visible-b" }),
    );

    const status = f.service.readWorkspaceStatus(f.scopeOf("head-maid"), {
      includeSchedules: true,
    });
    expect(status.workspaces?.map((workspace) => workspace.workspaceId)).toEqual([
      VICTIM,
      ATTACKER,
    ]);
    expect(status.workspaces?.flatMap((workspace) => workspace.activeTasks.map((task) => task.title)))
      .toEqual(["visible A", "visible B"]);
    expect(status.workspaces?.some((workspace) => workspace.workspaceId === "work-secret"))
      .toBe(false);
  });
});

describe("production delegation port", () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.db.close();
  });

  const input = (targetWorkspaceId: string) => ({
    environmentId: "test-env",
    parentTaskId: "coord-1",
    coordinationWorkflowId: "cross-workspace/coord-1",
    targetWorkspaceId,
    brief: { summary: "delegated work", projects: [], origin: "delegation" as const },
    idempotencyKey: `delegation:coord-1:${targetWorkspaceId}`,
  });

  it("checks grants before touching an ungranted workspace", async () => {
    const port = createDelegationPort({
      registry: new DelegationRegistry([]),
      workspaces: new Map(f.config.workspaces.map((workspace) => [workspace.workspaceId, workspace])),
      repository: f.repo,
      gateway: f.gateway,
    });

    await expect(port.create(input(VICTIM))).rejects.toThrow("delegation target not found");
    expect(f.repo.listTasks(VICTIM, { limit: 10 })).toEqual([]);
    expect(f.gateway.submitted).toEqual([]);
  });

  it("creates a workspace-local child and submits it through that workspace's Maid", async () => {
    await f.repo.createTask({
      taskId: "coord-1",
      workspaceId: "head-maid",
      origin: "cli",
      pipeline: "cross-workspace",
      title: "coordinate",
      intent: { summary: "coordinate", projects: [], origin: "cli" },
      temporalWorkflowId: "cross-workspace/coord-1",
      now: 1_700_000_000,
    });
    const port = createDelegationPort({
      registry: new DelegationRegistry([
        {
          source: "global",
          target: VICTIM,
          capabilities: ["task.delegate", "task-summary.read"],
        },
      ]),
      workspaces: new Map(f.config.workspaces.map((workspace) => [workspace.workspaceId, workspace])),
      repository: f.repo,
      gateway: f.gateway,
      now: () => 1_700_000_001,
    });

    const result = await port.create(input(VICTIM));
    const child = f.repo.loadTaskSync(result.childTaskId);
    expect(child).toMatchObject({
      workspaceId: VICTIM,
      origin: "delegation",
      parentTaskId: "coord-1",
    });
    expect(f.gateway.submitted).toEqual([
      expect.objectContaining({
        workspaceId: VICTIM,
        entry: expect.objectContaining({
          origin: "delegation",
          delegation: expect.objectContaining({
            childTaskId: result.childTaskId,
            rootTaskId: "coord-1",
            coordinationWorkflowId: "cross-workspace/coord-1",
          }),
        }),
      }),
    ]);
  });
});
