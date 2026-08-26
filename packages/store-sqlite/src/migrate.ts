import { createHash } from "node:crypto";
import type { MeidoyaDatabase } from "./db.js";

export type Migration = {
  /** Monotonically increasing, e.g. 1, 2, 3. */
  version: number;
  name: string;
  /**
   * Content hash of this migration's IDENTITY — `version|name|sql` — recorded
   * in the ledger on apply and re-checked on every later boot, so editing the
   * SQL *or the recorded name* of an already-applied migration can never again
   * be invisible. See `verifyChecksums`.
   *
   * Optional only so a caller can hand-build a `Migration` in a test; the real
   * registry always supplies one via `migrationChecksum`.
   */
  checksum?: string;
  /**
   * The hash this migration was recorded under by the FIRST checksumming
   * runner, which hashed the SQL alone and left the name — the field 0008 keyed
   * its verdict on — unprotected. A ledger row carrying this value was written
   * by that runner; it is accepted for an already-applied row (the SQL it
   * attests to is unchanged) and the name is verified separately, so nothing is
   * exempted. New rows are always written with `checksum`.
   */
  legacyChecksum?: string;
  /**
   * Hashes this migration was RELEASED under before it was withdrawn to a
   * tombstone. Listed as explicit literals at the call site with a written
   * justification, never derived: the only thing that makes emptying a released
   * migration legitimate is that a database which recorded it will never re-run
   * it, and saying so out loud per hash is the point. Accepted for an
   * already-applied row only; any hash not on the list still fails the boot.
   */
  supersededChecksums?: readonly string[];
  up: (db: MeidoyaDatabase) => void;
};

/** Hash of a migration's identity tuple: version, ledger name, and SQL. */
export function migrationChecksum(version: number, name: string, sql: string): string {
  return `sha256v2:${createHash("sha256").update(`${String(version)}|${name}|${sql}`).digest("hex")}`;
}

/**
 * The first checksum format: the SQL alone. Retained only so a row written by
 * that runner can be recognised for what it is rather than mistaken for an
 * edit. Never written.
 */
export function legacyMigrationChecksum(sql: string): string {
  return `sha256:${createHash("sha256").update(sql).digest("hex")}`;
}

/** Ledger bookkeeping that is the runner's own, not a numbered migration. */
const META_TABLE = "schema_migrations_meta";
const PRE_CHECKSUM_WATERMARK = "pre_checksum_max_version";

/**
 * Message a checksum mismatch fails with. Deliberately a plain `Error`: this
 * aborts a local boot before any workflow exists, so it never crosses a
 * Temporal activity boundary, and a new `Error` subclass would have to be
 * classified in the refusal registry for a retry question that cannot arise.
 */
export function migrationChecksumMismatchMessage(
  version: number,
  recordedName: string,
  recordedChecksum: string,
  currentChecksum: string,
): string {
  return (
    `migration ${String(version)} (${recordedName}) was applied from different SQL than this build carries: ` +
    `recorded ${recordedChecksum}, current ${currentChecksum}. ` +
    `An already-applied migration was edited in place; a migration must never be changed after release.`
  );
}

/**
 * Message a ledger NAME mismatch fails with. Its own message because its own
 * defect: 0005's SQL was corrected in one commit and its ledger name changed in
 * another, so a database could carry the corrected SQL under the old name, and
 * 0008 read the name as if it were a record of which SQL had run.
 */
export function migrationNameMismatchMessage(
  version: number,
  recordedName: string,
  currentName: string,
): string {
  return (
    `migration ${String(version)} was applied under the ledger name ${recordedName}, ` +
    `but this build calls it ${currentName}. The recorded name is evidence about which SQL ran; ` +
    `renaming a released migration destroys that evidence and must never happen.`
  );
}

/** Message the "a ledger row went missing" check fails with. */
export function migrationMissingRowMessage(version: number, maxRecorded: number): string {
  return (
    `migration ledger is not contiguous: version ${String(version)} is not recorded, ` +
    `but version ${String(maxRecorded)} is. The runner applies everything above MAX(version), so a ` +
    `deleted row silently skips a migration forever. Restore the ledger or recreate the database.`
  );
}

/** Message the downgrade guard fails with. */
export function migrationDowngradeMessage(maxRecorded: number, maxKnown: number): string {
  return (
    `database schema version ${String(maxRecorded)} is newer than this build, which carries ` +
    `${String(maxKnown)} migrations. Running an older build against a newer schema reads and writes ` +
    `a shape it does not know; refusing to start.`
  );
}

