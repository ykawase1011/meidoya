import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { migrate } from "./migrate.js";
import { migrations } from "./migrations/index.js";
import { listCandidates, releaseLatch } from "./checkpoint-latch.js";

/** 0008's own file, so "no-op" is asserted by RE-EXECUTING it rather than by
 *  relying on the version ledger to skip it. */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

const FROZEN_0008 = readFileSync(
  join(MIGRATIONS_DIR, "0008_checkpoint_backfill_repair.sql"),
  "utf8",
);

/**
 * The CORRECTED 0005, taken from the shipped file itself rather than retyped,
 * so the reconstructions below run the same bytes a real database ran. Its SQL
 * has been byte-identical since the commit that corrected it; only the comments
 * and the ledger NAME changed afterwards, which is the whole defect.
 */
const CORRECTED_0005 = readFileSync(
  join(MIGRATIONS_DIR, "0005_checkpoint_delivery.sql"),
  "utf8",
);

/**
 * The checkpoint-delivery chain (0005 -> 0007 -> 0008) has to behave on SIX
 * different starting points, and the only one anybody ever runs by hand is the
 * fresh one:
 *
 *   (a) a database created BEFORE 0005 existed — it runs the CORRECTED 0005;
 *   (b) a database that recorded the ORIGINAL 0005 — the only database 0008
 *       ever existed for, and the only one where a wrong predicate can destroy
 *       data;
 *   (c) a fresh database — every migration runs in one go over zero rows;
 *   (d) a database that ran the CORRECTED 0005 but recorded it under the OLD
 *       ledger name `checkpoint_delivery`. This one is real: the 0005 SQL was
 *       corrected one commit BEFORE the ledger name was changed, so every
 *       database provisioned in that window looks "original" by name and is
 *       "corrected" in fact;
 *   (e) a database that ran the corrected 0005 under the NEW name;
 *   (f) a database already at version 6 with the WITHDRAWN 0006 applied.
 *
 * 0008 IS NOW FROZEN. Four migrations in a row tried to decide, from SQL alone,
 * which of two historical code versions wrote a row, and the eighth review
 * established that the question is not answerable from the database at all:
 * 0008's era fence was a wall clock (a backwards NTP step or a container with
 * no RTC moves code-written rows across it), its "positive marker" read
 * `COALESCE(answered_at, created_at)` — columns present since 0001, not the new
 * one its safety proof claimed — and it was a global `EXISTS`, so one anomalous
 * row anywhere decided every task. On the canonical damaged shape (one
 * `limit-exceeded` checkpoint parking one task in `needs_attention`) it
 * produced no marker and did nothing at all.
 *
 * So the bar for 0008 in EVERY one of the six cases is now identical and
 * absolute: it changes nothing. These suites assert exactly that, by executing
 * the file, twice, against each starting point. What the freeze leaves
 * unrepaired is covered by `listCandidates` / `releaseLatch` — the operator
 * command — and asserted here too, in the same fixtures, so "0008 no longer
 * repairs this" and "something else does" cannot drift apart.
 */

/** The `signalled_at` clock is ms; `schema_migrations.applied_at` is seconds. */
const T5_SECONDS = 1_700_000_000;
const T5_MS = T5_SECONDS * 1000;
/** Everything the ORIGINAL 0005 backfill saw happened before it ran. */
const BEFORE = T5_MS - 60_000;
/** Everything the running code did afterwards happened after it. */
const AFTER = T5_MS + 60_000;

/**
 * 0005 as it was originally written and originally recorded. Kept verbatim so
 * case (b) is a real reconstruction and not a paraphrase of one: it excluded
 * only `waiting%` (missing `needs_attention`) and scoped that exclusion to the
 * TASK rather than the task's latest resolved checkpoint.
 */
