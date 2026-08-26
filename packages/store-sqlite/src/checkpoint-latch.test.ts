import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { migrate } from "./migrate.js";
import { migrations } from "./migrations/index.js";
import { findCandidate, listCandidates, releaseLatch } from "./checkpoint-latch.js";

/**
 * The operator-run repair that replaced migration 0008.
 *
 * 0008 tried to decide, in SQL and on every boot, which of two historical code
 * versions wrote a row. That is not answerable from the database, and each of
 * the four migrations that tried it either destroyed a delivered answer or did
 * nothing on the database that actually needed help. This module does the only
 * two things SQL honestly can: show a human every stored fact, and change one
 * row that a human named.
 */

const NOW = 1_700_000_000_000;

function seed(db: Db): void {
  db.prepare(
    "INSERT INTO environments (id, timezone, created_at, updated_at) VALUES ('env', 'UTC', 0, 0)",
  ).run();
  db.prepare(
    `INSERT INTO workspaces (id, environment_id, kind, display_name, status, policy_json,
                             version, created_at, updated_at)
     VALUES ('ws', 'env', 'execution', 'ws', 'active', '{}', 0, 0, 0)`,
  ).run();
}

function addTask(db: Db, id: string, status: string, title = id): void {
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, origin, pipeline, title, intent_json, status,
                        temporal_workflow_id, version, created_at, updated_at)
     VALUES (?, 'ws', 'cli', 'coding', ?, '{}', ?, ?, 0, 0, 0)`,
  ).run(id, title, status, `task/${id}`);
}

function addCheckpoint(
  db: Db,
  args: {
    id: string;
    taskId: string;
    kind?: string;
    status?: string;
    answeredAt: number | null;
    signalledAt?: number | null;
    signalledBy?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO checkpoints (id, task_id, kind, status, prompt, choices_json, answer_json,
                              version, created_at, answered_at, signalled_at, signalled_by)
     VALUES (?, ?, ?, ?, 'p', '[]', '{}', 2, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.taskId,
    args.kind ?? "limit-exceeded",
    args.status ?? "answered",
    NOW - 10_000,
    args.answeredAt,
    args.signalledAt ?? null,
    args.signalledBy ?? null,
  );
}

describe("listCandidates", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, migrations);
    seed(db);
  });

  it("reports every stored fact a human needs, and no verdict", () => {
    addTask(db, "t1", "needs_attention", "extend the budget");
    addCheckpoint(db, {
      id: "cp-1",
      taskId: "t1",
      kind: "limit-exceeded",
      answeredAt: NOW,
      signalledAt: NOW,
      signalledBy: "backfill",
    });

    expect(listCandidates(db)).toEqual([
      {
        checkpointId: "cp-1",
        taskId: "t1",
        taskTitle: "extend the budget",
        taskStatus: "needs_attention",
        checkpointKind: "limit-exceeded",
        checkpointStatus: "answered",
        createdAt: NOW - 10_000,
        answeredAt: NOW,
        signalledAt: NOW,
        signalledBy: "backfill",
        latch: "backfill",
      },
    ]);
    db.close();
  });

  /**
   * Deliberately not narrowed to `signalled_by = 'backfill'`. Narrowing it
   * would be the migrations' mistake in a new place: it would decide, silently,
   * that a row with no provenance cannot be the wedge — and rows written before
   * 0007 have no provenance precisely because the sweep's give-up path and a
   * successful delivery were indistinguishable then.
   */
  it("classifies every latch state rather than pre-filtering to the convenient one", () => {
    addTask(db, "t1", "waiting_review");
    addCheckpoint(db, { id: "a-backfill", taskId: "t1", answeredAt: NOW + 1, signalledAt: NOW, signalledBy: "backfill" });
    addCheckpoint(db, { id: "b-signal", taskId: "t1", answeredAt: NOW + 2, signalledAt: NOW, signalledBy: "signal" });
    addCheckpoint(db, { id: "c-discarded", taskId: "t1", answeredAt: NOW + 3, signalledAt: NOW, signalledBy: "discarded" });
    addCheckpoint(db, { id: "d-unknown", taskId: "t1", answeredAt: NOW + 4, signalledAt: NOW, signalledBy: null });
    addCheckpoint(db, { id: "e-open", taskId: "t1", answeredAt: NOW + 5 });

    expect(listCandidates(db).map((c) => [c.checkpointId, c.latch])).toEqual([
      ["a-backfill", "backfill"],
      ["b-signal", "signal"],
      ["c-discarded", "discarded"],
      ["d-unknown", "unknown"],
      ["e-open", "undelivered"],
    ]);
    db.close();
  });

  it("excludes tasks that are not parked, and checkpoints that are still pending", () => {
    addTask(db, "running", "executing");
    addCheckpoint(db, { id: "not-parked", taskId: "running", answeredAt: NOW, signalledAt: NOW, signalledBy: "backfill" });
    addTask(db, "parked", "needs_attention");
    addCheckpoint(db, { id: "still-open", taskId: "parked", status: "pending", answeredAt: null });

    expect(listCandidates(db)).toEqual([]);
    db.close();
  });

  it("is ordered deterministically, so two runs print the same thing", () => {
    addTask(db, "t2", "waiting_review");
    addTask(db, "t1", "needs_attention");
    // Same answered_at on purpose: the id breaks the tie.
    addCheckpoint(db, { id: "b", taskId: "t1", answeredAt: NOW });
    addCheckpoint(db, { id: "a", taskId: "t1", answeredAt: NOW });
    addCheckpoint(db, { id: "c", taskId: "t2", answeredAt: NOW - 1 });

    const ids = (): string[] => listCandidates(db).map((c) => c.checkpointId);
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(ids()).toEqual(ids());
    db.close();
  });

  it("falls back to created_at when an answer has no timestamp", () => {
    addTask(db, "t1", "needs_attention");
    addCheckpoint(db, { id: "no-answered-at", taskId: "t1", answeredAt: null, signalledAt: NOW, signalledBy: "backfill" });

    expect(listCandidates(db)[0]).toMatchObject({ answeredAt: null, createdAt: NOW - 10_000 });
    db.close();
  });
});

describe("releaseLatch", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, migrations);
    seed(db);
    addTask(db, "t1", "needs_attention");
  });

  it("writes nothing without apply, and clears exactly one row with it", () => {
    addCheckpoint(db, { id: "cp", taskId: "t1", answeredAt: NOW, signalledAt: NOW, signalledBy: "backfill" });
    addCheckpoint(db, { id: "other", taskId: "t1", answeredAt: NOW, signalledAt: NOW, signalledBy: "backfill" });

    expect(releaseLatch(db, "cp", { apply: false }).outcome).toBe("would-release");
    expect(findCandidate(db, "cp")?.signalledAt).toBe(NOW);

    const applied = releaseLatch(db, "cp", { apply: true });
    expect(applied.outcome).toBe("released");
    expect(findCandidate(db, "cp")).toMatchObject({
      signalledAt: null,
      signalledBy: null,
      latch: "undelivered",
    });
    // Named by id, never by predicate: the neighbour is untouched.
    expect(findCandidate(db, "other")?.signalledAt).toBe(NOW);
    db.close();
  });

  it("reports the released row's NEW state, so the operator sees what happened", () => {
    addCheckpoint(db, { id: "cp", taskId: "t1", answeredAt: NOW, signalledAt: NOW, signalledBy: "backfill" });
    const result = releaseLatch(db, "cp", { apply: true });
    expect(result).toMatchObject({ outcome: "released", candidate: { latch: "undelivered" } });
    db.close();
  });

  /**
   * `signalled_by = 'signal'` is the one value that records an OBSERVED
   * delivery. Clearing it asks the sweep to re-signal an answer the workflow
   * already consumed; if that workflow is gone the sweep reports
   * `CheckpointAnswerDiscarded` for an answer nobody lost — the false alarm the
   * whole chain has been trying not to raise. It takes an explicit --force.
   */
  it("refuses an observed delivery unless forced", () => {
    addCheckpoint(db, { id: "cp", taskId: "t1", answeredAt: NOW, signalledAt: NOW, signalledBy: "signal" });

    expect(releaseLatch(db, "cp", { apply: true }).outcome).toBe("refused-observed");
    expect(findCandidate(db, "cp")?.signalledAt).toBe(NOW);

    expect(releaseLatch(db, "cp", { apply: true, force: true }).outcome).toBe("released");
    expect(findCandidate(db, "cp")?.signalledAt).toBeNull();
    db.close();
  });

  it("releases a 'discarded' latch without force: that answer was never delivered", () => {
    addCheckpoint(db, { id: "cp", taskId: "t1", answeredAt: NOW, signalledAt: NOW, signalledBy: "discarded" });
    expect(releaseLatch(db, "cp", { apply: true }).outcome).toBe("released");
    db.close();
  });

  it("is idempotent: a row already owed to the sweep is left alone", () => {
    addCheckpoint(db, { id: "cp", taskId: "t1", answeredAt: NOW });
    expect(releaseLatch(db, "cp", { apply: true }).outcome).toBe("already-undelivered");
    db.close();
  });

  it("refuses a pending checkpoint: there is no committed answer to re-deliver", () => {
    addCheckpoint(db, { id: "cp", taskId: "t1", status: "pending", answeredAt: null, signalledAt: NOW });
    expect(releaseLatch(db, "cp", { apply: true }).outcome).toBe("not-resolved");
    expect(findCandidate(db, "cp")?.signalledAt).toBe(NOW);
    db.close();
  });

  it("reports an unknown id rather than silently doing nothing", () => {
    expect(releaseLatch(db, "nope", { apply: true })).toEqual({
      outcome: "unknown-checkpoint",
      checkpointId: "nope",
    });
    db.close();
  });

  /**
   * The released row has to land in the sweep's query — that query is the only
   * reason releasing it does anything at all. `listUndeliveredCheckpoints` is
   * `signalled_at IS NULL AND status != 'pending'`; asserting the same shape
   * here keeps this command and the daemon from drifting apart with no test
   * between them.
   */
  it("puts the row back into the reconciliation sweep's query", () => {
    addCheckpoint(db, { id: "cp", taskId: "t1", answeredAt: NOW, signalledAt: NOW, signalledBy: "backfill" });
    const swept = (): string[] =>
      (
        db
          .prepare(
            "SELECT id FROM checkpoints WHERE signalled_at IS NULL AND status != 'pending' ORDER BY id",
          )
          .all() as { id: string }[]
      ).map((r) => r.id);

    expect(swept()).toEqual([]);
    releaseLatch(db, "cp", { apply: true });
    expect(swept()).toEqual(["cp"]);
    db.close();
  });

  /**
   * The LOOKUP is deliberately wide — an id copied out of a log must always
   * resolve, whatever its task is doing — but the WRITE is not.
   *
   * F8: this test used to end `expect(...).toBe("released")`, which is the
   * defect stated as a requirement. `findCandidate` ignores task status, and
   * `releaseLatch` read nothing else, so a checkpoint under a finished task
   * released with NO `--force` — a strictly worse case than the `signal`
   * provenance that did require it, because the workflow is not merely possibly
   * gone, it is over. The sweep then re-signals it and reports
   * `CheckpointAnswerDiscarded` for an answer nobody lost.
   */
  it("finds a checkpoint whose task is not parked, but refuses to release it unforced", () => {
    addTask(db, "closed", "completed");
    addCheckpoint(db, { id: "cp", taskId: "closed", answeredAt: NOW, signalledAt: NOW, signalledBy: "backfill" });
    expect(listCandidates(db)).toEqual([]);
    expect(findCandidate(db, "cp")?.taskStatus).toBe("completed");

    expect(releaseLatch(db, "cp", { apply: true }).outcome).toBe("refused-finished-task");
    expect(findCandidate(db, "cp")?.signalledAt).toBe(NOW);

    expect(releaseLatch(db, "cp", { apply: true, force: true }).outcome).toBe("released");
    expect(findCandidate(db, "cp")?.signalledAt).toBeNull();
    db.close();
  });

  it("refuses a succeeded task the same way, and reports before writing", () => {
    addTask(db, "done", "succeeded");
    addCheckpoint(db, { id: "cp", taskId: "done", answeredAt: NOW, signalledAt: NOW, signalledBy: "backfill" });
    const dry = releaseLatch(db, "cp", { apply: false });
    expect(dry.outcome).toBe("refused-finished-task");
    // The refusal is reported instead of a dry run, so `--apply` cannot come as
    // a surprise after a `would-release`.
    expect(releaseLatch(db, "cp", { apply: true }).outcome).toBe("refused-finished-task");
    db.close();
  });

  it("still releases every parked status without force", () => {
    for (const status of ["needs_attention", "waiting_plan_approval", "waiting_review_approval"]) {
      addTask(db, `t-${status}`, status);
      addCheckpoint(db, {
        id: `cp-${status}`,
        taskId: `t-${status}`,
        answeredAt: NOW,
        signalledAt: NOW,
        signalledBy: "backfill",
      });
      expect(releaseLatch(db, `cp-${status}`, { apply: true }).outcome).toBe("released");
    }
    db.close();
  });
});

/**
 * F8, the rest of the write path. All three of these were invisible to every
 * assertion the suite made, because each one only changes what happens when
 * something else is happening at the same time — or what is CLAIMED when nothing
 * happened at all.
 */
describe("releaseLatch's write is atomic, fenced and honest", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, migrations);
    seed(db);
    addTask(db, "t1", "needs_attention");
    addCheckpoint(db, { id: "cp", taskId: "t1", answeredAt: NOW, signalledAt: NOW, signalledBy: "backfill" });
  });

  /**
   * `db.inTransaction` was `false` at the UPDATE: the evidence was gathered by
   * one autocommit statement and the write made by another, with no transaction
   * around either.
   */
  it("gathers its evidence and writes inside ONE transaction", () => {
    const inTransactionAt: Record<string, boolean> = {};
    const spy = new Proxy(db, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          const kind = sql.trimStart().slice(0, 6).toUpperCase();
          return new Proxy(statement, {
            get(s, p) {
              const value = Reflect.get(s, p) as unknown;
              if (p !== "run" && p !== "get" && p !== "all") {
                return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(s) : value;
              }
              return (...args: unknown[]) => {
                inTransactionAt[kind] = target.inTransaction;
                return (value as (...a: unknown[]) => unknown).apply(s, args);
              };
            },
          });
        };
      },
    });

    expect(releaseLatch(spy, "cp", { apply: true }).outcome).toBe("released");
    expect(inTransactionAt["UPDATE"]).toBe(true);
    expect(inTransactionAt["SELECT"]).toBe(true);
    db.close();
  });

  /**
   * The UPDATE's `WHERE` re-checked only `signalled_at IS NOT NULL`, never the
   * provenance `--force` was decided from. A genuine delivery landing between
   * the evidence and the write was therefore wiped by a release the operator had
   * authorised against a `backfill` row — the exact thing `--force` exists to
   * stop. Injected here at the only moment it can happen: as the write statement
   * is prepared.
   */
  it("refuses to write when the row stopped matching the evidence it was authorised against", () => {
    let injected = false;
    const racing = new Proxy(db, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        }
        return (sql: string) => {
          if (!injected && sql.trimStart().toUpperCase().startsWith("UPDATE")) {
            injected = true;
            // A real delivery lands, and records itself.
            target
              .prepare("UPDATE checkpoints SET signalled_by = 'signal' WHERE id = 'cp'")
              .run();
          }
          return target.prepare(sql);
        };
      },
    });

    const result = releaseLatch(racing, "cp", { apply: true });
    expect(result.outcome).toBe("not-applied");
    // The observed delivery survived, untouched.
    expect(findCandidate(db, "cp")).toMatchObject({ signalledAt: NOW, signalledBy: "signal" });
    db.close();
  });

  /**
   * `.changes` was never read, so a write that touched no row still returned
   * `{outcome: "released"}` — and the CLI printed "latch cleared" and exited 0.
   * The trigger below makes SQLite skip the row without raising, which is the
   * shape of every "the write did not happen" case.
   */
  it("does not report a release it did not achieve", () => {
    db.exec("CREATE TRIGGER veto BEFORE UPDATE ON checkpoints BEGIN SELECT RAISE(IGNORE); END");
    const result = releaseLatch(db, "cp", { apply: true });
    expect(result.outcome).toBe("not-applied");
    expect(findCandidate(db, "cp")?.signalledAt).toBe(NOW);
    db.close();
  });
});