/** Message the post-migration referential integrity check fails with. */
export function migrationForeignKeyViolationMessage(
  violations: { table: string; parent: string }[],
): string {
  const detail = violations
    .slice(0, 5)
    .map((v) => `${v.table} -> ${v.parent}`)
    .join(", ");
  return (
    `migrations left ${String(violations.length)} dangling foreign key reference(s): ${detail}. ` +
    `Foreign keys are enforced over the WHOLE database once the migrations have run, not per ` +
    `statement while they run; nothing has been committed.`
  );
}

/** Message the "a NULL checksum appeared above the watermark" check fails with. */
export function migrationChecksumErasedMessage(version: number, watermark: number): string {
  return (
    `migration ${String(version)} has no recorded checksum, but this database was first seen by a ` +
    `checksumming runner at version ${String(watermark)}, so version ${String(version)} was applied WITH one. ` +
    `The checksum column has been dropped or cleared, which erases the only record of what was applied.`
  );
}

/**
 * Adds the `checksum` column to an existing ledger. `CREATE TABLE IF NOT
 * EXISTS` cannot do this for a database that already has the table, and this
 * table is the runner's own bookkeeping rather than a numbered migration, so it
 * is widened here.
 */
function ensureChecksumColumn(db: MeidoyaDatabase): void {
  const columns = db.prepare("PRAGMA table_info(schema_migrations)").all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === "checksum")) {
    db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
  }
}

/**
 * The highest version that could POSSIBLY have been applied by a runner with no
 * checksum column, stated as a literal fact about this project's release
 * history rather than derived from the database.
 *
 * Migration 0008 shipped WITH a recorded hash — the registry names that hash as
 * a `supersededChecksums` literal, which is only meaningful because databases
 * out there hold it — so no database can have reached version 8 without a
 * checksumming runner having written to it. Everything at or below 7 is
 * genuinely ambiguous: 0006's own file records that "every database that
 * recorded it holds a NULL checksum".
 *
 * This is what makes the exemption finite. Raising it requires the same kind of
 * written justification the superseded hashes carry; it must never be derived
 * from what a database happens to contain, because that is precisely the
 * circularity F6 exploited.
 */
const PRE_CHECKSUM_ERA_MAX_VERSION = 7;

/** Message an unparseable watermark fails with. */
export function migrationWatermarkUnreadableMessage(recorded: string): string {
  return (
    `the pre-checksum watermark recorded in ${META_TABLE} is ${JSON.stringify(recorded)}, which is ` +
    `not a version number. The watermark decides which missing checksums are historical and which ` +
    `are erased; a value that cannot be read cannot make that decision, and treating it as "no ` +
    `boundary" would turn the erased-checksum check off entirely. Refusing to start.`
  );
}

/** Message a watermark above the pre-checksum era fails with. */
export function migrationWatermarkImpossibleMessage(watermark: number): string {
  return (
    `this database claims migrations up to version ${String(watermark)} were applied before checksums ` +
    `existed, but version ${String(PRE_CHECKSUM_ERA_MAX_VERSION + 1)} shipped WITH a recorded hash, so nothing above ` +
    `${String(PRE_CHECKSUM_ERA_MAX_VERSION)} can ever have been applied without one. Either the checksum column was dropped ` +
    `and ${META_TABLE} deleted so the boundary would be recomputed at the top of the ledger — which ` +
    `is how every recorded hash gets forgotten in two statements — or the watermark was written by ` +
    `hand. Restore the ledger from a backup or recreate the database.`
  );
}

