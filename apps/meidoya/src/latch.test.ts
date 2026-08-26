import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrate,
  migrations,
  openDatabase,
  openDatabaseForAdmin,
  type MeidoyaDatabase,
} from "@meidoya/store-sqlite";
import { runLatchCommand, type LatchIo } from "./latch.js";

/**
 * `meidoya admin latch` — the operator surface that replaced migration 0008.
 *
 * The migration's job was to guess which committed answers had never reached
 * their workflow. It cannot be guessed from the database, so the surface here is
 * judged on one thing: does it put every stored fact in front of the human, and
 * does it refuse to change anything they did not name.
 *
 * THIS SUITE USED TO STUB `open`. It handed the command a Proxy over one
 * in-memory database with `close` neutered, which meant the real open path — the
 * one that decides whether a file is created, whether it is opened read-only,
 * and whether `journal_mode` is written — was never executed by any test. Both
 * defects it was hiding were real: `--db /tmp/typo.sqlite` INVENTED that
 * database and reported it healthy, and pointing `list` at any other SQLite file
 * converted it to WAL permanently before reading a row. So the fixture is now a
 * real file on disk opened by the real `openDatabaseForAdmin`, and the command
 * opens and closes it for itself on every invocation, exactly as it does in
 * production.
 */

const NOW = 1_700_000_000_000;

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "meidoya-latch-test-"));
  temporary.push(dir);
  return dir;
}

type Harness = {
  io: LatchIo;
  dbPath: string;
  dir: string;
  out: string[];
  err: string[];
  /** Opens the fixture for the test's own assertions and seeding. */
  withDb: <T>(body: (db: MeidoyaDatabase) => T) => T;
};

function harness(): Harness {
  const dir = tempDir();
  const dbPath = join(dir, "control_plane.sqlite");
  const seed = openDatabase(dbPath);
  migrate(seed, migrations);
  seed
    .prepare(
      "INSERT INTO environments (id, timezone, created_at, updated_at) VALUES ('env', 'UTC', 0, 0)",
    )
    .run();
  seed
    .prepare(
      `INSERT INTO workspaces (id, environment_id, kind, display_name, status, policy_json,
                               version, created_at, updated_at)
       VALUES ('ws', 'env', 'execution', 'ws', 'active', '{}', 0, 0, 0)`,
    )
    .run();
  seed.close();

  const out: string[] = [];
  const err: string[] = [];
  return {
    dir,
    dbPath,
    out,
    err,
    io: { out: (line) => out.push(line), err: (line) => err.push(line), open: openDatabaseForAdmin },
    withDb: (body) => {
      const db = openDatabase(dbPath);
      try {
        return body(db);
      } finally {
        db.close();
      }
    },
  };
}

