import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate, migrationChecksum } from "./migrate.js";
import type { Migration } from "./migrate.js";
import { migrations } from "./migrations/index.js";

describe("migrate", () => {
  it("applies the initial schema and is idempotent", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");

    migrate(db, migrations);
    migrate(db, migrations); // second call must be a no-op

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toContain("tasks");
    expect(tables).toContain("workspaces");
    expect(tables).toContain("notification_outbox");

    const appliedCount = (
      db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }
    ).n;
    expect(appliedCount).toBe(migrations.length);
  });

  it("enforces optimistic concurrency via version-guarded update", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);

    const now = 1_700_000_000;
    db.prepare(
      `INSERT INTO environments (id, timezone, created_at, updated_at) VALUES ('env1', 'Asia/Tokyo', ?, ?)`
    ).run(now, now);
    db.prepare(
      `INSERT INTO workspaces (id, environment_id, kind, display_name, status, policy_json, version, created_at, updated_at)
       VALUES ('ws1', 'env1', 'execution', 'Test', 'active', '{}', 0, ?, ?)`
    ).run(now, now);

    const result = db
      .prepare(
        `UPDATE workspaces SET status = 'suspended', version = version + 1 WHERE id = 'ws1' AND version = 5`
      )
      .run();

    expect(result.changes).toBe(0);
  });
});

/**
 * The underlying defect behind BOTH checkpoint-delivery repair bugs: the ledger
 * tracked only `MAX(version)`, so 0005's SQL could be corrected in place and
 * leave no trace whatsoever. Databases provisioned across that window ran
 * different SQL under an identical ledger row, and a later migration that had
 * to tell them apart could not. A checksum makes that edit loud.
 */