/**
 * The highest version this database is allowed to hold a NULL checksum for,
 * decided ONCE — the first time a checksumming runner ever opens it — and
 * remembered thereafter.
 *
 * "NULL means unknown, so skip it" was a permanent, self-service exemption:
 * `ALTER TABLE schema_migrations DROP COLUMN checksum` made `ensureChecksumColumn`
 * re-add it all-NULL and the runner forgot every hash it had ever recorded.
 * Recording the watermark turns "unknown" into a fact with a boundary: rows at
 * or below it were genuinely applied before any hash existed and cannot be
 * verified; a NULL above it is not unknown, it is ERASED, and that is loud.
 *
 * F6: recording that boundary in a table INSIDE the database it protects, and
 * recomputing it from that same database whenever the table was missing, made
 * the whole thing self-service. `DROP COLUMN checksum` alone is correctly
 * refused; add `DROP TABLE schema_migrations_meta` and the next boot re-added
 * the column all-NULL, recomputed the boundary at the TOP of the ledger, and
 * booted clean — with the ledger now asserting that the amnesty had been
 * legitimate. Two statements, both of which read like tidying up.
 *
 * Storing the boundary somewhere else in the file does not fix that, because
 * anyone who can run those two statements can run a third. What fixes it is
 * removing the circularity: the boundary is no longer allowed to be whatever
 * the database says it is. It is CAPPED at a fact this build knows independently
 * — `PRE_CHECKSUM_ERA_MAX_VERSION`, the last version that can have been applied
 * by a runner with no checksums — and a value above the cap is refused whether
 * it was recomputed or written by hand.
 *
 * What that leaves an operator who wants the amnesty anyway: drop the column,
 * write a watermark of 7 by hand, and DELETE the version-8 ledger row so the
 * recomputation is even permitted. Three statements, one of which destroys a
 * ledger row and causes migration 8 to be applied again. That is no longer a
 * tidy-up that happens to have this effect; it is a decision. Which is the most
 * a runner can achieve against someone who may write the file arbitrarily, and
 * saying so is better than implying otherwise.
 */