const ORIGINAL_0005 = `
ALTER TABLE checkpoints ADD COLUMN signalled_at INTEGER;

UPDATE checkpoints
   SET signalled_at = COALESCE(answered_at, created_at)
 WHERE status != 'pending'
   AND signalled_at IS NULL
   AND task_id NOT IN (SELECT id FROM tasks WHERE status LIKE 'waiting%');

CREATE INDEX IF NOT EXISTS checkpoints_undelivered_idx
  ON checkpoints(answered_at)
  WHERE signalled_at IS NULL AND status != 'pending';
`;

function seedEnvironment(db: Db): void {
  db.prepare(
    "INSERT INTO environments (id, timezone, created_at, updated_at) VALUES ('env', 'UTC', 0, 0)",
  ).run();
  db.prepare(
    `INSERT INTO workspaces (id, environment_id, kind, display_name, status, policy_json,
                             version, created_at, updated_at)
     VALUES ('ws', 'env', 'execution', 'ws', 'active', '{}', 0, 0, 0)`,
  ).run();
}

function addTask(db: Db, id: string, status: string): void {
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, origin, pipeline, title, intent_json, status,
                        temporal_workflow_id, version, created_at, updated_at)
     VALUES (?, 'ws', 'cli', 'coding', ?, '{}', ?, ?, 0, 0, 0)`,
  ).run(id, id, status, `task/${id}`);
}

function addCheckpoint(
  db: Db,
  args: { id: string; taskId: string; kind?: string; status?: string; answeredAt: number },
): void {
  db.prepare(
    `INSERT INTO checkpoints (id, task_id, kind, status, prompt, choices_json, answer_json,
                              version, created_at, answered_at)
     VALUES (?, ?, ?, ?, 'p', '[]', '{"choice":"extend"}', 2, ?, ?)`,
  ).run(
    args.id,
    args.taskId,
    args.kind ?? "limit-exceeded",
    args.status ?? "answered",
    args.answeredAt,
    args.answeredAt,
  );
}

/** What the running code does when a signal lands: same clock, often same ms. */
function latchAsCodeWould(db: Db, id: string, at: number): void {
  db.prepare("UPDATE checkpoints SET signalled_at = ? WHERE id = ?").run(at, id);
}

function signalledAt(db: Db, id: string): number | null {
  return (db.prepare("SELECT signalled_at AS v FROM checkpoints WHERE id = ?").get(id) as {
    v: number | null;
  }).v;
}

/**
 * Rewinds a fixture to a database that predates checksums entirely, which is
 * what every one of these historical starting points actually is: the runs
 * being reconstructed happened before the ledger had a `checksum` column.
 * Without this the fixture is self-contradictory — a checksummed version-4 row
 * next to a hand-inserted, checksum-less version-5 row — and the runner is
 * right to reject it, because that shape means the column was erased.
 */
function asPreChecksumDatabase(db: Db): void {
  db.exec("UPDATE schema_migrations SET checksum = NULL");
  db.exec("DROP TABLE IF EXISTS schema_migrations_meta");
}

function signalledBy(db: Db, id: string): string | null {
  return (db.prepare("SELECT signalled_by AS v FROM checkpoints WHERE id = ?").get(id) as {
    v: string | null;
  }).v;
}

function snapshotDelivery(db: Db): Record<string, string> {
  const rows = db
    .prepare("SELECT id, signalled_at, signalled_by FROM checkpoints ORDER BY id")
    .all() as { id: string; signalled_at: number | null; signalled_by: string | null }[];
  return Object.fromEntries(
    rows.map((r) => [r.id, `${String(r.signalled_at)}/${String(r.signalled_by)}`]),
  );
}

/**
 * The freeze assertion, in one place so no suite can quietly use a weaker one.
 * Re-executes 0008's file TWICE against whatever state the caller has reached
 * and requires that not one latch or provenance changed. The version ledger
 * would skip the file, which proves nothing at all about its contents.
 */
function expectFrozen0008ToChangeNothing(db: Db): void {
  const before = snapshotDelivery(db);
  db.exec(FROZEN_0008);
  db.exec(FROZEN_0008);
  expect(snapshotDelivery(db)).toEqual(before);
}

describe("(c) a fresh database", () => {
  it("applies the whole chain, and the frozen 0008 changes nothing", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    seedEnvironment(db);
    addTask(db, "t1", "needs_attention");
    const after =
      (db.prepare("SELECT applied_at AS v FROM schema_migrations WHERE version = 5").get() as {
        v: number;
      }).v *
        1000 +
      60_000;
    addCheckpoint(db, { id: "cp-1", taskId: "t1", answeredAt: after });
    latchAsCodeWould(db, "cp-1", after);

    expectFrozen0008ToChangeNothing(db);
    db.close();
  });

  it("ends with every migration recorded exactly once", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((r) => (r as { version: number }).version);
    expect(versions).toEqual(migrations.map((m) => m.version));
    db.close();
  });
});

describe("(a) a database created before 0005 existed", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    // Stop at 0004: the state of a daemon that never saw checkpoint delivery.
    migrate(db, migrations.slice(0, 4));
    seedEnvironment(db);
    addTask(db, "parked", "needs_attention");
    addTask(db, "waiting", "waiting_review");
    addTask(db, "running", "executing");
    // Two resolved checkpoints on the parked task: only the newest can be the
    // one it is parked on.
    addCheckpoint(db, { id: "cp-old", taskId: "parked", answeredAt: BEFORE - 1000 });
    addCheckpoint(db, { id: "cp-new", taskId: "parked", answeredAt: BEFORE });
    addCheckpoint(db, { id: "cp-wait", taskId: "waiting", answeredAt: BEFORE });
    addCheckpoint(db, { id: "cp-run", taskId: "running", answeredAt: BEFORE });
  });

  it("leaves exactly the parked tasks' newest answers for the sweep, and 0008 changes nothing", () => {
    // Run through 0005 only, so the post-0005 state is observable.
    migrate(db, migrations.slice(0, 5));
    // `signalled_by` does not exist yet at version 5, so this snapshot is
    // latches only.
    const latches = (): Record<string, number | null> =>
      Object.fromEntries(
        (
          db.prepare("SELECT id, signalled_at FROM checkpoints ORDER BY id").all() as {
            id: string;
            signalled_at: number | null;
          }[]
        ).map((r) => [r.id, r.signalled_at]),
      );
    const afterCorrected0005 = latches();
    expect(afterCorrected0005["cp-new"]).toBeNull();
    expect(afterCorrected0005["cp-wait"]).toBeNull();
    expect(afterCorrected0005["cp-old"]).not.toBeNull();
    expect(afterCorrected0005["cp-run"]).not.toBeNull();

    migrate(db, migrations);
    // 0007 stamps provenance; that is the only change the rest of the chain
    // makes, and it never moves a latch.
    expect(latches()).toEqual(afterCorrected0005);
    expectFrozen0008ToChangeNothing(db);
    db.close();
  });

  /**
   * The regression the withdrawn 0006 shipped. A database can sit at version 5
   * for weeks, and the tasks in it go on changing status the whole time:
   *
   *   1. 0005 (corrected) runs. `running` is `executing`, so its resolved
   *      checkpoint is latched with a historical `signalled_at` — right.
   *   2. Later the task hits a step failure and parks in `needs_attention`.
   *   3. The daemon is upgraded and the rest of the chain runs.
   *
   * 0006's first statement matched: the row IS pre-boundary (the backfill wrote
   * it) and the task IS parked — but only NOW, which says nothing about the
   * bucket 0005 put it in. It re-opened a delivered answer and wiped its
   * provenance, the sweep re-signalled, and with the workflow long gone two
   * sweeps corroborated and it reported `CheckpointAnswerDiscarded` for an
   * answer nobody ever lost.
   */
  it.each(["needs_attention", "waiting_review_approval"])(
    "does not re-open a delivered answer whose task parks in %s AFTER 0005 ran",
    (parkedStatus) => {
      migrate(db, migrations.slice(0, 5));
      const delivered = signalledAt(db, "cp-run");
      expect(delivered).not.toBeNull();

      // Weeks pass. The task fails a step and parks.
      db.prepare("UPDATE tasks SET status = ? WHERE id = 'running'").run(parkedStatus);

      migrate(db, migrations);

      expect(signalledAt(db, "cp-run")).toBe(delivered);
      expect(signalledBy(db, "cp-run")).toBe("backfill");
      expectFrozen0008ToChangeNothing(db);
      db.close();
    },
  );

  /**
   * 0005 leaves the parked task's LATEST resolved checkpoint open, and "latest"
   * has to be a total order or the migration is a coin flip: two checkpoints
   * answered in the same millisecond would leave whichever row the query
   * planner happened to visit first open, so the same database migrated on two
   * machines would re-signal different checkpoints.
   */
  it("breaks a same-millisecond tie in 0005 by id, not by scan order", () => {
    addTask(db, "tie", "needs_attention");
    addCheckpoint(db, { id: "tie-a", taskId: "tie", answeredAt: BEFORE });
    addCheckpoint(db, { id: "tie-b", taskId: "tie", answeredAt: BEFORE });

    migrate(db, migrations.slice(0, 5));

    expect(signalledAt(db, "tie-b")).toBeNull();
    expect(signalledAt(db, "tie-a")).not.toBeNull();
    db.close();
  });

  it("records 0005's inferred latches as 'backfill', never as an observed signal", () => {
    migrate(db, migrations);
    expect(signalledBy(db, "cp-old")).toBe("backfill");
    expect(signalledBy(db, "cp-run")).toBe("backfill");
    expect(signalledBy(db, "cp-new")).toBeNull();
    db.close();
  });
});

describe("(b) a database that recorded the ORIGINAL 0005", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, migrations.slice(0, 4));
    asPreChecksumDatabase(db);
    seedEnvironment(db);
    addTask(db, "parked", "needs_attention");
    addTask(db, "waiting", "waiting_review");

    // --- rows that existed when the ORIGINAL 0005 ran -------------------
    // The wedged budget extension: a `limit-exceeded` answer on a task parked
    // in `needs_attention`. The original predicate latched it without ever
    // delivering it. This is the row the whole chain was about.
    addCheckpoint(db, { id: "wedged", taskId: "parked", answeredAt: BEFORE });
    // An older, genuinely consumed answer on the same parked task.
    addCheckpoint(db, { id: "stale-parked", taskId: "parked", answeredAt: BEFORE - 2000 });
    // Under a `waiting%` task the original 0005 left EVERY resolved row open,
    // including ones consumed rounds ago.
    addCheckpoint(db, { id: "wait-stale", taskId: "waiting", answeredAt: BEFORE - 2000 });
    addCheckpoint(db, { id: "wait-newest", taskId: "waiting", answeredAt: BEFORE });

    db.exec(ORIGINAL_0005);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, 'checkpoint_delivery', ?)",
    ).run(T5_SECONDS);
  });

  /**
   * THE FREEZE, ON THE ONE DATABASE 0008 EXISTED FOR. It no longer re-opens the
   * wedged answer, and that is the deliberate cost: the previous 0008 got this
   * row right only when some OTHER task in the same database happened to carry
   * a second unlatched pre-0005 checkpoint, and got a delivered answer
   * catastrophically wrong whenever the clock had stepped. A repair whose
   * verdict depends on an unrelated row, and whose failure mode is losing a
   * committed human answer, is not a repair.
   */
  it("leaves the wedged answer latched — the freeze, stated as a cost, not an accident", () => {
    migrate(db, migrations);
    expect(signalledAt(db, "wedged")).toBe(BEFORE);
    expect(signalledBy(db, "wedged")).toBe("backfill");
    expectFrozen0008ToChangeNothing(db);
    db.close();
  });

  /**
   * ...and this is what covers it. The operator command finds the wedged row,
   * with the provenance 0007 stored, and a human who can look at the workflow
   * clears exactly that one latch. `listUndeliveredCheckpoints` selects on
   * `signalled_at IS NULL`, so the running daemon picks it up unchanged.
   */
  it("is reported by the operator command, with its evidence, and repairable by hand", () => {
    migrate(db, migrations);

    const candidates = listCandidates(db);
    const wedged = candidates.find((c) => c.checkpointId === "wedged");
    expect(wedged).toMatchObject({
      taskId: "parked",
      taskStatus: "needs_attention",
      checkpointKind: "limit-exceeded",
      checkpointStatus: "answered",
      answeredAt: BEFORE,
      signalledAt: BEFORE,
      signalledBy: "backfill",
      latch: "backfill",
    });

    // Dry by default: the evidence is printable before anything is written.
    expect(releaseLatch(db, "wedged", { apply: false }).outcome).toBe("would-release");
    expect(signalledAt(db, "wedged")).toBe(BEFORE);

    expect(releaseLatch(db, "wedged", { apply: true }).outcome).toBe("released");
    expect(signalledAt(db, "wedged")).toBeNull();
    expect(signalledBy(db, "wedged")).toBeNull();
    db.close();
  });

  /**
   * The other half of the freeze: the stale answers the original 0005 wrongly
   * left OPEN stay open. They are already in `listUndeliveredCheckpoints`, so
   * the sweep will re-signal them; a duplicate signal is inert, because
   * TaskWorkflow consumes at most one answer per checkpoint id. Latching them
   * was the direction 0008 called "non-destructive", and it is the direction
   * that silently loses a committed answer when the clock has moved.
   */
  it("leaves the stale open answers open, where the sweep can still see them", () => {
    expect(signalledAt(db, "wait-stale")).toBeNull();
    migrate(db, migrations);
    expect(signalledAt(db, "wait-stale")).toBeNull();
    expect(signalledAt(db, "wait-newest")).toBeNull();
    expectFrozen0008ToChangeNothing(db);
    db.close();
  });

  /**
   * The false-alarm regression. `resolveCheckpoint` writes
   * `answered_at = now()` and `markCheckpointSignalled` writes `now()` a few
   * in-process operations later, so `signalled_at = COALESCE(answered_at,
   * created_at)` is TRUE for a perfectly ordinary delivered row.
   */
  it("does NOT re-open a delivered answer the code latched in the same millisecond", () => {
    addTask(db, "attention", "needs_attention");
    addCheckpoint(db, { id: "delivered", taskId: "attention", answeredAt: AFTER });
    latchAsCodeWould(db, "delivered", AFTER);

    migrate(db, migrations);

    expect(signalledAt(db, "delivered")).toBe(AFTER);
    // NOT `'signal'`: before 0007 existed the sweep's GIVE-UP path latched a row
    // with no provenance too, so a post-boundary latch on a pre-0007 database
    // may just as well be an answer that was thrown away.
    expect(signalledBy(db, "delivered")).toBeNull();
    expectFrozen0008ToChangeNothing(db);
    db.close();
  });

  it("does NOT latch a real post-0005 backlog row under a parked task", () => {
    addCheckpoint(db, { id: "owed", taskId: "waiting", answeredAt: AFTER });
    addCheckpoint(db, { id: "newer-still", taskId: "waiting", answeredAt: AFTER + 1000 });
    latchAsCodeWould(db, "newer-still", AFTER + 1000);

    migrate(db, migrations);

    expect(signalledAt(db, "owed")).toBeNull();
    expectFrozen0008ToChangeNothing(db);
    db.close();
  });
});

/**
 * F16, reproduced. The era fence 0008 used is a comparison between a ledger
 * `applied_at` and an `answered_at` the daemon writes from `Date.now()`. Two
 * ordinary operational events move code-written rows below it: a backwards NTP
 * correction or a VM snapshot restore after 0005 ran, and a container with no
 * RTC whose clock was AHEAD while 0005 ran.
 *
 * Under the old 0008 the row below is a committed, undelivered human answer
 * that the latching half marks `signalled_by = 'backfill'`, after which
 * `listUndeliveredCheckpoints` never sees it again and the workflow stays
 * parked forever. The frozen file must not touch it — and, because it touches
 * nothing at all, cannot.
 */
describe("a clock that stepped backwards after 0005", () => {
  it("does not cost a committed, undelivered answer its place in the sweep", () => {
    const db = new Database(":memory:");
    migrate(db, migrations.slice(0, 4));
    asPreChecksumDatabase(db);
    seedEnvironment(db);
    addTask(db, "parked", "needs_attention");
    // Written by the CODE, after 0005 — but the clock has since stepped back,
    // so its `answered_at` reads as pre-0005. There is no column that says
    // otherwise, which is the entire point.
    addCheckpoint(db, { id: "post-0005-answer", taskId: "parked", answeredAt: BEFORE - 5000 });
    // A second, newer resolved row so the task looks like an ordinary busy one.
    addCheckpoint(db, { id: "newest", taskId: "parked", answeredAt: BEFORE });
    db.exec(ORIGINAL_0005);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, 'checkpoint_delivery', ?)",
    ).run(T5_SECONDS);
    // The original 0005 left both open (per-task exclusion, task not `waiting%`
    // — in fact it latched them; re-open them to model the answer the human
    // committed after 0005 and the sweep still owes).
    db.exec("UPDATE checkpoints SET signalled_at = NULL");

    migrate(db, migrations);

    expect(signalledAt(db, "post-0005-answer")).toBeNull();
    expect(signalledBy(db, "post-0005-answer")).toBeNull();
    expectFrozen0008ToChangeNothing(db);
    db.close();
  });
});

/**
 * F18, reproduced. The canonical damaged database: ONE task, parked in
 * `needs_attention` by ONE `limit-exceeded` checkpoint whose answer the
 * original 0005 latched. 0008's marker needed a task with two or more resolved
 * pre-0005 checkpoints, the older still unlatched, so on this database — the
 * likeliest damaged one — it did nothing whatsoever, while accepting the risk
 * of destroying data on every other one.
 *
 * The freeze makes that non-repair explicit and hands the case to the operator
 * command, which finds it because it does not need a marker at all.
 */
describe("the canonical damaged database: one parked task, one wedged answer", () => {
  it("is untouched by the migration and fully visible to the operator command", () => {
    const db = new Database(":memory:");
    migrate(db, migrations.slice(0, 4));
    asPreChecksumDatabase(db);
    seedEnvironment(db);
    addTask(db, "solo", "needs_attention");
    addCheckpoint(db, { id: "unknowable", taskId: "solo", answeredAt: BEFORE });
    db.exec(ORIGINAL_0005);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, 'checkpoint_delivery', ?)",
    ).run(T5_SECONDS);
    expect(signalledAt(db, "unknowable")).toBe(BEFORE);

    migrate(db, migrations);

    expect(signalledAt(db, "unknowable")).toBe(BEFORE);
    expect(signalledBy(db, "unknowable")).toBe("backfill");
    expectFrozen0008ToChangeNothing(db);

    expect(listCandidates(db).map((c) => c.checkpointId)).toEqual(["unknowable"]);
    expect(releaseLatch(db, "unknowable", { apply: true }).outcome).toBe("released");
    expect(signalledAt(db, "unknowable")).toBeNull();
    db.close();
  });
});

/**
 * (d) and (e): the CORRECTED 0005, under each of the two ledger names it has
 * been recorded under. The name must make NO difference to the outcome.
 */
describe.each([
  ["checkpoint_delivery", "(d) the OLD name, from the window where the SQL was already corrected"],
  ["checkpoint_delivery_scoped", "(e) the NEW name"],
])("a database that ran the CORRECTED 0005 recorded as %s — %s", (ledgerName) => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, migrations.slice(0, 4));
    asPreChecksumDatabase(db);
    seedEnvironment(db);
    // Not parked when 0005 runs, so the corrected backfill latches its answer
    // — the right call, and code-era ground truth from here on.
    addTask(db, "t1", "executing");
    addCheckpoint(db, { id: "c1", taskId: "t1", answeredAt: BEFORE });
    // Parked when 0005 runs: its newest answer is the one the sweep still owes.
    addTask(db, "t2", "waiting_review");
    addCheckpoint(db, { id: "c2-stale", taskId: "t2", answeredAt: BEFORE - 2000 });
    addCheckpoint(db, { id: "c2-owed", taskId: "t2", answeredAt: BEFORE });

    db.exec(CORRECTED_0005);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, ?, ?)",
    ).run(ledgerName, T5_SECONDS);
    expect(signalledAt(db, "c1")).toBe(BEFORE);
    expect(signalledAt(db, "c2-stale")).toBe(BEFORE - 2000);
    expect(signalledAt(db, "c2-owed")).toBeNull();
  });

  /**
   * F17's damage, if the marker ever fired here — which a backwards clock step
   * could make it do. `c1` was delivered and latched by a backfill that got it
   * RIGHT; 0007 stamps it `'backfill'`, which is true and says nothing about
   * whether it was wrong. Re-opening it makes the sweep re-signal a workflow
   * that is long gone, and two sweeps corroborate it into a false
   * `CheckpointAnswerDiscarded`.
   */
  it("does not re-open a delivered answer whose task parks AFTER 0005 ran", () => {
    db.prepare("UPDATE tasks SET status = 'needs_attention' WHERE id = 't1'").run();

    migrate(db, migrations);

    expect(signalledAt(db, "c1")).toBe(BEFORE);
    expect(signalledBy(db, "c1")).toBe("backfill");
    expectFrozen0008ToChangeNothing(db);
    db.close();
  });

  /**
   * The data-loss direction. 0005 deliberately left `c2-owed` open for the
   * sweep. Weeks later the task resolves and delivers a NEWER checkpoint, so
   * "the task's latest resolved checkpoint" — evaluated at repair time — is no
   * longer `c2-owed`. Latching it drops it out of `listUndeliveredCheckpoints`
   * forever: a committed human answer, permanently marked delivered, silently.
   */
  it("does not latch the answer 0005 protected, even after a newer checkpoint resolves", () => {
    addCheckpoint(db, { id: "c2-newer", taskId: "t2", answeredAt: AFTER });
    latchAsCodeWould(db, "c2-newer", AFTER);
    db.prepare("UPDATE tasks SET status = 'needs_attention' WHERE id = 't2'").run();

    migrate(db, migrations);

    expect(signalledAt(db, "c2-owed")).toBeNull();
    expect(signalledBy(db, "c2-owed")).toBeNull();
    expectFrozen0008ToChangeNothing(db);
    db.close();
  });

  it("changes nothing at all, and re-running 0008 changes nothing again", () => {
    migrate(db, migrations.slice(0, 7));
    const settled = snapshotDelivery(db);
    migrate(db, migrations);
    expect(snapshotDelivery(db)).toEqual(settled);
    expectFrozen0008ToChangeNothing(db);
    db.close();
  });
});

/**
 * 0006 as it was actually shipped, kept verbatim so (f) is a reconstruction and
 * not a paraphrase.
 */
const OLD_0006 = `
UPDATE checkpoints
   SET signalled_at = NULL
 WHERE status != 'pending'
   AND signalled_at IS NOT NULL
   AND signalled_at < (SELECT applied_at FROM schema_migrations WHERE version = 5) * 1000
   AND task_id IN (SELECT id FROM tasks WHERE status = 'needs_attention')
   AND id = (
         SELECT c2.id
           FROM checkpoints c2
          WHERE c2.task_id = checkpoints.task_id
            AND c2.status != 'pending'
          ORDER BY COALESCE(c2.answered_at, c2.created_at) DESC, c2.id DESC
          LIMIT 1
       );

