import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { MeidoyaDatabase } from "@meidoya/store-sqlite";
import { listCandidates, migrate, migrations, releaseLatch } from "@meidoya/store-sqlite";
import { openCheckpoint } from "@meidoya/checkpoint-policy";
import type { ResolvedScope } from "@meidoya/protocol";
import { ControlPlaneError } from "@meidoya/protocol";
import type { HumanCheckpoint } from "@meidoya/domain";
import {
  CheckpointConflictError,
  SqliteTaskRepository,
  TransactionScopeError,
  seedFromConfig,
  type CreateTaskInput,
} from "./repository.js";
import { SerialWriteQueue } from "./write-queue.js";
import { ControlPlaneService } from "./api.js";
import { ControlEventBus } from "./events.js";
import { ScopeRegistry } from "./scope.js";
import { parseControlPlaneConfig, resolveControlPlaneConfig } from "./config.js";
import type {
  CheckpointAnswerSignal,
  MailboxEntry,
  WorkflowGateway,
} from "./temporal.js";

const WORKSPACE = "work-it";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Flushes the microtask queue plus one macrotask turn — no wall-clock waiting. */
async function settleTurns(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Deliberately inlined rather than reusing testing/harness.ts: that module
 * pulls in the whole daemon (and with it every agent runtime package), which
 * these repository-level tests have no need of.
 */
const CONFIG_YAML = `schema_version: 1

environment:
  id: test-env
  timezone: UTC
  data_dir: /tmp/meidoya-repo-test

control_plane:
  listen:
    unix_socket: /tmp/meidoya-repo-test/meidoya.sock
  sqlite:
    path: /tmp/meidoya-repo-test/meidoya.sqlite
  temporal:
    address: 127.0.0.1:7233
    namespace: default
    control_task_queue: meidoya/control

workspaces:
  work-it:
    ingress:
      cli:
        profile: work-it
    projects:
      product-a:
        workspace_ref: product-a
    human_gates:
      clarification: never
      plan: always
      review: never
      side_effect: policy
`;

function config() {
  return resolveControlPlaneConfig(parseControlPlaneConfig(CONFIG_YAML));
}

function taskInput(id: string, now = 1_700_000_000): CreateTaskInput {
  return {
    taskId: id,
    workspaceId: WORKSPACE,
    origin: "cli",
    pipeline: "coding",
    title: id,
    intent: { summary: id, projects: ["product-a"], origin: "cli" },
    temporalWorkflowId: `task/${id}`,
    now,
  };
}

class RollbackSignal extends Error {}

type Fixture = {
  db: MeidoyaDatabase;
  queue: SerialWriteQueue;
  repo: SqliteTaskRepository;
};

function fixture(): Fixture {
  const db: MeidoyaDatabase = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, migrations);
  seedFromConfig(db, config(), 1_700_000_000);
  const queue = new SerialWriteQueue();
  return { db, queue, repo: new SqliteTaskRepository(db, queue, () => 1_700_000_000) };
}