describe("migration checksums", () => {
  const sqlMigration = (version: number, name: string, body: string): Migration => ({
    version,
    name,
    checksum: `sha256:${body}`,
    up: (db) => db.exec(body),
  });

  it("records a checksum for every migration it applies", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    const missing = (
      db
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE checksum IS NULL")
        .get() as { n: number }
    ).n;
    expect(missing).toBe(0);
    db.close();
  });

  it("refuses to run against a database whose applied migration has since been edited", () => {
    const db = new Database(":memory:");
    const before = [sqlMigration(1, "one", "CREATE TABLE a (x INTEGER)")];
    migrate(db, before);

    // The same version and the same NAME, different SQL — exactly the shape of
    // the 0005 edit that nothing could see.
    const after = [
      sqlMigration(1, "one", "CREATE TABLE a (x TEXT)"),
      sqlMigration(2, "two", "CREATE TABLE b (y INTEGER)"),
    ];
    expect(() => migrate(db, after)).toThrow(
      /migration 1 \(one\) was applied from different SQL than this build carries/,
    );

    // Fails closed: the new migration must NOT have been applied.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).not.toContain("b");
    db.close();
  });

  it("tolerates a pre-checksum database and starts checksumming from there", () => {
    const db = new Database(":memory:");
    // A developer database from before the column existed: no checksum column,
    // and a version-1 row recorded by the old runner.
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE a (x INTEGER);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'one', 0);
    `);

    // Version 1's SQL differs from what that database ran, and we cannot know
    // it does — NULL means unknown, and unknown must not be back-filled with
    // today's hash, which would launder the very divergence being guarded.
    const current = [
      sqlMigration(1, "one", "CREATE TABLE a (x TEXT)"),
      sqlMigration(2, "two", "CREATE TABLE b (y INTEGER)"),
    ];
    expect(() => migrate(db, current)).not.toThrow();

    const rows = db
      .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
      .all() as { version: number; checksum: string | null }[];
    expect(rows).toEqual([
      { version: 1, checksum: null },
      { version: 2, checksum: "sha256:CREATE TABLE b (y INTEGER)" },
    ]);
    db.close();
  });
});

/**
 * F19 — the checksum was ADVISORY. It had four clean ways around it, and the
 * fourth is the one that actually caused the damage: the recorded NAME was
 * never hashed or verified, and the name is precisely the field migration 0008
 * keyed its verdict on. Each `it` below is one of the four, and each one is
 * pinned by deleting the enforcement and watching this file go red.
 */
describe("F19: the checksum is enforcement, not advice", () => {
  const sqlMigration = (version: number, name: string, body: string): Migration => ({
    version,
    name,
    checksum: `sha256v2:${String(version)}|${name}|${body}`,
    up: (db) => db.exec(body),
  });

  /** Bypass 1: drop the column, `ensureChecksumColumn` re-adds it all-NULL. */
  it("refuses a database whose checksum column was dropped and silently re-added", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    // The whole bypass, in one statement.
    db.exec("ALTER TABLE schema_migrations DROP COLUMN checksum");

    expect(() => migrate(db, migrations)).toThrow(
      /has no recorded checksum, but this database was first seen by a checksumming runner/,
    );
    db.close();
  });

  /** The same bypass one row at a time: NULL out a single hash. */
  it("refuses a single hash that was cleared in place", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    db.exec("UPDATE schema_migrations SET checksum = NULL WHERE version = 8");

    expect(() => migrate(db, migrations)).toThrow(/migration 8 has no recorded checksum/);
    db.close();
  });

  /**
   * Bypass 2: delete a ledger row BELOW `MAX(version)`. The runner applies
   * everything above the max, so the deleted migration is skipped forever and
   * nothing ever complains — the database simply lacks a schema change it
   * believes it has.
   */
  it("refuses a ledger with a hole in it", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    db.exec("DELETE FROM schema_migrations WHERE version = 5");

    expect(() => migrate(db, migrations)).toThrow(
      /migration ledger is not contiguous: version 5 is not recorded, but version 8 is/,
    );
    db.close();
  });

  /**
   * Bypass 3, and the expensive one. 0005's SQL was corrected in one commit and
   * its ledger NAME changed in another, so a database could hold the corrected
   * SQL under the old name — and 0008 read that name as if it recorded which
   * SQL had run. Hashing `version|name|sql` means a rename after release is as
   * loud as an edit, with its own message so the reader knows which happened.
   */
  it("refuses a released migration that has been RENAMED", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);

    const renamed = migrations.map((m) =>
      m.version === 5 ? { ...m, name: "checkpoint_delivery" } : m,
    );
    expect(() => migrate(db, renamed)).toThrow(
      /migration 5 was applied under the ledger name checkpoint_delivery_scoped, but this build calls it checkpoint_delivery/,
    );
    db.close();
  });

  it("covers the name in the hash, so two names never share a checksum", () => {
    expect(migrationChecksum(1, "a", "SELECT 1")).not.toBe(migrationChecksum(1, "b", "SELECT 1"));
    expect(migrationChecksum(1, "a", "SELECT 1")).not.toBe(migrationChecksum(2, "a", "SELECT 1"));
    expect(migrationChecksum(1, "a", "SELECT 1")).toBe(migrationChecksum(1, "a", "SELECT 1"));
  });

  it("still refuses SQL that was edited in place", () => {
    const db = new Database(":memory:");
    migrate(db, [sqlMigration(1, "one", "CREATE TABLE a (x INTEGER)")]);
    expect(() =>
      migrate(db, [
        sqlMigration(1, "one", "CREATE TABLE a (x TEXT)"),
        sqlMigration(2, "two", "CREATE TABLE b (y INTEGER)"),
      ]),
    ).toThrow(/migration 1 \(one\) was applied from different SQL than this build carries/);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).not.toContain("b");
    db.close();
  });
});

/**
 * The upgrade path from the PREVIOUS release, which hashed the SQL alone.
 * Those rows must keep booting — and must keep being verified, so accepting
 * them is not a fifth bypass.
 */
describe("checksums recorded by the previous, SQL-only runner", () => {
  /** A database exactly as the previous release left it. */
  function asPreviousReleaseLedger(db: Database.Database): void {
    for (const m of migrations) {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?").run(
        m.legacyChecksum ?? null,
        m.version,
      );
    }
  }

  it("boots, without back-filling or forgetting anything", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    asPreviousReleaseLedger(db);

    expect(() => migrate(db, migrations)).not.toThrow();
    // Not laundered into the new format: the row still attests to what that
    // runner actually recorded.
    const row = db
      .prepare("SELECT checksum FROM schema_migrations WHERE version = 1")
      .get() as { checksum: string };
    expect(row.checksum).toBe(migrations[0]?.legacyChecksum);
    db.close();
  });

  it("still catches an edit, and still catches a rename, on those rows", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    asPreviousReleaseLedger(db);

    const edited = migrations.map((m) =>
      m.version === 3 ? { ...m, checksum: "sha256v2:x", legacyChecksum: "sha256:x" } : m,
    );
    expect(() => migrate(db, edited)).toThrow(/migration 3 \(binding_epochs\)/);

    const renamed = migrations.map((m) => (m.version === 3 ? { ...m, name: "renamed" } : m));
    expect(() => migrate(db, renamed)).toThrow(/was applied under the ledger name binding_epochs/);
    db.close();
  });
});

/**
 * Migration 0008 was FROZEN to a tombstone after four attempts to repair the
 * checkpoint-delivery latch from SQL alone. Emptying a RELEASED migration is
 * legitimate for exactly one reason — a database that recorded version 8 will
 * never execute the file again — and the runner is told so with one literal
 * hash rather than by weakening the check.
 */
describe("the withdrawal of migration 0008", () => {
  /** The SQL-only hash the previous release recorded for 0008's repair statements. */
  const RELEASED_0008 = "sha256:48c215781485b26a79c576dec017bdc54787af94b0c0d8b7879c89ab59810531";

  it("accepts the released hash of the withdrawn text on an already-applied row", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 8").run(RELEASED_0008);

    expect(() => migrate(db, migrations)).not.toThrow();
    db.close();
  });

  it("names that hash explicitly, and only for version 8", () => {
    const eight = migrations.find((m) => m.version === 8);
    expect(eight?.supersededChecksums).toEqual([RELEASED_0008]);
    // Not the current hash of anything: it is a record of a withdrawn release.
    expect(eight?.checksum).not.toBe(RELEASED_0008);
    expect(eight?.legacyChecksum).not.toBe(RELEASED_0008);
    for (const m of migrations) {
      if (m.version !== 8) expect(m.supersededChecksums).toBeUndefined();
    }
  });

  it("is not a general amnesty: any other hash on version 8 still fails", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 8").run("sha256:deadbeef");

    expect(() => migrate(db, migrations)).toThrow(
      /migration 8 \(checkpoint_backfill_repair\) was applied from different SQL/,
    );
    db.close();
  });

  it("contains no executable statement at all", () => {
    // A tombstone must be provably empty, not merely conditionally inert. SQLite
    // parses the file and reports how many statements it found; comments are none.
    const text = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "migrations", "0008_checkpoint_backfill_repair.sql"),
      "utf8",
    );
    // Comments and whitespace only: no statement, conditional or otherwise.
    expect(/^\s*(--[^\n]*\n|\s)*$/.test(text)).toBe(true);

    const db = new Database(":memory:");
    migrate(db, migrations);
    const schemaBefore = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as {
      n: number;
    };
    const changesBefore = db.prepare("SELECT total_changes() AS n").get() as { n: number };
    db.exec(text);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()).toEqual(schemaBefore);
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changesBefore);
    db.close();
  });
});

/**
 * F20 — a database recording version 9 against an 8-migration build used to
 * boot silently and then read and write a schema this code does not know.
 */
describe("F20: downgrade guard", () => {
  it("refuses to run an older build against a newer schema", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (9, 'from_the_future', 0, 'sha256v2:future')",
    ).run();

    expect(() => migrate(db, migrations)).toThrow(
      /database schema version 9 is newer than this build, which carries 8 migrations/,
    );
    db.close();
  });

  it("does not mistake an equal version for a downgrade", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    expect(() => migrate(db, migrations)).not.toThrow();
    db.close();
  });
});

/**
 * P4 — `PRAGMA foreign_keys` is SILENTLY IGNORED inside a transaction, and every
 * migration runs inside one, so the first migration to attempt SQLite's 12-step
 * table rebuild would have run with foreign keys ON and simply failed. Nothing
 * in 0001..0008 does a rebuild, so nothing is broken today; this pins the
 * property before something depends on it.
 */
describe("P4: foreign keys during a migration", () => {
  const rebuildEnvironments = (statements: string): Migration => ({
    version: 9,
    name: "rebuild",
    checksum: "sha256v2:rebuild",
    up: (d) => d.exec(statements),
  });

  function seed(db: Database.Database): void {
    db.prepare(
      "INSERT INTO environments (id, timezone, created_at, updated_at) VALUES ('env', 'UTC', 0, 0)",
    ).run();
    db.prepare(
      `INSERT INTO workspaces (id, environment_id, kind, display_name, status, policy_json,
                               version, created_at, updated_at)
       VALUES ('ws', 'env', 'execution', 'ws', 'active', '{}', 0, 0, 0)`,
    ).run();
  }

  /** The defect itself, so nobody "simplifies" the fix back into the pragma. */
  it("PRAGMA foreign_keys inside a transaction really is ignored", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("BEGIN");
    db.exec("PRAGMA foreign_keys = OFF");
    const state = db.pragma("foreign_keys", { simple: true });
    db.exec("COMMIT");
    expect(state).toBe(1);
    db.close();
  });

  /**
   * And why `defer_foreign_keys` is not the answer either: it defers the check,
   * but `DROP TABLE` bumps the deferred violation counter and nothing ever
   * decrements it, so a rebuild of a REFERENCED table fails at COMMIT anyway.
   */
  it("defer_foreign_keys does not survive a DROP TABLE either", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(
      "CREATE TABLE p (id TEXT PRIMARY KEY);" +
        "CREATE TABLE c (id TEXT PRIMARY KEY, p TEXT REFERENCES p(id));" +
        "INSERT INTO p VALUES ('a'); INSERT INTO c VALUES ('x', 'a');",
    );
    expect(() => {
      db.exec("BEGIN");
      db.exec("PRAGMA defer_foreign_keys = ON");
      db.exec(
        "CREATE TABLE p_new (id TEXT PRIMARY KEY);" +
          "INSERT INTO p_new SELECT id FROM p;" +
          "DROP TABLE p;" +
          "ALTER TABLE p_new RENAME TO p;",
      );
      db.exec("COMMIT");
    }).toThrow(/FOREIGN KEY constraint failed/);
    db.close();
  });

  it("lets a full 12-step rebuild of a REFERENCED table run", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, migrations);
    seed(db);

    expect(() =>
      migrate(db, [
        ...migrations,
        rebuildEnvironments(`
          CREATE TABLE environments_new (
            id TEXT PRIMARY KEY,
            timezone TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          INSERT INTO environments_new SELECT id, timezone, created_at, updated_at FROM environments;
          DROP TABLE environments;
          ALTER TABLE environments_new RENAME TO environments;
        `),
      ]),
    ).not.toThrow();

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM environments").get() as { n: number }).n,
    ).toBe(1);
    // The caller's setting is restored, not left off for the rest of the process.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  /**
   * Off during, checked after — and the check is over the WHOLE database, so it
   * catches a dangling reference per-statement enforcement would have missed
   * entirely (the row it dangles is one no migration touched).
   */
  it("refuses to commit a rebuild that leaves a dangling reference", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, migrations);
    seed(db);

    expect(() =>
      migrate(db, [
        ...migrations,
        rebuildEnvironments(`
          CREATE TABLE environments_new (
            id TEXT PRIMARY KEY,
            timezone TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          DROP TABLE environments;
          ALTER TABLE environments_new RENAME TO environments;
        `),
      ]),
    ).toThrow(/dangling foreign key reference\(s\): workspaces -> environments/);

    // Fails closed: nothing recorded, nothing dropped.
    expect(
      (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v,
    ).toBe(8);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM environments").get() as { n: number }).n,
    ).toBe(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("leaves foreign keys off if the caller had them off", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    migrate(db, migrations);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
    db.close();
  });
});

/**
 * F5 — every freeze test in this repository asserted about the SQL FILE, and
 * none about the `Migration` the runner actually executes.
 *
 * `checkpoint-delivery-migrations.test.ts` reads `0008_…​.sql` and `db.exec`s
 * the text; `migrate.test.ts` regex-matched the same text; the checksum is a
 * hash of the file's bytes, which binds the LEDGER to the file but never binds
 * the `up` CLOSURE to anything. So both of these survived all 73 tests:
 *
 *   up: (db) => { db.exec(text); if (version === 8) db.exec("CREATE TABLE evil (x);"); }
 *   up: (db) => { db.exec(text); if (version === 8) db.exec("DROP INDEX checkpoints_undelivered_idx"); }
 *
 * The second is the dangerous one: it is invisible in every result the suite
 * checks and silently degrades the reconciliation sweep to a full table scan on
 * every pass.
 *
 * The unit under test below is therefore the closure, never the file.
 */
describe("F5: the migrations the runner executes, not the files they were read from", () => {
  /** Everything SQLite records about the schema, in a stable order. */
  function schemaOf(db: Database.Database): { type: string; name: string; sql: string | null }[] {
    return db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%'
            AND name NOT IN ('schema_migrations', 'schema_migrations_meta')
          ORDER BY type, name`,
      )
      .all() as { type: string; name: string; sql: string | null }[];
  }

  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

  /**
   * The whole registry, bound. Executing every `up` in order must leave exactly
   * the schema that executing the SQL FILES in order leaves — no extra object,
   * none missing, and not one differing definition. A closure that does
   * anything its file does not say diverges here whatever it is, which is
   * strictly more than enumerating the statements a reviewer thought of.
   */
  it("leaves exactly the schema the SQL files leave, object for object", () => {
    const viaRunner = new Database(":memory:");
    migrate(viaRunner, migrations);

    const viaFiles = new Database(":memory:");
    // The runner creates the ledger before any migration runs, and at least one
    // migration file refers to it; this stands in for that, and is excluded from
    // the comparison below either way.
    viaFiles.exec(
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL,
                                       applied_at INTEGER NOT NULL, checksum TEXT);`,
    );
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      viaFiles.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }

    expect(schemaOf(viaRunner)).toEqual(schemaOf(viaFiles));
    // And the schema is not trivially empty, so an accident that returns [] on
    // both sides cannot pass this.
    expect(schemaOf(viaRunner).length).toBeGreaterThan(10);
    viaRunner.close();
    viaFiles.close();
  });

  /**
   * The reconciliation sweep's index, named explicitly. `DROP INDEX` inside an
   * `up` changes no row, no ledger entry and no query RESULT — only the plan —
   * so nothing that asserts on outcomes can see it. This asserts the index is
   * there and that the sweep's own predicate uses it.
   */
  it("keeps the index the reconciliation sweep depends on, and uses it", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);

    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("checkpoints_undelivered_idx") as { sql: string } | undefined;
    expect(index).toBeDefined();

    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM checkpoints WHERE signalled_at IS NULL AND status != 'pending'",
      )
      .all()
      .map((row) => (row as { detail: string }).detail)
      .join(" ");
    expect(plan).toContain("checkpoints_undelivered_idx");
    // A bare `SCAN checkpoints` with no index behind it is the degradation the
    // dropped-index mutant produces; `SCAN … USING INDEX` is the healthy plan.
    expect(plan).not.toMatch(/SCAN checkpoints(?! USING)/);
    db.close();
  });

  /**
   * 0008 itself, as the runner holds it: the tombstone's `up` re-executed
   * against a fully migrated database must change no schema object, no ledger
   * row and no delivery latch. Twice, because "inert" is not "inert once".
   */
  it("frozen 0008's own `up` changes nothing when executed", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    db.prepare(
      "INSERT INTO environments (id, timezone, created_at, updated_at) VALUES ('env', 'UTC', 0, 0)",
    ).run();
    db.prepare(
      `INSERT INTO workspaces (id, environment_id, kind, display_name, status, policy_json,
                               version, created_at, updated_at)
       VALUES ('ws', 'env', 'execution', 'ws', 'active', '{}', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, origin, pipeline, title, intent_json, status,
                          temporal_workflow_id, version, created_at, updated_at)
       VALUES ('t1', 'ws', 'cli', 'coding', 't', '{}', 'needs_attention', 'task/t1', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO checkpoints (id, task_id, kind, status, prompt, choices_json, answer_json,
                                version, created_at, answered_at, signalled_at, signalled_by)
       VALUES ('cp-1', 't1', 'limit-exceeded', 'answered', 'p', '[]', '{}', 2, 0, 1, 1, 'backfill')`,
    ).run();

    const eight = migrations.find((m) => m.version === 8);
    expect(eight).toBeDefined();
    const schemaBefore = schemaOf(db);
    const latchBefore = db
      .prepare("SELECT id, signalled_at, signalled_by FROM checkpoints ORDER BY id")
      .all();
    const changesBefore = db.prepare("SELECT total_changes() AS n").get();

    eight?.up(db);
    eight?.up(db);

    expect(schemaOf(db)).toEqual(schemaBefore);
    expect(
      db.prepare("SELECT id, signalled_at, signalled_by FROM checkpoints ORDER BY id").all(),
    ).toEqual(latchBefore);
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changesBefore);
    db.close();
  });

  /**
   * And the freeze is a property of the migration OBJECT, not of a file that
   * happens to sit next to it: the checksum the runner records must be the hash
   * of the identity tuple over the file 0008 names. If a build ever computed
   * the hash from something other than what `up` runs, this is where it shows.
   */
  it("records 0008 under the hash of the file its `up` was built from", () => {
    const eight = migrations.find((m) => m.version === 8);
    const text = readFileSync(join(migrationsDir, "0008_checkpoint_backfill_repair.sql"), "utf8");
    expect(eight?.checksum).toBe(migrationChecksum(8, "checkpoint_backfill_repair", text));
  });
});

/**
 * F6 — the erased-checksum watermark was a one-line self-service amnesty, and
 * it failed OPEN on garbage.
 *
 *  - It lived in `schema_migrations_meta`, inside the database it protects, and
 *    was RECOMPUTED from that same database whenever the table was missing.
 *    `DROP COLUMN checksum` alone is correctly refused; add
 *    `DROP TABLE schema_migrations_meta` and the next boot re-added the column
 *    all-NULL, recomputed the boundary at the top of the ledger, and booted
 *    clean — every recorded hash forgotten, with the ledger now asserting the
 *    amnesty was legitimate. Two statements, both of which read like tidying up.
 *  - `Number(existing.value)` made `Number("oops")` NaN, and `row.version > NaN`
 *    is false for EVERY row, so one `UPDATE` disabled the entire check while the
 *    meta row still looked plausible.
 *
 * The fix is not a better hiding place — anyone who can run two statements can
 * run three — it is removing the circularity. The boundary is capped at a fact
 * this BUILD knows: version 8 shipped with a recorded hash, so no database can
 * have reached it without a checksumming runner, and a claim otherwise is
 * refused whether it was recomputed or written by hand.
 */
describe("F6: the pre-checksum watermark", () => {
  /** The two statements that used to buy a clean boot with no checksums at all. */
  function forgetEveryChecksum(db: Database.Database): void {
    db.exec("ALTER TABLE schema_migrations DROP COLUMN checksum");
    db.exec("DROP TABLE schema_migrations_meta");
  }

  it("refuses the two-statement amnesty that used to boot clean", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    forgetEveryChecksum(db);

    expect(() => migrate(db, migrations)).toThrow(
      /claims migrations up to version 8 were applied before checksums existed/,
    );
    // And it is still refused on the next boot: nothing was quietly recorded
    // that would make the second attempt succeed.
    expect(() => migrate(db, migrations)).toThrow(/before checksums existed/);
    db.close();
  });

  it("refuses a watermark written by hand above the pre-checksum era", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    db.exec("ALTER TABLE schema_migrations DROP COLUMN checksum");
    db.prepare("UPDATE schema_migrations_meta SET value = '8' WHERE key = ?").run(
      "pre_checksum_max_version",
    );

    expect(() => migrate(db, migrations)).toThrow(
      /claims migrations up to version 8 were applied before checksums existed/,
    );
    db.close();
  });

  /**
   * The NaN hole, on its own. `Number("oops")` is NaN and every `>` against it
   * is false, so this single UPDATE used to turn the erased-checksum check off
   * for the whole ledger while leaving a meta row that reads as ordinary.
   */
  it("refuses a watermark that is not a number instead of reading it as no boundary", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    db.prepare("UPDATE schema_migrations_meta SET value = 'oops' WHERE key = ?").run(
      "pre_checksum_max_version",
    );

    expect(() => migrate(db, migrations)).toThrow(/is "oops", which is not a version number/);
    // And with the garbage watermark in place an erased checksum is still not
    // waved through — the failure is not merely cosmetic.
    db.exec("ALTER TABLE schema_migrations DROP COLUMN checksum");
    expect(() => migrate(db, migrations)).toThrow(/is "oops", which is not a version number/);
    db.close();
  });

  it("still refuses a dropped checksum column on its own", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    db.exec("ALTER TABLE schema_migrations DROP COLUMN checksum");

    expect(() => migrate(db, migrations)).toThrow(
      /migration 1 has no recorded checksum, but this database was first seen by a checksumming runner at version 0/,
    );
    db.close();
  });

  /**
   * The legitimate case this must keep working: a database applied before
   * checksums existed at all. Its NULLs are historical, its boundary is the top
   * of what it had — which is inside the era — and everything applied afterwards
   * is verified normally.
   */
  it("adopts a genuinely pre-checksum database once, and holds the line after", () => {
    const db = new Database(":memory:");
    migrate(db, migrations.slice(0, 4));
    db.prepare("UPDATE schema_migrations SET checksum = NULL").run();
    db.exec("DROP TABLE schema_migrations_meta");

    expect(() => migrate(db, migrations)).not.toThrow();
    expect(
      (
        db
          .prepare("SELECT value AS v FROM schema_migrations_meta WHERE key = ?")
          .get("pre_checksum_max_version") as { v: string }
      ).v,
    ).toBe("4");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE checksum IS NOT NULL").get() as {
        n: number;
      }).n,
    ).toBe(4);

    // And erasing one of the checksums it recorded AFTER adoption is refused.
    db.prepare("UPDATE schema_migrations SET checksum = NULL WHERE version = 8").run();
    expect(() => migrate(db, migrations)).toThrow(
      /migration 8 has no recorded checksum, but this database was first seen by a checksumming runner at version 4/,
    );
    db.close();
  });

  /**
   * The boundary of the boundary: 7 is inside the pre-checksum era and 8 is not,
   * and that is a claim about release history rather than about any database, so
   * it is asserted directly.
   */
  it("caps the era at the last version that shipped without a hash", () => {
    const inside = new Database(":memory:");
    migrate(inside, migrations.slice(0, 7));
    inside.prepare("UPDATE schema_migrations SET checksum = NULL").run();
    inside.exec("DROP TABLE schema_migrations_meta");
    expect(() => migrate(inside, migrations)).not.toThrow();
    inside.close();

    const outside = new Database(":memory:");
    migrate(outside, migrations);
    outside.prepare("UPDATE schema_migrations SET checksum = NULL").run();
    outside.exec("DROP TABLE schema_migrations_meta");
    expect(() => migrate(outside, migrations)).toThrow(/before checksums existed/);
    outside.close();
  });
});