UPDATE checkpoints
   SET signalled_at = COALESCE(answered_at, created_at)
 WHERE status != 'pending'
   AND signalled_at IS NULL
   AND COALESCE(answered_at, created_at)
         < (SELECT applied_at FROM schema_migrations WHERE version = 5) * 1000
   AND task_id IN (
         SELECT id FROM tasks WHERE status LIKE 'waiting%' OR status = 'needs_attention'
       )
   AND id != (
         SELECT c2.id
           FROM checkpoints c2
          WHERE c2.task_id = checkpoints.task_id
            AND c2.status != 'pending'
          ORDER BY COALESCE(c2.answered_at, c2.created_at) DESC, c2.id DESC
          LIMIT 1
       );
`;

/**
 * (f) A database that already recorded version 6 with the WITHDRAWN 0006. It
 * will never re-run 0006, but 0007 and 0008 still run on it. 0006's damage is
 * unrecoverable — it destroyed the bit that told a re-opened row from a genuine
 * one — so the bar here is that nothing later ADDS to it.
 */
describe("(f) a database already at version 6 with the OLD 0006 applied", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, migrations.slice(0, 4));
    asPreChecksumDatabase(db);
    seedEnvironment(db);
    addTask(db, "t1", "executing");
    addCheckpoint(db, { id: "c1", taskId: "t1", answeredAt: BEFORE });
    addTask(db, "t2", "waiting_review");
    addCheckpoint(db, { id: "c2-stale", taskId: "t2", answeredAt: BEFORE - 2000 });
    addCheckpoint(db, { id: "c2-owed", taskId: "t2", answeredAt: BEFORE });
    db.exec(CORRECTED_0005);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, 'checkpoint_delivery', ?)",
    ).run(T5_SECONDS);
    // Weeks pass; t1 parks. This is the state the old 0006 mangled.
    db.prepare("UPDATE tasks SET status = 'needs_attention' WHERE id = 't1'").run();
    db.exec(OLD_0006);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (6, 'checkpoint_delivery_backfill_repair', ?)",
    ).run(T5_SECONDS + 1);
    // 0006 re-opened `c1` — its damage, already done and not ours to undo.
    expect(signalledAt(db, "c1")).toBeNull();
  });

  it("does not re-open anything further, does not latch the owed answer, and is a no-op", () => {
    migrate(db, migrations);

    // The answer the sweep still owes is still owed.
    expect(signalledAt(db, "c2-owed")).toBeNull();
    // The stale one 0005 latched stays latched.
    expect(signalledAt(db, "c2-stale")).toBe(BEFORE - 2000);
    expectFrozen0008ToChangeNothing(db);
    db.close();
  });
});

/**
 * (b) again, on the shape 0008's LATCHING half used to act on. That half was
 * the "non-destructive" one, and it is the one that silently loses a committed
 * answer when the wall clock has moved. Frozen, `wait-stale` simply stays in
 * the sweep's queue — a duplicate signal for an answer the workflow already
 * consumed is inert, and being wrong in that direction costs a log line rather
 * than a human's answer.
 */
describe("(b) the ORIGINAL 0005, after the code resolved a newer checkpoint", () => {
  it("latches nothing at all, and leaves both stale and owed answers to the sweep", () => {
    const db = new Database(":memory:");
    migrate(db, migrations.slice(0, 4));
    asPreChecksumDatabase(db);
    seedEnvironment(db);
    addTask(db, "waiting", "waiting_review");
    addCheckpoint(db, { id: "wait-stale", taskId: "waiting", answeredAt: BEFORE - 2000 });
    addCheckpoint(db, { id: "wait-owed", taskId: "waiting", answeredAt: BEFORE });
    db.exec(ORIGINAL_0005);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, 'checkpoint_delivery', ?)",
    ).run(T5_SECONDS);
    // Weeks later, a newer checkpoint resolves and IS delivered.
    addCheckpoint(db, { id: "wait-newer", taskId: "waiting", answeredAt: AFTER });
    latchAsCodeWould(db, "wait-newer", AFTER);

    migrate(db, migrations);

    expect(signalledAt(db, "wait-stale")).toBeNull();
    expect(signalledAt(db, "wait-owed")).toBeNull();
    expect(signalledAt(db, "wait-newer")).toBe(AFTER);
    expectFrozen0008ToChangeNothing(db);
    db.close();
  });
});