function preChecksumWatermark(db: MeidoyaDatabase): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  );
  const row = db
    .prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`)
    .get(PRE_CHECKSUM_WATERMARK) as { value: string } | undefined;

  if (row !== undefined) {
    // Strictly, not `Number()`. `Number("oops")` is NaN and `row.version > NaN`
    // is false for EVERY row, so one `UPDATE schema_migrations_meta SET value =
    // 'oops'` turned the erased-checksum check off across the whole ledger while
    // leaving a meta row that still read as ordinary.
    if (!/^\d+$/.test(row.value.trim())) {
      throw new Error(migrationWatermarkUnreadableMessage(row.value));
    }
    const recorded = Number(row.value.trim());
    if (recorded > PRE_CHECKSUM_ERA_MAX_VERSION) {
      throw new Error(migrationWatermarkImpossibleMessage(recorded));
    }
    return recorded;
  }

  const observed =
    (
      db
        .prepare("SELECT MAX(version) AS v FROM schema_migrations WHERE checksum IS NULL")
        .get() as { v: number | null }
    ).v ?? 0;
  if (observed > PRE_CHECKSUM_ERA_MAX_VERSION) {
    throw new Error(migrationWatermarkImpossibleMessage(observed));
  }
  db.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`).run(
    PRE_CHECKSUM_WATERMARK,
    String(observed),
  );
  return observed;
}

/**
 * Fails closed if the ledger and this build disagree about what was applied.
 *
 * This exists because it has bitten twice: 0005's SQL was corrected in place
 * while its recorded name stayed the same, and because the ledger tracked only
 * `MAX(version)` the edit left no trace at all — databases provisioned across
 * that window are indistinguishable from ones that ran the older SQL, and a
 * later repair migration fenced on the name mis-classified them.
 *
 * Four things are checked, because the first version of this guard checked one
 * and each of the other three was a way around it:
 *
 *   1. the SQL hash of every checksummed row;
 *   2. the recorded NAME of every checksummed row — the field the mis-fence
 *      actually read, and the one the first hash left out entirely;
 *   3. that no NULL checksum appears above the pre-checksum watermark, so
 *      dropping the column is an error rather than an amnesty;
 *   4. that versions 1..MAX are all present, so deleting a row below the top
 *      cannot silently skip a migration forever.
 */
function verifyChecksums(db: MeidoyaDatabase, migrations: Migration[], watermark: number): void {
  const applied = db
    .prepare("SELECT version, name, checksum FROM schema_migrations")
    .all() as { version: number; name: string; checksum: string | null }[];
  const byVersion = new Map(migrations.map((m) => [m.version, m]));

  for (const row of applied) {
    if (row.checksum === null) {
      if (row.version > watermark) {
        throw new Error(migrationChecksumErasedMessage(row.version, watermark));
      }
      continue;
    }
    const migration = byVersion.get(row.version);
    if (migration === undefined) continue;
    if (migration.name !== row.name) {
      throw new Error(migrationNameMismatchMessage(row.version, row.name, migration.name));
    }
    if (migration.checksum === undefined) continue;
    if (row.checksum === migration.checksum) continue;
    if (migration.legacyChecksum !== undefined && row.checksum === migration.legacyChecksum) {
      continue;
    }
    if (migration.supersededChecksums?.includes(row.checksum) === true) continue;
    throw new Error(
      migrationChecksumMismatchMessage(
        row.version,
        row.name,
        row.checksum,
        migration.checksum,
      ),
    );
  }

  const recorded = new Set(applied.map((r) => r.version));
  const maxRecorded = applied.reduce((max, r) => Math.max(max, r.version), 0);
  for (let version = 1; version <= maxRecorded; version += 1) {
    if (!recorded.has(version)) {
      throw new Error(migrationMissingRowMessage(version, maxRecorded));
    }
  }

  const maxKnown = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  if (maxRecorded > maxKnown) {
    throw new Error(migrationDowngradeMessage(maxRecorded, maxKnown));
  }
}

/**
 * Applies all migrations with version > current schema_version, in ascending
 * order, inside ONE `BEGIN IMMEDIATE` transaction.
 *
 * Immediate, and covering the version read, because deferred was a race: two
 * daemons booting on one database both read `MAX(version)` under a shared lock,
 * both computed the same pending list, and the losers then died — re-applying a
 * migration (`table environments already exists`, `duplicate column name`) or,
 * on an upgrade, `database is locked`, because a deferred transaction that has
 * already read cannot wait for the write lock without risking deadlock, so
 * SQLite refuses to run the busy handler at all. It fails CLOSED either way,
 * but on an error that says nothing true about what happened, and under a
 * supervisor that is a boot loop with a misleading log line. Taking the write
 * lock BEFORE the read makes the loser wait, re-read a ledger that is now
 * current, and find nothing to do. Reproduced with ten barrier-synchronised
 * processes; see `migrate-concurrency.test.ts`.
 *
 * One transaction for the whole run, rather than one per migration, so a
 * failure half-way leaves the database exactly where it started instead of at
 * an intermediate version no build corresponds to.
 *
 * FOREIGN KEYS. `PRAGMA foreign_keys` is SILENTLY IGNORED inside a
 * transaction, and a migration cannot escape one, so a migration that sets it
 * gets no error and no effect — verified. SQLite's 12-step table rebuild needs
 * enforcement genuinely off, and `defer_foreign_keys` is NOT a substitute: it
 * defers the CHECK, but `DROP TABLE` bumps the deferred violation counter and
 * nothing ever decrements it, so rebuilding a table that others reference fails
 * at COMMIT regardless (verified too).
 *
 * So enforcement is turned off HERE, outside the transaction, where the pragma
 * works, and the whole database is checked with `PRAGMA foreign_key_check`
 * before the transaction commits. That is strictly stronger than per-statement
 * enforcement for this job: per-statement checks only the rows a migration
 * touched, this checks the state it leaves behind. The caller's setting is
 * restored either way.
 */
export function migrate(db: MeidoyaDatabase, migrations: Migration[]): void {
  const enforcedBefore = db.pragma("foreign_keys", { simple: true }) === 1;
  if (enforcedBefore) db.pragma("foreign_keys = OFF");
  try {
    migrateWithForeignKeysOff(db, migrations);
  } finally {
    if (enforcedBefore) db.pragma("foreign_keys = ON");
  }
}

function migrateWithForeignKeysOff(db: MeidoyaDatabase, migrations: Migration[]): void {
  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT
      );
    `);
    ensureChecksumColumn(db);
    const watermark = preChecksumWatermark(db);
    verifyChecksums(db, migrations, watermark);

    const currentVersion =
      (
        db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
          v: number | null;
        }
      ).v ?? 0;

    const pending = [...migrations]
      .filter((m) => m.version > currentVersion)
      .sort((a, b) => a.version - b.version);

    const record = db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, unixepoch(), ?)",
    );
    for (const migration of pending) {
      migration.up(db);
      record.run(migration.version, migration.name, migration.checksum ?? null);
    }

    if (pending.length > 0) {
      const violations = db.prepare("PRAGMA foreign_key_check").all() as {
        table: string;
        parent: string;
      }[];
      if (violations.length > 0) {
        throw new Error(migrationForeignKeyViolationMessage(violations));
      }
    }
  });
  run.immediate();
}