describe("transaction scoping", () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.db.close();
  });

  it("does not discard a concurrent unrelated write when a transaction rolls back", async () => {
    await f.repo.createTask(taskInput("task-existing"));

    const insideTransaction = deferred();
    const concurrentIssued = deferred();

    const tx = f.repo.transaction(async (scope) => {
      await scope.updateTaskStatus({
        taskId: "task-existing",
        nextStatus: "running",
        expectedVersion: 0,
      });
      insideTransaction.resolve();
      await concurrentIssued.promise;
      // A *designed* control-flow rollback, exactly like completeTask's
      // version-conflict signal.
      throw new RollbackSignal("version-conflict");
    });

    // This continuation was scheduled from the test's async context, so it does
    // not inherit the transaction's context: the write below is unrelated.
    await insideTransaction.promise;
    const concurrent = f.repo.createTask(taskInput("task-concurrent"));
    concurrentIssued.resolve();

    await expect(tx).rejects.toBeInstanceOf(RollbackSignal);
    await expect(concurrent).resolves.toMatchObject({ id: "task-concurrent" });

    // The unrelated row survived somebody else's ROLLBACK ...
    expect(f.repo.loadTaskSync("task-concurrent")).toBeDefined();
    // ... and the transaction's own write really was rolled back.
    expect(f.repo.loadTaskSync("task-existing")?.status).toBe("received");
  });

  it("never reports a write as successful to its caller before the enclosing transaction settles", async () => {
    await f.repo.createTask(taskInput("task-a"));

    const insideTransaction = deferred();
    const release = deferred();
    let concurrentSettled = false;

    const tx = f.repo.transaction(async () => {
      insideTransaction.resolve();
      await release.promise;
      throw new RollbackSignal("boom");
    });

    await insideTransaction.promise;
    const concurrent = f.repo
      .createTask(taskInput("task-b"))
      .then((task) => {
        concurrentSettled = true;
        return task;
      });

    // Deterministic: drain the event loop while the transaction is still open.
    await settleTurns();
    expect(concurrentSettled).toBe(false);
    expect(f.repo.loadTaskSync("task-b")).toBeUndefined();

    release.resolve();
    await expect(tx).rejects.toBeInstanceOf(RollbackSignal);
    await concurrent;
    expect(concurrentSettled).toBe(true);
    // Reported successful, and still there afterwards.
    expect(f.repo.loadTaskSync("task-b")).toBeDefined();
  });

  it("commits every write issued through the transaction handle", async () => {
    await f.repo.createTask(taskInput("task-tx"));

    await f.repo.transaction(async (scope) => {
      await scope.updateTaskStatus({
        taskId: "task-tx",
        nextStatus: "running",
        expectedVersion: 0,
      });
      await scope.appendTaskEvent({
        taskId: "task-tx",
        eventType: "TaskStarted",
        idempotencyKey: "task-tx:started",
        payload: {},
      });
    });

    expect(f.repo.loadTaskSync("task-tx")?.status).toBe("running");
    expect(f.repo.listTaskEvents("task-tx")).toHaveLength(1);
  });

  it("rejects use of a transaction handle after the transaction settled", async () => {
    let leaked: Parameters<Parameters<SqliteTaskRepository["transaction"]>[0]>[0] | undefined;
    await f.repo.transaction(async (scope) => {
      leaked = scope;
    });
    expect(leaked).toBeDefined();
    expect(() => leaked?.forceTaskStatus("task-x", "cancelled")).toThrow(/already been settled/);
  });

  /* ------------------------------------------------------------------ *
   * The original defect, for callees.
   *
   * AsyncLocalStorage keys on async *context*, and a component invoked from
   * inside a transaction body inherits that context. Without the handle-depth
   * signal, its write is inlined into the caller's BEGIN/COMMIT span and
   * destroyed by the caller's ROLLBACK — the exact bug the per-instance
   * `#inTransaction` flag caused, surviving in a narrower form.
   * ------------------------------------------------------------------ */

  /** Stands in for any component wired with the repository (execution budget
   * store, chat gateway, status projector) that a transaction body calls. */
  class DownstreamComponent {
    constructor(private readonly repo: SqliteTaskRepository) {}

    record(taskId: string, key: string): Promise<void> {
      return this.repo.appendTaskEvent({
        taskId,
        eventType: "BudgetConsumed",
        idempotencyKey: key,
        payload: { units: 1 },
      });
    }
  }

  it("refuses a callee's write instead of enrolling it in the caller's transaction", async () => {
    await f.repo.createTask(taskInput("task-tx"));
    const component = new DownstreamComponent(f.repo);
    let calleeOutcome: unknown;

    await expect(
      f.repo.transaction(async (scope) => {
        await scope.updateTaskStatus({
          taskId: "task-tx",
          nextStatus: "running",
          expectedVersion: 0,
        });
        // A component the body happens to call. It shares this async context
        // and holds the same repository, but it does NOT hold the handle.
        calleeOutcome = await component.record("task-tx", "budget:1").then(
          () => undefined,
          (error: unknown) => error,
        );
        throw new RollbackSignal("version-conflict");
      }),
    ).rejects.toBeInstanceOf(RollbackSignal);

    // The refusal is explicit — the callee learns its write did not happen.
    expect(calleeOutcome).toBeInstanceOf(TransactionScopeError);
    // The transaction's own write really was rolled back ...
    expect(f.repo.loadTaskSync("task-tx")?.status).toBe("received");
    // ... and the callee's write was never silently dragged into that ROLLBACK.
    expect(f.repo.listTaskEvents("task-tx")).toHaveLength(0);
    // It is still perfectly writable afterwards, from outside the span.
    await component.record("task-tx", "budget:1");
    expect(f.repo.listTaskEvents("task-tx")).toHaveLength(1);
  });

  it("refuses a second repository's write on the same write queue", async () => {
    const other = new SqliteTaskRepository(f.db, f.queue, () => 1_700_000_000);
    let outcome: unknown;

    await f.repo.transaction(async (scope) => {
      await scope.createTask(taskInput("task-tx"));
      outcome = await other.createTask(taskInput("task-other")).then(
        () => undefined,
        (error: unknown) => error,
      );
    });

    // Queueing it would deadlock (the slot is held); inlining it would expose
    // it to a foreign ROLLBACK. Neither happens.
    expect(outcome).toBeInstanceOf(TransactionScopeError);
    expect(f.repo.loadTaskSync("task-other")).toBeUndefined();
    expect(f.repo.loadTaskSync("task-tx")).toBeDefined();
  });

  it("refuses a nested transaction opened from inside a scoped transaction", async () => {
    let outcome: unknown;

    await f.repo.transaction(async (scope) => {
      await scope.createTask(taskInput("task-tx"));
      outcome = await f.repo
        .transaction(async (inner) => inner.forceTaskStatus("task-tx", "cancelled"))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    });

    expect(outcome).toBeInstanceOf(TransactionScopeError);
    expect(f.repo.loadTaskSync("task-tx")?.status).toBe("received");
  });

  /* ------------------------------------------------------------------ *
   * Continuations registered inside a transaction body.
   * ------------------------------------------------------------------ */

  it("queues a continuation registered inside a transaction body instead of rejecting it", async () => {
    const settled = deferred();
    let late: Promise<unknown> | undefined;

    await f.repo.transaction(async (scope) => {
      await scope.createTask(taskInput("task-tx"));
      // Registered inside the body, so it inherits the transaction's async
      // context — but it only runs after the span has closed. Its inherited
      // context is stale, not open, and must not make it permanently unwritable.
      void settled.promise.then(() => {
        late = f.repo.createTask(taskInput("task-late"));
      });
    });

    settled.resolve();
    await settleTurns();

    expect(late).toBeDefined();
    await expect(late).resolves.toMatchObject({ id: "task-late" });
    expect(f.repo.loadTaskSync("task-late")).toBeDefined();
    expect(f.repo.loadTaskSync("task-tx")).toBeDefined();
  });

  it("queues a setImmediate continuation registered inside a transaction body", async () => {
    let late: Promise<unknown> | undefined;

    await f.repo.transaction(async (scope) => {
      await scope.createTask(taskInput("task-tx"));
      setImmediate(() => {
        late = f.repo.createTask(taskInput("task-late"));
      });
    });

    await settleTurns();
    await expect(late).resolves.toMatchObject({ id: "task-late" });
  });

  /* ------------------------------------------------------------------ *
   * The latent whole-daemon deadlock.
   * ------------------------------------------------------------------ */

  it("rejects a guarded raw queue write issued from inside a transaction", async () => {
    let runnerOutcome: unknown;
    // The exact shape daemon.ts injects into the chat gateway and the outbox
    // publisher, but routed through the repository's guarded entry point.
    const runWrite = <T>(fn: () => T): Promise<T> => f.repo.runWrite(fn);

    await f.repo.transaction(async (scope) => {
      await scope.createTask(taskInput("task-tx"));
      runnerOutcome = await runWrite(() =>
        f.db.prepare("INSERT INTO task_events (id, task_id, event_type, idempotency_key, payload_json, created_at) VALUES ('e','task-tx','X','x','{}',0)").run(),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
    });

    expect(runnerOutcome).toBeInstanceOf(TransactionScopeError);
    // The queue is not wedged: it drains and keeps accepting work.
    await f.queue.drain();
    await expect(f.repo.createTask(taskInput("task-after"))).resolves.toMatchObject({
      id: "task-after",
    });
    expect(f.repo.listTaskEvents("task-tx")).toHaveLength(0);
  });

  it("shows that the unguarded queue runner is the deadlock the guard prevents", async () => {
    let unguardedSettled = false;

    const wedged = f.repo.transaction(async (scope) => {
      await scope.createTask(taskInput("task-tx"));
      // What daemon.ts's `runWrite: (fn) => queue.enqueue(fn)` does today. The
      // slot is held by this very transaction, so this can never resolve.
      await f.queue.enqueue(() => {
        unguardedSettled = true;
      });
    });
    wedged.then(
      () => undefined,
      () => undefined,
    );

    await settleTurns(5);
    expect(unguardedSettled).toBe(false);
    // ... and the whole queue is stuck behind the never-closing BEGIN IMMEDIATE.
    let laterSettled = false;
    void f.repo.createTask(taskInput("task-after")).then(
      () => {
        laterSettled = true;
      },
      () => {
        laterSettled = true;
      },
    );
    await settleTurns(5);
    expect(laterSettled).toBe(false);
  });

  /* ------------------------------------------------------------------ *
   * Legacy ambient mode — what production still runs on. Deprecated, but it
   * ships, so it is tested. See "shipped path is the tested path" below.
   * ------------------------------------------------------------------ */

  it("commits ambient writes issued by a zero-arity (legacy) transaction body", async () => {
    await f.repo.createTask(taskInput("task-tx"));

    // Byte-for-byte the shape of completion.ts / activities.ts today.
    await f.repo.transaction(async () => {
      const applied = await f.repo.updateTaskStatus({
        taskId: "task-tx",
        nextStatus: "running",
        expectedVersion: 0,
      });
      expect(applied).toBe(true);
      await f.repo.appendTaskEvent({
        taskId: "task-tx",
        eventType: "TaskStarted",
        idempotencyKey: "task-tx:started",
        payload: {},
      });
    });

    expect(f.repo.loadTaskSync("task-tx")?.status).toBe("running");
    expect(f.repo.listTaskEvents("task-tx")).toHaveLength(1);
  });

  it("rolls back every ambient write of a zero-arity (legacy) transaction body", async () => {
    await f.repo.createTask(taskInput("task-tx"));

    await expect(
      f.repo.transaction(async () => {
        await f.repo.updateTaskStatus({
          taskId: "task-tx",
          nextStatus: "running",
          expectedVersion: 0,
        });
        await f.repo.appendTaskEvent({
          taskId: "task-tx",
          eventType: "TaskStarted",
          idempotencyKey: "task-tx:started",
          payload: {},
        });
        throw new RollbackSignal("version-conflict");
      }),
    ).rejects.toBeInstanceOf(RollbackSignal);

    expect(f.repo.loadTaskSync("task-tx")?.status).toBe("received");
    expect(f.repo.listTaskEvents("task-tx")).toHaveLength(0);
  });

  it("still keeps an unrelated concurrent write out of a legacy transaction", async () => {
    await f.repo.createTask(taskInput("task-existing"));
    const insideTransaction = deferred();
    const concurrentIssued = deferred();

    const tx = f.repo.transaction(async () => {
      await f.repo.updateTaskStatus({
        taskId: "task-existing",
        nextStatus: "running",
        expectedVersion: 0,
      });
      insideTransaction.resolve();
      await concurrentIssued.promise;
      throw new RollbackSignal("version-conflict");
    });

    await insideTransaction.promise;
    const concurrent = f.repo.createTask(taskInput("task-concurrent"));
    concurrentIssued.resolve();

    await expect(tx).rejects.toBeInstanceOf(RollbackSignal);
    await expect(concurrent).resolves.toMatchObject({ id: "task-concurrent" });
    expect(f.repo.loadTaskSync("task-concurrent")).toBeDefined();
    expect(f.repo.loadTaskSync("task-existing")?.status).toBe("received");
  });

  it("refuses a guarded raw queue write from inside a legacy transaction too", async () => {
    let runnerOutcome: unknown;

    await f.repo.transaction(async () => {
      await f.repo.createTask(taskInput("task-tx"));
      runnerOutcome = await f.repo.runWrite(() => 1).then(
        () => undefined,
        (error: unknown) => error,
      );
    });

    expect(runnerOutcome).toBeInstanceOf(TransactionScopeError);
    await f.queue.drain();
  });

  /**
   * A transaction that is already closed when the body fails. SQLite ends the
   * span itself in several situations (a failed COMMIT, a statement that forces
   * a rollback), and the unconditional `ROLLBACK` in the catch block then threw
   * "cannot rollback - no transaction is active" — replacing the error the
   * caller needed with a misleading one, and leaving this queue slot to fail
   * the same way for the life of the process.
   */
  it("reports the body's own error when the transaction is already closed", async () => {
    await f.repo.createTask(taskInput("task-existing"));

    const outcome = await f.repo
      .transaction(async () => {
        f.db.exec("ROLLBACK");
        throw new RollbackSignal("the error the caller must actually see");
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(outcome).toBeInstanceOf(RollbackSignal);
    expect((outcome as Error).message).toBe("the error the caller must actually see");
  });

  it("leaves the write queue usable after a transaction closed under it", async () => {
    await f.repo
      .transaction(async () => {
        f.db.exec("ROLLBACK");
        throw new RollbackSignal("boom");
      })
      .catch(() => undefined);

    // The single serial queue is the whole daemon's write path: wedging it is
    // not one failed request, it is every future write in the process.
    await expect(f.repo.createTask(taskInput("task-after"))).resolves.toMatchObject({
      id: "task-after",
    });
    await expect(
      f.repo.transaction(async (scope) => {
        await scope.createTask(taskInput("task-after-tx"));
        return "committed";
      }),
    ).resolves.toBe("committed");
    expect(f.repo.loadTaskSync("task-after-tx")).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * #11d: the path production uses must be the path under test.
 * ------------------------------------------------------------------ */

type TransactionMode = "ambient" | "scoped";
type CallSite = { file: string; line: number; mode: TransactionMode; body: string };

const REPO_WRITE_METHODS = [
  "createTask",
  "updateTaskStatus",
  "forceTaskStatus",
  "appendTaskEvent",
  "upsertStep",
  "recordCheckpoint",
  "resolveCheckpoint",
  "saveArtifacts",
  "enqueueNotification",
];

/**
 * Extracts the argument text of every `repo(sitory).transaction(` call. A tiny
 * paren matcher that skips string literals and comments — enough for the four
 * source files it is pointed at, and it fails loudly (unterminated call) rather
 * than silently mis-parsing.
 */
function transactionCallSites(source: string, file: string): CallSite[] {
  const sites: CallSite[] = [];
  const opener = /\b(?:repository|repo)\.transaction\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    let quote: string | undefined;
    for (; i < source.length && depth > 0; i += 1) {
      const c = source[i];
      if (quote !== undefined) {
        if (c === "\\") i += 1;
        else if (c === quote) quote = undefined;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") quote = c;
      else if (c === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
      } else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
    }
    if (depth !== 0) throw new Error(`unterminated transaction( call in ${file}`);
    const argument = source.slice(start, i - 1);
    const head = /^\s*(?:async\s*)?\(([^)]*)\)\s*=>/.exec(argument);
    if (head === null) throw new Error(`unrecognised transaction body in ${file}: ${argument.slice(0, 60)}`);
    sites.push({
      file,
      line: source.slice(0, match.index).split("\n").length,
      mode: (head[1] ?? "").trim() === "" ? "ambient" : "scoped",
      body: argument,
    });
  }
  return sites;
}

describe("shipped path is the tested path", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  const productionFiles = [
    "packages/task-engine/src/completion.ts",
    "packages/workflows-temporal/src/activities.ts",
    "apps/meidoyad/src/api.ts",
  ];

  function sitesIn(relative: string): CallSite[] {
    return transactionCallSites(readFileSync(resolve(root, relative), "utf8"), relative);
  }

  const productionSites = productionFiles.flatMap(sitesIn);
  const testedSites = sitesIn("apps/meidoyad/src/repository.test.ts");

  it("finds the production transaction call sites at all (guards against the scan silently going blind)", () => {
    expect(productionSites.length).toBeGreaterThanOrEqual(8);
  });

  it("exercises every transaction mode production uses", () => {
    const shipped = new Set(productionSites.map((s) => s.mode));
    const tested = new Set(testedSites.map((s) => s.mode));
    // The failure this catches: production migrates to (or stays on) a mode
    // that no test in this file drives, which is how #11d happened.
    for (const mode of shipped) {
      expect(
        { mode, tested: tested.has(mode), sites: productionSites.filter((s) => s.mode === mode).map((s) => `${s.file}:${s.line}`) },
      ).toMatchObject({ tested: true });
    }
  });

  it("has no production transaction body that would now throw at runtime", () => {
    // A `scoped` body (one that declares the handle) may not write ambiently:
    // those writes are refused, by design. This is the migration tripwire.
    const ambientWrite = new RegExp(`\\b(?:repository|repo)\\.(?:${REPO_WRITE_METHODS.join("|")})\\s*\\(`);
    const offenders = productionSites
      .filter((s) => s.mode === "scoped" && ambientWrite.test(s.body))
      .map((s) => `${s.file}:${s.line}`);
    expect(offenders).toEqual([]);
  });
});

describe("resolveCheckpoint compare-and-swap", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = fixture();
    await f.repo.createTask(taskInput("task-cp"));
    await f.repo.recordCheckpoint(
      openCheckpoint({
        id: "cp-1",
        taskId: "task-cp",
        kind: "plan-approval",
        prompt: "Approve?",
      }),
    );
  });

  afterEach(() => {
    f.db.close();
  });

  function resolved(status: HumanCheckpoint["status"]): HumanCheckpoint {
    const current = f.repo.loadCheckpointSync("cp-1");
    if (current === undefined) throw new Error("missing checkpoint");
    return { ...current, status, version: current.version + 1 };
  }

  it("lets exactly one of two concurrent resolutions win", async () => {
    const approve = { ...resolved("approved") };
    const reject = { ...resolved("rejected") };

    const results = await Promise.allSettled([
      f.repo.resolveCheckpoint(approve, { decision: "approved" }),
      f.repo.resolveCheckpoint(reject, { decision: "rejected" }),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const loser = results[1];
    expect(loser?.status === "rejected" && loser.reason).toBeInstanceOf(CheckpointConflictError);

    const after = f.repo.loadCheckpointSync("cp-1");
    expect(after?.status).toBe("approved");
    expect(after?.version).toBe(2);
  });

  it("fails cleanly when answering an already-resolved checkpoint", async () => {
    await f.repo.resolveCheckpoint(resolved("approved"), { decision: "approved" });
    const stale = { ...openCheckpoint({ id: "cp-1", taskId: "task-cp", kind: "plan-approval", prompt: "Approve?" }), status: "rejected" as const, version: 2 };

    await expect(f.repo.resolveCheckpoint(stale, { decision: "rejected" })).rejects.toMatchObject({
      name: "CheckpointConflictError",
      currentVersion: 2,
      currentStatus: "approved",
    });
    expect(f.repo.loadCheckpointSync("cp-1")?.status).toBe("approved");
    expect(f.repo.loadCheckpointSync("cp-1")?.version).toBe(2);
  });
});

/* ------------------------------------------------------- service level */

class RecordingGateway implements WorkflowGateway {
  readonly answers: CheckpointAnswerSignal[] = [];
  /** Number of upcoming `answerCheckpoint` calls that fail before recording. */
  failNextAnswers = 0;
  /** Error the injected failures raise (a transport error by default). */
  answerError: () => Error = () => new Error("ECONNRESET: temporal connection lost");

  async submitRequest(_workspaceId: string, entry: MailboxEntry): Promise<string> {
    return entry.requestKey;
  }
  async submitDelegation(_workspaceId: string, entry: MailboxEntry): Promise<string> {
    return entry.requestKey;
  }
  async submitCoordination(): Promise<string> {
    return "head-maid/home";
  }
  async answerCheckpoint(_taskId: string, answer: CheckpointAnswerSignal): Promise<void> {
    if (this.failNextAnswers > 0) {
      this.failNextAnswers -= 1;
      throw this.answerError();
    }
    this.answers.push(answer);
  }
  async cancelTask(): Promise<void> {}
  async createSchedule(): Promise<void> {}
  async pauseSchedule(): Promise<void> {}
  async resumeSchedule(): Promise<void> {}
  async triggerSchedule(): Promise<void> {}
  async deleteSchedule(): Promise<void> {}
}

describe("checkpoint.answer concurrency", () => {
  let f: Fixture;
  let gateway: RecordingGateway;
  let service: ControlPlaneService;
  let scope: ResolvedScope;

  beforeEach(async () => {
    f = fixture();
    const resolvedConfig = config();
    // Only `projectsOf` is reachable from the checkpoint paths under test;
    // minting real tokens would couple these tests to the scope registry.
    const scopes = {
      projectsOf: (workspaceId: string) =>
        resolvedConfig.workspaces.find((w) => w.workspaceId === workspaceId)?.projects ?? [],
    } as unknown as ScopeRegistry;
    scope = { workspaceId: WORKSPACE, role: "maid", capabilities: [] };

    gateway = new RecordingGateway();
    service = new ControlPlaneService({
      config: resolvedConfig,
      repository: f.repo,
      scopes,
      gateway,
      events: new ControlEventBus(),
      now: () => 1_700_000_000,
    });

    await f.repo.createTask(taskInput("task-cp"));
    await f.repo.recordCheckpoint(
      openCheckpoint({
        id: "cp-1",
        taskId: "task-cp",
        kind: "plan-approval",
        prompt: "Approve?",
      }),
    );
  });

  afterEach(() => {
    f.db.close();
  });

  it("resolves a concurrent approve+reject exactly once and signals the workflow once", async () => {
    // Both calls run their synchronous pre-read before either write reaches the
    // queue: the interleaving is forced, not raced against a timer.
    const approve = service.answerCheckpoint(scope, {
      checkpointId: "cp-1",
      decision: "approve",
      expectedVersion: 1,
    });
    const reject = service.answerCheckpoint(scope, {
      checkpointId: "cp-1",
      decision: "reject",
      expectedVersion: 1,
    });

    const results = await Promise.allSettled([approve, reject]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejectedResults = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejectedResults).toHaveLength(1);
    const failure = rejectedResults[0];
    const reason = failure?.status === "rejected" ? failure.reason : undefined;
    expect(reason).toBeInstanceOf(ControlPlaneError);
    expect((reason as ControlPlaneError).kind).toBe("conflict");

    expect(gateway.answers).toHaveLength(1);
    const winner = f.repo.loadCheckpointSync("cp-1");
    expect(winner?.version).toBe(2);
    expect(["approved", "rejected"]).toContain(winner?.status);
    expect(gateway.answers[0]?.answer).toBe(winner?.status);
  });

  it("refuses a second answer to an already-resolved checkpoint without signalling again", async () => {
    await service.answerCheckpoint(scope, {
      checkpointId: "cp-1",
      decision: "approve",
      expectedVersion: 1,
    });
    expect(gateway.answers).toHaveLength(1);

    // Stale version (what a client that read before the first answer sends).
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "reject",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ kind: "conflict" });

    // Current version, but the checkpoint is no longer pending.
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "reject",
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ kind: "conflict" });

    expect(gateway.answers).toHaveLength(1);
    expect(f.repo.loadCheckpointSync("cp-1")).toMatchObject({ status: "approved", version: 2 });
  });
});

