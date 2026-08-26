import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { legacyMigrationChecksum, migrationChecksum, type Migration } from "../migrate.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A migration backed by one SQL file, carrying the hash of its identity —
 * version, ledger name and file bytes — so the runner can detect an
 * already-applied migration being edited OR renamed in place. Reading and
 * hashing here (rather than inside `up`) means the checksum is over exactly the
 * bytes `up` will execute.
 *
 * `legacyChecksum` is the hash the first checksumming runner would have
 * recorded for the same bytes: SQL only, name unprotected. A ledger row holding
 * it was written by that runner and is accepted as-is; the name is verified
 * separately, so covering the name loses nothing for those databases.
 */
function fileMigration(
  version: number,
  name: string,
  file: string,
  superseded: readonly string[] = [],
): Migration {
  const text = readFileSync(join(here, file), "utf8");
  return {
    version,
    name,
    checksum: migrationChecksum(version, name, text),
    legacyChecksum: legacyMigrationChecksum(text),
    ...(superseded.length === 0 ? {} : { supersededChecksums: superseded }),
    up: (db) => db.exec(text),
  };
}

export const migrations: Migration[] = [
  fileMigration(1, "initial_schema", "0001_initial_schema.sql"),
  fileMigration(2, "indexes", "0002_indexes.sql"),
  fileMigration(3, "binding_epochs", "0003_binding_epochs.sql"),
  fileMigration(4, "outbox_lease", "0004_outbox_lease.sql"),
  // NOT `checkpoint_delivery`: that name belongs to the ORIGINAL 0005, whose
  // backfill put rows in the wrong bucket. The two are worth keeping apart in
  // the ledger, but the name is NOT evidence of which SQL ran — the SQL was
  // corrected one commit BEFORE this rename, so every database provisioned in
  // that window recorded `checkpoint_delivery` for the CORRECTED SQL. 0008 read
  // it as evidence anyway; it is now frozen. Nothing may fence on this name.
  fileMigration(5, "checkpoint_delivery_scoped", "0005_checkpoint_delivery.sql"),
  // Withdrawn; see the file. Kept as an empty tombstone so the ledger stays
  // contiguous and the history stays readable. Emptied at a release that
  // predates checksums entirely, so no released hash of its old text exists to
  // supersede: every database that recorded it holds a NULL checksum.
  fileMigration(
    6,
    "checkpoint_delivery_backfill_repair",
    "0006_checkpoint_delivery_backfill_repair.sql",
  ),
  fileMigration(7, "checkpoint_signal_provenance", "0007_checkpoint_signal_provenance.sql"),
  // FROZEN to a tombstone; see the file for why a migration must not decide
  // this. The one hash below is the SQL-only checksum the previous release
  // recorded for 0008's repair statements. Accepting it is sound for exactly
  // one reason, and it is a fact about the runner rather than about the SQL: a
  // database holding it has version 8 in its ledger and therefore will NEVER
  // execute this file again, so what the file now contains cannot change its
  // behaviour by so much as a row. It is listed as a literal, for this version
  // alone, so that emptying a released migration stays a deliberate, reviewed
  // act rather than something the hash function can be talked into.
  fileMigration(8, "checkpoint_backfill_repair", "0008_checkpoint_backfill_repair.sql", [
    "sha256:48c215781485b26a79c576dec017bdc54787af94b0c0d8b7879c89ab59810531",
  ]),
];
