import Database from "better-sqlite3";

export type MeidoyaDatabase = Database.Database;

/**
 * Opens the business SQLite database with the PRAGMAs required by
 * 08-temporal-and-sqlite.md section 8 (WAL, foreign keys, busy timeout).
 */
const BUSY_TIMEOUT_MS = 5000;

/** Synchronous sleep. `Atomics.wait` is the only one available on this thread. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Switches the file to WAL, retrying while another process is doing the same.
 *
 * `busy_timeout` does NOT cover this: changing `journal_mode` needs a brief
 * exclusive lock and SQLite does not run the busy handler for it, so the pragma
 * throws `SQLITE_BUSY` immediately. Ten processes opening one BRAND NEW file on
 * a barrier reproduces it every few runs, and the daemon dies on boot with
 * `database is locked` — an error about nothing the operator can act on.
 *
 * The race is only ever the FIRST conversion: once any process has done it, the
 * file is already WAL and the pragma is a lock-free no-op, so a short retry loop
 * closes it completely rather than papering over it.
 */
function enableWalMode(db: MeidoyaDatabase): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      const mode = db.pragma("journal_mode = WAL", { simple: true });
      // `memory` is an in-memory database, which has no WAL and never will;
      // that is a legitimate final answer rather than a lost race.
      if (mode === "wal" || mode === "memory") return;
      throw new Error(
        `SQLite refused to switch the database to WAL journal mode (it is ${String(mode)})`,
      );
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      sleepSync(5);
    }
  }
}

export function openDatabase(path: string): MeidoyaDatabase {
  const db = new Database(path);
  // `busy_timeout` first: everything after it, and every statement the caller
  // runs, should wait for a competing writer rather than fail instantly.
  db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  enableWalMode(db);
  db.pragma("foreign_keys = ON");
  return db;
}

/** Message a missing or unopenable admin database fails with. */
export function adminDatabaseMissingMessage(path: string, detail: string): string {
  return (
    `cannot open ${path}: ${detail}. --db must name an EXISTING database file — ` +
    `control_plane.sqlite.path from the daemon's config. An admin command never creates one, ` +
    `because the only thing a typo could produce is a brand new empty database that reports ` +
    `nothing wrong.`
  );
}

/**
 * Opens an existing database for an OPERATOR command, and touches nothing it
 * was not asked to.
 *
 * `openDatabase` is the DAEMON's opener and is right to do what it does: it
 * creates the file if it is absent, because booting is when the database comes
 * into existence, and it converts the file to WAL, because that is the mode the
 * daemon requires. Both are wrong for an admin command:
 *
 *   - `meidoya admin latch list --db /tmp/typo.sqlite` created
 *     `/tmp/typo.sqlite` and reported "no resolved checkpoints under a parked
 *     task" — a clean bill of health for a database that had just been invented.
 *   - Pointed at ANY other SQLite file — someone else's, a backup, a copy being
 *     archived — the WAL conversion happened before a single row was read, and
 *     `journal_mode` is persistent, so a read-only-looking command permanently
 *     changed a file it had no business writing to at all.
 *
 * So: the file must already exist, `list` and a dry-run `release` open it
 * genuinely read-only, and even the writing path leaves `journal_mode` exactly
 * as it found it.
 */
export function openDatabaseForAdmin(path: string, mode: "read" | "write"): MeidoyaDatabase {
  let db: MeidoyaDatabase;
  try {
    db = new Database(path, mode === "read" ? { readonly: true, fileMustExist: true } : { fileMustExist: true });
  } catch (error) {
    throw new Error(adminDatabaseMissingMessage(path, error instanceof Error ? error.message : String(error)));
  }
  db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  if (mode === "write") db.pragma("foreign_keys = ON");
  return db;
}