/* ------------------------------------------------- delivery backfill */

/* ------------------------------------------- the delivery latch and backlog */

/**
 * `markCheckpointSignalled` is documented as a ONE-WAY latch, and
 * `listUndeliveredCheckpoints` is the sweep's only query. Both are enforcement:
 * without the latch's `signalled_at IS NULL` guard a retry racing the sweep
 * silently rewrites the delivery time (and the return value that says who
 * actually delivered becomes a lie), and without the backlog's
 * `status != 'pending'` guard the sweep would latch checkpoints nobody has
 * answered yet — turning every future answer to them into a permanent 409.
 */
describe("checkpoint delivery latch", () => {
  let db: MeidoyaDatabase;
  let repo: SqliteTaskRepository;
  let clock: number;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, migrations);
    seedFromConfig(db, config(), 1_700_000_000);
    clock = 1_700_000_000;
    repo = new SqliteTaskRepository(db, new SerialWriteQueue(), () => clock);
    await repo.createTask(taskInput("task-latch"));
    await repo.recordCheckpoint(
      openCheckpoint({ id: "cp-latch", taskId: "task-latch", kind: "plan-approval", prompt: "p" }),
    );
  });

  afterEach(() => {
    db.close();
  });

  function signalledAt(id: string): number | null {
    const row = db.prepare("SELECT signalled_at FROM checkpoints WHERE id = ?").get(id) as
      | { signalled_at: number | null }
      | undefined;
    return row?.signalled_at ?? null;
  }

  it("latches once and only once, and never moves the recorded delivery time", async () => {
    const resolved = await repo.loadCheckpointSync("cp-latch");
    expect(resolved).toBeDefined();
    await repo.resolveCheckpoint({ ...resolved!, status: "approved", version: 2 }, {
      decision: "approved",
    });

    expect(await repo.markCheckpointSignalled("cp-latch")).toBe(true);
    const first = signalledAt("cp-latch");
    expect(first).toBe(1_700_000_000);

    // A second delivery — a client retry racing the sweep — reaches the latch
    // later. It must not claim to be the one that delivered, and it must not
    // rewrite when delivery actually happened.
    clock = 1_700_009_999;
    expect(await repo.markCheckpointSignalled("cp-latch")).toBe(false);
    expect(await repo.markCheckpointSignalled("cp-latch")).toBe(false);
    expect(signalledAt("cp-latch")).toBe(first);
  });

  /**
   * The transaction handle is the only way into a scoped transaction, so a
   * parameter it forgets to forward is a parameter no caller can supply. This
   * one says WHY the row is latched, and dropping it recorded a discarded
   * answer — one thrown away because its workflow was gone — as a delivered
   * one. Migration 0006 did that damage from the other direction and cost a
   * false "DISCARDED a committed checkpoint answer"; this way round it makes a
   * real loss invisible.
   */
  it("forwards the latch's provenance through a transaction scope", async () => {
    const resolved = repo.loadCheckpointSync("cp-latch");
    await repo.resolveCheckpoint({ ...resolved!, status: "approved", version: 2 }, {
      decision: "approved",
    });

    await repo.transaction(async (tx) => {
      expect(await tx.markCheckpointSignalled("cp-latch", "discarded")).toBe(true);
    });

    const row = db.prepare("SELECT signalled_by AS v FROM checkpoints WHERE id = ?").get(
      "cp-latch",
    ) as { v: string | null };
    expect(row.v).toBe("discarded");
  });

  it("keeps a still-pending checkpoint out of the reconciliation backlog", async () => {
    // Nobody has answered `cp-latch`; it is simply waiting for a human.
    expect(repo.listUndeliveredCheckpoints()).toEqual([]);
    expect(signalledAt("cp-latch")).toBeNull();
  });

  it("puts a resolved-but-unsignalled checkpoint in the backlog", async () => {
    const resolved = repo.loadCheckpointSync("cp-latch");
    await repo.resolveCheckpoint({ ...resolved!, status: "approved", version: 2 }, {
      decision: "approved",
    });
    expect(repo.listUndeliveredCheckpoints().map((d) => d.checkpointId)).toEqual(["cp-latch"]);
    await repo.markCheckpointSignalled("cp-latch");
    expect(repo.listUndeliveredCheckpoints()).toEqual([]);
  });
});