function addWedged(h: Harness, taskStatus = "needs_attention"): void {
  h.withDb((db) => {
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, origin, pipeline, title, intent_json, status,
                          temporal_workflow_id, version, created_at, updated_at)
       VALUES ('t1', 'ws', 'cli', 'coding', 'raise the budget', '{}', ?, 'task/t1', 0, 0, 0)`,
    ).run(taskStatus);
    db.prepare(
      `INSERT INTO checkpoints (id, task_id, kind, status, prompt, choices_json, answer_json,
                                version, created_at, answered_at, signalled_at, signalled_by)
       VALUES ('cp-1', 't1', 'limit-exceeded', 'answered', 'p', '[]', '{}', 2, ?, ?, ?, 'backfill')`,
    ).run(NOW - 1000, NOW, NOW);
  });
}

function signalledAt(h: Harness): number | null {
  return h.withDb(
    (db) =>
      (db.prepare("SELECT signalled_at AS v FROM checkpoints WHERE id = 'cp-1'").get() as {
        v: number | null;
      }).v,
  );
}

const ENV = {};

describe("meidoya admin latch", () => {
  it("refuses to guess the database path", () => {
    const h = harness();
    expect(runLatchCommand(h.io, ["list"], {}, ENV)).toBe(2);
    expect(h.err.join("\n")).toMatch(/needs the database path/);
    expect(h.err.join("\n")).toMatch(/never guessed/);
  });

  it("accepts MEIDOYA_SQLITE_PATH as a fallback", () => {
    const h = harness();
    expect(runLatchCommand(h.io, ["list"], {}, { MEIDOYA_SQLITE_PATH: h.dbPath })).toBe(0);
  });

  it("says so plainly when there is nothing parked", () => {
    const h = harness();
    expect(runLatchCommand(h.io, ["list"], { db: h.dbPath }, ENV)).toBe(0);
    expect(h.out).toContain("no resolved checkpoints under a parked task");
  });

  /**
   * The whole point of the command: the evidence. Task id and status say WHERE
   * the wedge is, the checkpoint kind says WHAT answer is stuck, and
   * `signalled_by` — migration 0007's column, kept for exactly this — says
   * whether "delivered" was OBSERVED or merely INFERRED by a migration. Without
   * that last field the operator is guessing as badly as 0008 was.
   */
  it("prints task, checkpoint, timestamps and latch provenance", () => {
    const h = harness();
    addWedged(h);
    expect(runLatchCommand(h.io, ["list"], { db: h.dbPath }, ENV)).toBe(0);
    const text = h.out.join("\n");

    expect(text).toContain("cp-1  [backfill]");
    expect(text).toContain("t1  needs_attention  raise the budget");
    expect(text).toContain("limit-exceeded  answered");
    expect(text).toContain(new Date(NOW).toISOString());
    expect(text).toMatch(/latched .*by backfill/);
    // And a legend, because "backfill" is meaningless to a reader who has not
    // read four migration headers.
    expect(text).toMatch(/backfill\s+a MIGRATION inferred delivery/);
    expect(text).toMatch(/meidoya admin latch release/);
  });

  it("emits machine-readable evidence with --json", () => {
    const h = harness();
    addWedged(h);
    expect(runLatchCommand(h.io, ["list"], { db: h.dbPath, json: true }, ENV)).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toEqual([
      {
        checkpointId: "cp-1",
        taskId: "t1",
        taskTitle: "raise the budget",
        taskStatus: "needs_attention",
        checkpointKind: "limit-exceeded",
        checkpointStatus: "answered",
        createdAt: NOW - 1000,
        answeredAt: NOW,
        signalledAt: NOW,
        signalledBy: "backfill",
        latch: "backfill",
      },
    ]);
  });

  it("is a dry run unless --apply is given", () => {
    const h = harness();
    addWedged(h);
    expect(runLatchCommand(h.io, ["release"], { db: h.dbPath, checkpoint: "cp-1" }, ENV)).toBe(0);
    expect(h.out.join("\n")).toMatch(/Nothing written — re-run with --apply/);
    expect(signalledAt(h)).toBe(NOW);
  });

  it("clears the latch with --apply and says what happens next", () => {
    const h = harness();
    addWedged(h);
    expect(
      runLatchCommand(h.io, ["release"], { db: h.dbPath, checkpoint: "cp-1", apply: true }, ENV),
    ).toBe(0);
    expect(h.out.join("\n")).toMatch(/reconciliation sweep will re-deliver/);
    expect(signalledAt(h)).toBeNull();
  });

  it("refuses an observed delivery, and explains the cost of overriding it", () => {
    const h = harness();
    addWedged(h);
    h.withDb((db) => {
      db.prepare("UPDATE checkpoints SET signalled_by = 'signal' WHERE id = 'cp-1'").run();
    });

    expect(
      runLatchCommand(h.io, ["release"], { db: h.dbPath, checkpoint: "cp-1", apply: true }, ENV),
    ).toBe(1);
    expect(h.err.join("\n")).toMatch(/CheckpointAnswerDiscarded/);
    expect(signalledAt(h)).toBe(NOW);

    expect(
      runLatchCommand(
        h.io,
        ["release"],
        { db: h.dbPath, checkpoint: "cp-1", apply: true, force: true },
        ENV,
      ),
    ).toBe(0);
    expect(signalledAt(h)).toBeNull();
  });

  it("needs an explicit --checkpoint: there is no bulk mode", () => {
    const h = harness();
    expect(runLatchCommand(h.io, ["release"], { db: h.dbPath, apply: true }, ENV)).toBe(2);
    expect(h.err.join("\n")).toMatch(/needs --checkpoint/);
  });

  it("exits non-zero on an unknown checkpoint id", () => {
    const h = harness();
    expect(
      runLatchCommand(h.io, ["release"], { db: h.dbPath, checkpoint: "nope", apply: true }, ENV),
    ).toBe(1);
    expect(h.err.join("\n")).toMatch(/no such checkpoint: nope/);
  });

  it("shows usage for no subcommand and for an unknown one", () => {
    const h = harness();
    expect(runLatchCommand(h.io, [], {}, ENV)).toBe(2);
    expect(h.out.join("\n")).toMatch(/meidoya admin latch list/);
    expect(runLatchCommand(h.io, ["wat"], { db: h.dbPath }, ENV)).toBe(2);
    expect(h.err.join("\n")).toMatch(/unknown admin latch command: wat/);
  });
});

/**
 * F8's fifth defect: `latch list` was not read-only. It went through
 * `openDatabase`, the DAEMON's opener, which creates the file if it is absent
 * and converts it to WAL before any query — and `journal_mode` is persistent, so
 * a command that looks like a report permanently changed a file it was only
 * meant to read.
 */
describe("admin latch never writes to a database it was asked to read", () => {
  it("does not invent a database for a mistyped --db, and says so", () => {
    const h = harness();
    const typo = join(h.dir, "typo.sqlite");

    expect(runLatchCommand(h.io, ["list"], { db: typo }, ENV)).toBe(2);
    expect(existsSync(typo)).toBe(false);
    expect(h.err.join("\n")).toMatch(/must name an EXISTING database file/);
    // Emphatically NOT a clean bill of health for a database that never existed.
    expect(h.out.join("\n")).not.toMatch(/no resolved checkpoints/);
  });

  it("does not invent one for a dry-run release either", () => {
    const h = harness();
    const typo = join(h.dir, "typo2.sqlite");
    expect(runLatchCommand(h.io, ["release"], { db: typo, checkpoint: "cp-1" }, ENV)).toBe(2);
    expect(existsSync(typo)).toBe(false);
  });

  it("leaves an unrelated SQLite file's journal mode exactly as it found it", () => {
    const h = harness();
    const other = join(h.dir, "someone-elses.sqlite");
    const seed = new Database(other);
    seed.pragma("journal_mode = DELETE");
    seed.exec("CREATE TABLE notes (id TEXT PRIMARY KEY)");
    expect(seed.pragma("journal_mode", { simple: true })).toBe("delete");
    seed.close();

    // It has no `checkpoints` table, so the query fails — but it must fail
    // AFTER having changed nothing, which is the whole point.
    expect(runLatchCommand(h.io, ["list"], { db: other }, ENV)).toBe(2);

    const check = new Database(other, { readonly: true });
    expect(check.pragma("journal_mode", { simple: true })).toBe("delete");
    check.close();
    expect(readdirSync(h.dir).filter((f) => f.startsWith("someone-elses.sqlite-"))).toEqual([]);
  });

  it("opens read-only for list and for a dry run, so a read-only file still works", () => {
    const h = harness();
    addWedged(h);
    // Proven by the mode the command asks for, not by the filesystem: a read
    // open must be exactly that.
    const modes: string[] = [];
    const io: LatchIo = {
      ...h.io,
      open: (path, mode) => {
        modes.push(mode);
        return openDatabaseForAdmin(path, mode);
      },
    };
    expect(runLatchCommand(io, ["list"], { db: h.dbPath }, ENV)).toBe(0);
    expect(runLatchCommand(io, ["release"], { db: h.dbPath, checkpoint: "cp-1" }, ENV)).toBe(0);
    expect(runLatchCommand(io, ["release"], { db: h.dbPath, checkpoint: "cp-1", apply: true }, ENV)).toBe(0);
    expect(modes).toEqual(["read", "read", "write"]);

    // And the read-only connection genuinely refuses writes.
    const readOnly = openDatabaseForAdmin(h.dbPath, "read");
    expect(() => readOnly.prepare("DELETE FROM checkpoints").run()).toThrow(/readonly/i);
    readOnly.close();
  });
});

/**
 * F8's first defect, from the CLI: a checkpoint whose TASK has finished released
 * with no `--force` at all, which is a strictly worse case than the `signal`
 * provenance that did require it — the workflow is not merely possibly gone, it
 * is over. The sweep then re-signals it and reports `CheckpointAnswerDiscarded`
 * for an answer nobody lost.
 */
describe("admin latch fences on the task's status", () => {
  it("refuses a checkpoint under a finished task, and names the reason", () => {
    const h = harness();
    addWedged(h, "succeeded");

    expect(
      runLatchCommand(h.io, ["release"], { db: h.dbPath, checkpoint: "cp-1", apply: true }, ENV),
    ).toBe(1);
    expect(h.err.join("\n")).toMatch(/task t1 is succeeded, not parked on a human/);
    expect(h.err.join("\n")).toMatch(/CheckpointAnswerDiscarded/);
    expect(signalledAt(h)).toBe(NOW);
  });

  it("still allows it with --force, because the operator may have checked", () => {
    const h = harness();
    addWedged(h, "succeeded");

    expect(
      runLatchCommand(
        h.io,
        ["release"],
        { db: h.dbPath, checkpoint: "cp-1", apply: true, force: true },
        ENV,
      ),
    ).toBe(0);
    expect(signalledAt(h)).toBeNull();
  });

  it("reports the refusal as a failure in --json too", () => {
    const h = harness();
    addWedged(h, "succeeded");
    expect(
      runLatchCommand(
        h.io,
        ["release"],
        { db: h.dbPath, checkpoint: "cp-1", apply: true, json: true },
        ENV,
      ),
    ).toBe(1);
    expect(JSON.parse(h.out.join("\n")).outcome).toBe("refused-finished-task");
  });
});