/** Every migration up to and including `version`. */
function upTo(version: number) {
  return migrations.filter((m) => m.version <= version);
}

/** A database at schema version 4 (pre-`signalled_at`) with one task. */
function legacyDb(taskStatus: string, taskId = "task-old"): MeidoyaDatabase {
  const db: MeidoyaDatabase = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, upTo(4));
  seedFromConfig(db, config(), 1_700_000_000);
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, origin, pipeline, title, intent_json, status,
        temporal_workflow_id, version, created_at, updated_at)
     VALUES (?, ?, 'cli', 'coding', 't', '{}', ?, 'task/old', 1, 1, 1)`,
  ).run(taskId, WORKSPACE, taskStatus);
  return db;
}

function insertResolvedCheckpoint(
  db: MeidoyaDatabase,
  args: { id: string; taskId?: string; kind?: string; answeredAt: number },
): void {
  db.prepare(
    `INSERT INTO checkpoints (id, task_id, kind, status, prompt, choices_json, answer_json,
        version, created_at, answered_at)
     VALUES (?, ?, ?, 'approved', 'p', '[]', '{"decision":"approved"}', 2, 1, ?)`,
  ).run(args.id, args.taskId ?? "task-old", args.kind ?? "plan-approval", args.answeredAt);
}

function signalledAtOf(db: MeidoyaDatabase, id: string): number | null {
  const row = db.prepare("SELECT signalled_at FROM checkpoints WHERE id = ?").get(id) as
    | { signalled_at: number | null }
    | undefined;
  return row?.signalled_at ?? null;
}

function undeliveredIds(db: MeidoyaDatabase): string[] {
  const repo = new SqliteTaskRepository(db, new SerialWriteQueue(), () => 1_700_000_000);
  return repo.listUndeliveredCheckpoints().map((d) => d.checkpointId);
}

/**
 * Scoped to migration 0005 itself (schema version 5, no repair migration), so
 * the assertions below are about 0005's own predicate and cannot be satisfied
 * by the corrective 0006 running afterwards.
 */
describe("migration 0005 backfill", () => {
  it("leaves a wedged row (task still parked) undelivered so the sweep repairs it", () => {
    const db = legacyDb("waiting_plan_approval");
    insertResolvedCheckpoint(db, { id: "cp-old", answeredAt: 7 });
    migrate(db, upTo(5));
    expect(signalledAtOf(db, "cp-old")).toBeNull();
    expect(undeliveredIds(db)).toEqual(["cp-old"]);
    db.close();
  });

  it("treats an already-progressed task's resolved checkpoint as delivered", () => {
    const db = legacyDb("running");
    insertResolvedCheckpoint(db, { id: "cp-old", answeredAt: 7 });
    migrate(db, upTo(5));
    expect(signalledAtOf(db, "cp-old")).toBe(7);
    expect(undeliveredIds(db)).toEqual([]);
    db.close();
  });

  /**
   * `waiting%` is not the whole set of parked statuses. A `limit-exceeded`
   * checkpoint parks its task in `needs_attention` (task-engine `gates.ts`),
   * so latching it here dropped the one answer that carries a granted budget
   * extension — and every retry 409s forever afterwards.
   */
  it("leaves a limit-exceeded answer (task in needs_attention) undelivered", () => {
    const db = legacyDb("needs_attention");
    insertResolvedCheckpoint(db, { id: "cp-limit", kind: "limit-exceeded", answeredAt: 7 });
    migrate(db, upTo(5));
    expect(signalledAtOf(db, "cp-limit")).toBeNull();
    expect(undeliveredIds(db)).toEqual(["cp-limit"]);
    db.close();
  });

  it.each([
    "waiting_clarification",
    "waiting_plan_approval",
    "waiting_review_approval",
    "waiting_user_input",
    "waiting_side_effect_approval",
    "needs_attention",
  ])("leaves the wedged row undelivered for a task parked in %s", (status) => {
    const db = legacyDb(status);
    insertResolvedCheckpoint(db, { id: "cp-old", answeredAt: 7 });
    migrate(db, upTo(5));
    expect(undeliveredIds(db)).toEqual(["cp-old"]);
    db.close();
  });

  /**
   * The inference is per-CHECKPOINT, not per-TASK: only the newest resolved
   * checkpoint can be the one the task is currently parked on. Scoping the
   * exclusion to the task re-opened every checkpoint it had ever answered, so
   * the first boot after this migration re-signalled answers the workflow
   * consumed rounds ago.
   */
  it("re-opens only the parked task's LATEST resolved checkpoint", () => {
    const db = legacyDb("waiting_review_approval");
    insertResolvedCheckpoint(db, { id: "cp-plan", answeredAt: 3 });
    insertResolvedCheckpoint(db, { id: "cp-review", kind: "review-approval", answeredAt: 9 });
    migrate(db, upTo(5));
    expect(signalledAtOf(db, "cp-plan")).toBe(3);
    expect(undeliveredIds(db)).toEqual(["cp-review"]);
    db.close();
  });

  it("never re-opens a still-pending checkpoint", () => {
    const db = legacyDb("waiting_plan_approval");
    db.prepare(
      `INSERT INTO checkpoints (id, task_id, kind, status, prompt, choices_json,
          version, created_at)
       VALUES ('cp-open', 'task-old', 'plan-approval', 'pending', 'p', '[]', 1, 1)`,
    ).run();
    migrate(db, upTo(5));
    expect(undeliveredIds(db)).toEqual([]);
    db.close();
  });
});

/**
 * Migration 0008 is FROZEN. Four migrations in a row (0005, 0006, 0007, 0008)
 * tried to decide, in SQL and on every boot, which of two historical code
 * versions wrote a row, and the question is not answerable from the database:
 * 0008's era fence was a wall clock, its "positive marker" rested on columns
 * that have existed since 0001 rather than the new one its proof claimed, and
 * it was a database-global `EXISTS`, so one anomalous row decided every task.
 *
 * So it does nothing now, and this suite says what that costs and what covers
 * it. The ORIGINAL 0005 is replayed verbatim — that is the only honest way to
 * reproduce such a database.
 */
describe("migration 0008 is frozen, and the operator command repairs instead", () => {
  /** Applies the ORIGINAL 0005 (column + its buggy backfill + index). */
  function applyOriginal0005(db: MeidoyaDatabase): void {
    db.exec(`
      ALTER TABLE checkpoints ADD COLUMN signalled_at INTEGER;
      UPDATE checkpoints
         SET signalled_at = COALESCE(answered_at, created_at)
       WHERE status != 'pending'
         AND signalled_at IS NULL
         AND task_id NOT IN (SELECT id FROM tasks WHERE status LIKE 'waiting%');
      CREATE INDEX IF NOT EXISTS checkpoints_undelivered_idx
        ON checkpoints(answered_at)
        WHERE signalled_at IS NULL AND status != 'pending';
    `);
    // This reconstruction IS a database from before checksums existed — the
    // 0005 run being replayed predates the column — so the ledger has to look
    // like one. Leaving checksummed rows next to a hand-inserted checksum-less
    // version 5 is the shape that means "the checksum column was erased", and
    // the runner is right to refuse it.
    db.exec("UPDATE schema_migrations SET checksum = NULL");
    db.exec("DROP TABLE IF EXISTS schema_migrations_meta");
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, 'checkpoint_delivery', 1000)",
    ).run();
  }

  /**
   * THE COST OF THE FREEZE, stated as an assertion. The wedged `limit-exceeded`
   * answer — a budget extension a human granted, marked delivered although it
   * never was — stays latched. The previous 0008 re-opened it, but only when
   * some OTHER task in the same database happened to hold two unlatched
   * pre-0005 checkpoints, and re-opened a genuinely DELIVERED answer whenever
   * the wall clock had stepped backwards. A repair whose verdict comes from an
   * unrelated row is not a repair.
   */
  it("leaves the wedged limit-exceeded answer latched", () => {
    const db = legacyDb("needs_attention");
    insertResolvedCheckpoint(db, { id: "cp-limit", kind: "limit-exceeded", answeredAt: 7 });
    applyOriginal0005(db);
    expect(signalledAtOf(db, "cp-limit")).toBe(7);

    migrate(db, migrations);

    expect(signalledAtOf(db, "cp-limit")).toBe(7);
    expect(undeliveredIds(db)).toEqual([]);
    db.close();
  });

  /**
   * ...and this is what covers it. `meidoya admin latch list` reports the row
   * with the provenance 0007 stored, a human who can look at the workflow
   * decides, and `release` clears exactly that latch. The row then lands in
   * `listUndeliveredCheckpoints` — the sweep's own query, asserted here through
   * the real repository — and the daemon finishes the job with no change on its
   * side at all.
   */
  it("hands the wedged answer to the operator command, which puts it back in the sweep", () => {
    const db = legacyDb("needs_attention");
    insertResolvedCheckpoint(db, { id: "cp-limit", kind: "limit-exceeded", answeredAt: 7 });
    applyOriginal0005(db);
    migrate(db, migrations);

    expect(listCandidates(db)).toMatchObject([
      {
        checkpointId: "cp-limit",
        taskStatus: "needs_attention",
        checkpointKind: "limit-exceeded",
        signalledBy: "backfill",
        latch: "backfill",
      },
    ]);

    expect(releaseLatch(db, "cp-limit", { apply: false }).outcome).toBe("would-release");
    expect(undeliveredIds(db)).toEqual([]);

    expect(releaseLatch(db, "cp-limit", { apply: true }).outcome).toBe("released");
    expect(undeliveredIds(db)).toEqual(["cp-limit"]);
    db.close();
  });

  /**
   * The other direction the old 0008 acted in: latching rows the original 0005
   * wrongly left OPEN. It called that half "non-destructive", and it is the half
   * that silently loses a committed human answer when the clock has moved —
   * a latched row never appears in the sweep again. Frozen, both rows stay in
   * the queue; a duplicate signal is inert, because TaskWorkflow consumes at
   * most one answer per checkpoint id.
   */
  it("latches nothing, so no answer can be dropped out of the sweep", () => {
    const db = legacyDb("waiting_review_approval");
    insertResolvedCheckpoint(db, { id: "cp-plan", answeredAt: 3 });
    insertResolvedCheckpoint(db, { id: "cp-review", kind: "review-approval", answeredAt: 9 });
    applyOriginal0005(db);
    expect(undeliveredIds(db).sort()).toEqual(["cp-plan", "cp-review"]);

    migrate(db, migrations);

    expect(undeliveredIds(db).sort()).toEqual(["cp-plan", "cp-review"]);
    db.close();
  });

  it("leaves a database that only ever saw the corrected 0005 untouched", () => {
    const db = legacyDb("needs_attention");
    insertResolvedCheckpoint(db, { id: "cp-plan", answeredAt: 3 });
    insertResolvedCheckpoint(db, { id: "cp-limit", kind: "limit-exceeded", answeredAt: 9 });
    migrate(db, migrations);
    expect(signalledAtOf(db, "cp-plan")).toBe(3);
    expect(undeliveredIds(db)).toEqual(["cp-limit"]);
    // Idempotent: re-running the whole chain changes nothing.
    migrate(db, migrations);
    expect(undeliveredIds(db)).toEqual(["cp-limit"]);
    db.close();
  });

  it("does not touch fresh backlog written by the current code", () => {
    // A task that has moved on but whose answer the sweep still owes a signal.
    // (0005 is recorded here as applied at t = 1000s, i.e. 1_000_000ms.)
    const db = legacyDb("running");
    insertResolvedCheckpoint(db, { id: "cp-plan", answeredAt: 3 });
    insertResolvedCheckpoint(db, { id: "cp-review", kind: "review-approval", answeredAt: 9 });
    applyOriginal0005(db);
    insertResolvedCheckpoint(db, { id: "cp-fresh", answeredAt: 2_000_000 });
    insertResolvedCheckpoint(db, { id: "cp-fresher", answeredAt: 3_000_000 });
    db.prepare("UPDATE checkpoints SET signalled_at = 3000001 WHERE id = 'cp-fresher'").run();

    migrate(db, migrations);

    expect(undeliveredIds(db)).toEqual(["cp-fresh"]);
    db.close();
  });
});

/* --------------------------------------------------- delivery recovery */

/**
 * #4: the compare-and-swap that commits an answer and the signal that tells the
 * workflow about it are two separate operations. One transport error between
 * them used to park the task forever: the row was resolved, so every retry got
 * a 409, and the workflow waits in `condition()` with no timeout.
 *
 * The guarantee these tests hold up is: an answer that has been COMMITTED is
 * eventually DELIVERED, and delivering it twice is harmless.
 */
describe("checkpoint answer delivery is recoverable", () => {
  let f: Fixture;
  let gateway: RecordingGateway;
  let service: ControlPlaneService;
  let scope: ResolvedScope;
  let logged: string[];
  let published: { type: string; taskId: string; payload?: Record<string, unknown> }[];

  beforeEach(async () => {
    f = fixture();
    const resolvedConfig = config();
    const scopes = {
      projectsOf: (workspaceId: string) =>
        resolvedConfig.workspaces.find((w) => w.workspaceId === workspaceId)?.projects ?? [],
    } as unknown as ScopeRegistry;
    scope = { workspaceId: WORKSPACE, role: "maid", capabilities: [] };
    gateway = new RecordingGateway();
    logged = [];
    published = [];
    const events = new ControlEventBus();
    events.subscribe((event) =>
      published.push({
        type: event.type,
        taskId: event.taskId,
        ...(event.payload === undefined ? {} : { payload: event.payload }),
      }),
    );
    service = new ControlPlaneService({
      config: resolvedConfig,
      repository: f.repo,
      scopes,
      gateway,
      events,
      now: () => 1_700_000_000,
      log: (message) => logged.push(message),
    });

    await f.repo.createTask(taskInput("task-cp"));
    await f.repo.recordCheckpoint(
      openCheckpoint({
        id: "cp-1",
        taskId: "task-cp",
        kind: "plan-approval",
        prompt: "Approve?",
      }),
    );
  });

  afterEach(() => {
    f.db.close();
  });

  function signalledAt(id: string): number | null {
    const row = f.db.prepare("SELECT signalled_at FROM checkpoints WHERE id = ?").get(id) as
      | { signalled_at: number | null }
      | undefined;
    return row?.signalled_at ?? null;
  }

  function signalledBy(id: string): string | null {
    const row = f.db.prepare("SELECT signalled_by FROM checkpoints WHERE id = ?").get(id) as
      | { signalled_by: string | null }
      | undefined;
    return row?.signalled_by ?? null;
  }

  it("delivers the committed answer on retry after the signal throws once", async () => {
    gateway.failNextAnswers = 1;

    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);

    // The compare-and-swap committed; only the signal was lost.
    expect(f.repo.loadCheckpointSync("cp-1")).toMatchObject({ status: "approved", version: 2 });
    expect(gateway.answers).toHaveLength(0);
    expect(signalledAt("cp-1")).toBeNull();

    // The retry is the same call the client already made: it still holds the
    // version it read before the answer landed.
    const retry = await service.answerCheckpoint(scope, {
      checkpointId: "cp-1",
      decision: "approve",
      expectedVersion: 1,
    });

    expect(retry).toEqual({ checkpointId: "cp-1", status: "approved", version: 2 });
    expect(gateway.answers).toEqual([{ checkpointId: "cp-1", answer: "approved" }]);
    expect(signalledAt("cp-1")).not.toBeNull();
  });

  it("delivers the committed answer, not the one a later caller asks for", async () => {
    gateway.failNextAnswers = 1;
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);

    // A different operator now says "reject". The CAS already picked a winner,
    // and that decision is final: recovery re-sends the committed answer.
    const recovered = await service.answerCheckpoint(scope, {
      checkpointId: "cp-1",
      decision: "reject",
      expectedVersion: 2,
    });

    expect(recovered.status).toBe("approved");
    expect(gateway.answers).toEqual([{ checkpointId: "cp-1", answer: "approved" }]);
    expect(f.repo.loadCheckpointSync("cp-1")).toMatchObject({ status: "approved", version: 2 });
  });

  it("keeps refusing once the committed answer HAS been delivered", async () => {
    await service.answerCheckpoint(scope, {
      checkpointId: "cp-1",
      decision: "approve",
      expectedVersion: 1,
    });
    expect(gateway.answers).toHaveLength(1);

    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "reject",
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(gateway.answers).toHaveLength(1);
  });

  it("delivers the same logical answer no matter how many times recovery runs", async () => {
    gateway.failNextAnswers = 1;
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);

    // Three impatient retries plus a sweep. Whatever the workflow receives, it
    // is one checkpoint id carrying one verdict — which is what makes duplicate
    // delivery inert: TaskWorkflow consumes at most one answer per checkpoint
    // id and discards the rest.
    await service.answerCheckpoint(scope, {
      checkpointId: "cp-1",
      decision: "approve",
      expectedVersion: 1,
    });
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await service.reconcileCheckpointDeliveries();

    expect(new Set(gateway.answers.map((a) => `${a.checkpointId}:${a.answer}`))).toEqual(
      new Set(["cp-1:approved"]),
    );
    expect(gateway.answers).toHaveLength(1);
  });

  it("re-signals a resolved-but-unsignalled row from the sweep, and is idempotent", async () => {
    gateway.failNextAnswers = 1;
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(signalledAt("cp-1")).toBeNull();

    // No client ever retries — the CLI process died with the error.
    const first = await service.reconcileCheckpointDeliveries();
    expect(first).toEqual({ scanned: 1, delivered: 1, failed: 0, backlog: 0, awaitingCorroboration: 0 });
    expect(gateway.answers).toEqual([{ checkpointId: "cp-1", answer: "approved" }]);

    const second = await service.reconcileCheckpointDeliveries();
    const third = await service.reconcileCheckpointDeliveries();
    expect(second).toEqual({ scanned: 0, delivered: 0, failed: 0, backlog: 0, awaitingCorroboration: 0 });
    expect(third).toEqual({ scanned: 0, delivered: 0, failed: 0, backlog: 0, awaitingCorroboration: 0 });
    expect(gateway.answers).toHaveLength(1);
  });

  it("leaves a row in the backlog while delivery keeps failing", async () => {
    gateway.failNextAnswers = 3;
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);

    expect(await service.reconcileCheckpointDeliveries()).toEqual({
      scanned: 1,
      delivered: 0,
      failed: 1,
      backlog: 1,
      awaitingCorroboration: 0,
    });
    expect(signalledAt("cp-1")).toBeNull();
    expect(await service.reconcileCheckpointDeliveries()).toEqual({
      scanned: 1,
      delivered: 0,
      failed: 1,
      backlog: 1,
      awaitingCorroboration: 0,
    });
    expect(await service.reconcileCheckpointDeliveries()).toEqual({
      scanned: 1,
      delivered: 1,
      failed: 0,
      backlog: 0,
      awaitingCorroboration: 0,
    });
    expect(gateway.answers).toHaveLength(1);
  });

  /** Makes every gateway attempt fail with a typed "the workflow is gone". */
  function workflowIsGone(times: number): void {
    gateway.failNextAnswers = times;
    gateway.answerError = () => {
      const error = new Error("workflow execution already completed");
      error.name = "WorkflowNotFoundError";
      return error;
    };
  }

  /**
   * Retirement discards a human answer that was already committed, so it takes
   * TWO sweeps that agree. (This test previously asserted retirement on the
   * first sweep; that encoded the defect — a single transient NOT_FOUND, which
   * a namespace failover or a signal racing workflow visibility produces, threw
   * the answer away.)
   */
  it("retires a row whose workflow no longer exists, but only on a corroborated verdict", async () => {
    workflowIsGone(99);
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/already completed/);

    // First verdict: not acted on. The answer stays recoverable — and the row
    // is REPORTED as awaiting a second verdict rather than silently held.
    expect(await service.reconcileCheckpointDeliveries()).toEqual({
      scanned: 1,
      delivered: 0,
      failed: 1,
      backlog: 1,
      awaitingCorroboration: 1,
    });
    expect(signalledAt("cp-1")).toBeNull();

    // Second, corroborating verdict: now it is retired — and the backlog it was
    // holding open is empty again, which is what makes it BOUNDED and not just
    // quiet.
    expect(await service.reconcileCheckpointDeliveries()).toEqual({
      scanned: 1,
      delivered: 0,
      failed: 1,
      backlog: 0,
      awaitingCorroboration: 0,
    });
    expect(signalledAt("cp-1")).not.toBeNull();
    expect(await service.reconcileCheckpointDeliveries()).toEqual({
      scanned: 0,
      delivered: 0,
      failed: 0,
      backlog: 0,
      awaitingCorroboration: 0,
    });
  });

  it("recovers when the workflow becomes reachable again after one NOT_FOUND", async () => {
    // Exactly the transient shape: the signal raced the workflow's visibility.
    workflowIsGone(2);
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/already completed/);

    expect(await service.reconcileCheckpointDeliveries()).toMatchObject({ delivered: 0 });
    expect(signalledAt("cp-1")).toBeNull();
    expect(await service.reconcileCheckpointDeliveries()).toMatchObject({ delivered: 1 });
    expect(gateway.answers).toEqual([{ checkpointId: "cp-1", answer: "approved" }]);
  });

  /**
   * The retirement branch used to fire on any error whose MESSAGE happened to
   * say "not found". A transport that phrases a transient failure that way must
   * not cost a committed human answer.
   */
  it("never retires on an untyped error that merely says 'not found'", async () => {
    gateway.failNextAnswers = 99;
    gateway.answerError = () => new Error("workflow execution not found (namespace failover)");
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/not found/);

    for (let i = 0; i < 4; i += 1) {
      expect(await service.reconcileCheckpointDeliveries()).toEqual({
        scanned: 1,
        delivered: 0,
        failed: 1,
        backlog: 1,
        awaitingCorroboration: 0,
      });
      expect(signalledAt("cp-1")).toBeNull();
    }

    gateway.failNextAnswers = 0;
    expect(await service.reconcileCheckpointDeliveries()).toMatchObject({ delivered: 1 });
    expect(gateway.answers).toEqual([{ checkpointId: "cp-1", answer: "approved" }]);
  });

  it("makes a discarded answer loud: a log line and an event", async () => {
    workflowIsGone(99);
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow();

    await service.reconcileCheckpointDeliveries();
    expect(published.filter((e) => e.type === "CheckpointAnswerDiscarded")).toHaveLength(0);
    await service.reconcileCheckpointDeliveries();

    expect(logged.join("")).toMatch(/DISCARDED a committed checkpoint answer: cp-1/);
    expect(published.filter((e) => e.type === "CheckpointAnswerDiscarded")).toEqual([
      {
        type: "CheckpointAnswerDiscarded",
        taskId: "task-cp",
        payload: {
          checkpointId: "cp-1",
          status: "approved",
          reason: "workflow-unreachable",
        },
      },
    ]);
  });

  /**
   * A discarded row and a delivered row both end up with a `signalled_at`, and
   * from the outside they are indistinguishable — which makes the loss visible
   * only in a log line somebody has to still have. Migration 0007's
   * `signalled_by` keeps the two apart in the database itself.
   */
  it("records WHY a row is latched: 'signal' when delivered, 'discarded' when given up on", async () => {
    gateway.failNextAnswers = 1;
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);
    await service.reconcileCheckpointDeliveries();
    expect(signalledBy("cp-1")).toBe("signal");

    // A second checkpoint, on a workflow that is gone.
    await f.repo.recordCheckpoint(
      openCheckpoint({ id: "cp-2", taskId: "task-cp", kind: "plan-approval", prompt: "Approve?" }),
    );
    workflowIsGone(99);
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-2",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow();
    await service.reconcileCheckpointDeliveries();
    await service.reconcileCheckpointDeliveries();

    expect(signalledAt("cp-2")).not.toBeNull();
    expect(signalledBy("cp-2")).toBe("discarded");
  });

  /**
   * The sweep scans a capped window, so its own `scanned` count says nothing
   * about a queue larger than the cap: that is exactly the backlog nobody would
   * ever see growing. `backlog` counts the whole queue.
   */
  it("reports the whole backlog, not just the window it scanned", async () => {
    gateway.failNextAnswers = 99;
    await f.repo.recordCheckpoint(
      openCheckpoint({ id: "cp-2", taskId: "task-cp", kind: "plan-approval", prompt: "Approve?" }),
    );
    for (const id of ["cp-1", "cp-2"]) {
      await expect(
        service.answerCheckpoint(scope, { checkpointId: id, decision: "approve", expectedVersion: 1 }),
      ).rejects.toThrow();
    }

    expect(await service.reconcileCheckpointDeliveries({ limit: 1 })).toEqual({
      scanned: 1,
      delivered: 0,
      failed: 1,
      backlog: 2,
      awaitingCorroboration: 0,
    });
  });

  /**
   * The corroboration set is keyed by checkpoint id and is only cleared on the
   * two paths that end a row's life in the sweep. A row that leaves the backlog
   * by any OTHER route — a repair latches it, its task is deleted — used to
   * leave an id behind for the life of the process.
   */
  it("does not keep a corroboration flag for a row that has left the backlog", async () => {
    workflowIsGone(99);
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow();
    expect(await service.reconcileCheckpointDeliveries()).toMatchObject({
      awaitingCorroboration: 1,
    });

    // Something outside the sweep retires the row.
    f.db.prepare("UPDATE checkpoints SET signalled_at = 1, signalled_by = 'signal' WHERE id = 'cp-1'").run();

    expect(await service.reconcileCheckpointDeliveries()).toEqual({
      scanned: 0,
      delivered: 0,
      failed: 0,
      backlog: 0,
      awaitingCorroboration: 0,
    });
  });

  /**
   * ...and the prune that does that is skipped whenever the sweep's window was
   * FULL, because a truncated scan says nothing about the rows beyond it. So
   * the set was bounded in every case except the one where it grows: a backlog
   * that stays at or above `limit` never prunes at all, and every id that
   * leaves the backlog by some other route stays in memory for the life of the
   * process. The hard cap covers exactly that case.
   */
  it("bounds the corroboration memo when the backlog never drops below the window", async () => {
    workflowIsGone(999);
    for (let i = 0; i < 8; i += 1) {
      const id = `cp-sat-${i}`;
      await f.repo.recordCheckpoint(
        openCheckpoint({ id, taskId: "task-cp", kind: "plan-approval", prompt: "Approve?" }),
      );
      await expect(
        service.answerCheckpoint(scope, { checkpointId: id, decision: "approve", expectedVersion: 1 }),
      ).rejects.toThrow();
    }

    // `limit: 1` with a backlog of eight: the window is always full, so the
    // prune never runs. Each sweep memoises one id, and a repair then retires
    // that row — the route the sweep's own `delete`s do not cover.
    for (let i = 0; i < 8; i += 1) {
      const scanned = f.repo.listUndeliveredCheckpoints(1)[0];
      expect(scanned).toBeDefined();
      const result = await service.reconcileCheckpointDeliveries({ limit: 1 });
      // Four windows' worth is the cap; without it this climbs to eight.
      expect(result.awaitingCorroboration).toBeLessThanOrEqual(4);
      await f.repo.markCheckpointSignalled(scanned!.checkpointId, "backfill");
    }
  });

  it("reports a delivery failure that keeps the row in the backlog", async () => {
    gateway.failNextAnswers = 2;
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);

    await service.reconcileCheckpointDeliveries();
    expect(logged.join("")).toMatch(/checkpoint delivery failed, will retry: cp-1/);
  });

  /**
   * `task.answer` is the call a stuck operator reaches for. It used to answer
   * `{accepted:true}` and do nothing whenever the task had no OPEN checkpoint
   * left — which is exactly the state a wedged task is in.
   */
  it("finishes an interrupted delivery from task.answer", async () => {
    gateway.failNextAnswers = 1;
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(gateway.answers).toHaveLength(0);

    const result = await service.answerTask(scope, {
      taskId: "task-cp",
      questionId: "q-1",
      answer: "yes, go ahead",
    });

    expect(result).toEqual({ taskId: "task-cp", accepted: true });
    // The COMMITTED answer is what gets delivered, not the text just supplied.
    expect(gateway.answers).toEqual([{ checkpointId: "cp-1", answer: "approved" }]);
    expect(signalledAt("cp-1")).not.toBeNull();
  });

  /**
   * At-least-once delivery, exactly-once event. A re-delivery after a crash
   * must not tell every `task watch` client that the checkpoint resolved twice.
   */
  it("publishes CheckpointResolved exactly once across a re-delivery", async () => {
    gateway.failNextAnswers = 1;
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);

    // A client retry racing the sweep: both read the row while it is still
    // unsignalled, so the committed answer really is delivered twice.
    await Promise.all([
      service.reconcileCheckpointDeliveries(),
      service.reconcileCheckpointDeliveries(),
    ]);

    expect(gateway.answers.length).toBeGreaterThan(1);
    expect(published.filter((e) => e.type === "CheckpointResolved")).toHaveLength(1);
  });

  /**
   * An expired checkpoint is resolved by its own timer, never by an answer.
   * Reporting `{accepted, status:"expired"}` made lateness look like acceptance.
   */
  it("tells a late answerer that the checkpoint expired, rather than accepting it", async () => {
    const pending = f.repo.loadCheckpointSync("cp-1");
    await f.repo.resolveCheckpoint({ ...pending!, status: "expired", version: 2 }, {
      decision: "expired",
    });
    expect(signalledAt("cp-1")).toBeNull();

    const late = service.answerCheckpoint(scope, {
      checkpointId: "cp-1",
      decision: "approve",
      expectedVersion: 1,
    });
    await expect(late).rejects.toMatchObject({ kind: "conflict" });
    await expect(late).rejects.toThrow(/expired before it was answered/);

    // Nothing was signalled, and the row is latched so the sweep drops it.
    expect(gateway.answers).toHaveLength(0);
    expect(signalledAt("cp-1")).not.toBeNull();
  });

  it("still lets exactly one of two concurrent answers win and signal", async () => {
    // Both calls run their synchronous pre-read while the row is still pending,
    // so neither can take the recovery path: the interleaving is forced.
    const approve = service.answerCheckpoint(scope, {
      checkpointId: "cp-1",
      decision: "approve",
      expectedVersion: 1,
    });
    const reject = service.answerCheckpoint(scope, {
      checkpointId: "cp-1",
      decision: "reject",
      expectedVersion: 1,
    });
    const results = await Promise.allSettled([approve, reject]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(gateway.answers).toHaveLength(1);
    const winner = f.repo.loadCheckpointSync("cp-1");
    expect(winner?.version).toBe(2);
    expect(gateway.answers[0]?.answer).toBe(winner?.status);
    expect(signalledAt("cp-1")).not.toBeNull();
  });

  /**
   * The sweep must never touch a checkpoint nobody has answered. Latching a
   * pending row would consume its one chance at recovery in advance: the human
   * answer that arrives later would then have no backlog entry to fall back on
   * if its signal is lost, and the task would be wedged for good.
   */
  it("never sweeps, or latches, a checkpoint that is still pending", async () => {
    expect(await service.reconcileCheckpointDeliveries()).toEqual({
      scanned: 0,
      delivered: 0,
      failed: 0,
      backlog: 0,
      awaitingCorroboration: 0,
    });
    expect(gateway.answers).toHaveLength(0);
    expect(signalledAt("cp-1")).toBeNull();
    expect(f.repo.loadCheckpointSync("cp-1")).toMatchObject({ status: "pending" });

    // The human answers now, and that signal is the one that gets lost.
    gateway.failNextAnswers = 1;
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-1",
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);

    // Recovery is still available, because the sweep never spent it.
    expect(await service.reconcileCheckpointDeliveries()).toEqual({
      scanned: 1,
      delivered: 1,
      failed: 0,
      backlog: 0,
      awaitingCorroboration: 0,
    });
    expect(gateway.answers).toEqual([{ checkpointId: "cp-1", answer: "approved" }]);
  });

  it("carries the answer text through a recovered delivery", async () => {
    await f.repo.createTask(taskInput("task-q"));
    await f.repo.recordCheckpoint(
      openCheckpoint({
        id: "cp-q",
        taskId: "task-q",
        kind: "clarification",
        prompt: "Which repo?",
      }),
    );
    gateway.failNextAnswers = 1;
    await expect(
      service.answerCheckpoint(scope, {
        checkpointId: "cp-q",
        decision: "answer",
        answer: "the second one",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/ECONNRESET/);

    await service.reconcileCheckpointDeliveries();
    expect(gateway.answers).toEqual([
      { checkpointId: "cp-q", answer: "answered", text: "the second one" },
    ]);
  });
});
