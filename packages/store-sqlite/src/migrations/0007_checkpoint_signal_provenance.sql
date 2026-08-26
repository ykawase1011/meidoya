-- 0007: record WHY a checkpoint is latched, so no future repair has to guess.
--
-- The withdrawn 0006 had to infer "was this latch written by a migration or by
-- the running code?" from the data, and its first attempt (`signalled_at =
-- COALESCE(answered_at, created_at)`) was wrong: `resolveCheckpoint` and
-- `markCheckpointSignalled` run a few in-process operations apart and land on
-- the same millisecond routinely. Its second attempt derived the answer from
-- the migration ledger, which is exact about WHEN the latch was written but
-- still says nothing about WHY — and pairing it with the task's status at
-- repair time is what made 0006 re-open delivered answers. This column makes
-- the why a stored fact, and the repair moved to 0008 so it can read it:
--
--   'backfill'  — a migration inferred the latch. Never observed.
--   'signal'    — `markCheckpointSignalled` ran because the signal landed.
--   'discarded' — the reconciliation sweep gave up on a workflow it corroborated
--                 as gone. The answer was NOT delivered; this is the auditable
--                 record behind the `CheckpointAnswerDiscarded` event.
--
-- NULL means the row predates any of the above, or is not latched at all.
--
-- Why a new migration rather than editing 0005/0006 to write the column: both
-- have already been recorded in developer databases and will never re-run, so a
-- column added there would exist only in databases created afterwards. Added
-- here it lands unconditionally, on every database, at one uniform version, and
-- needs no conditional DDL.
--
-- (0006 was emptied in place rather than corrected in place. A database at
-- version >= 6 will never re-run it, so emptying it cannot disturb one, and a
-- later migration cannot undo its damage there either — the wrong predicate
-- destroyed the very bit that told the two cases apart. Emptying it is what
-- helps the databases that have not reached version 6 yet, which are exactly
-- the databases it would still run on; 0008 does the repair properly.)

ALTER TABLE checkpoints ADD COLUMN signalled_by TEXT;

-- Classify what is already latched, using the same ledger boundary 0008 uses:
-- `signalled_at` did not exist before 0005 was applied, so any latch at or
-- after that instant was necessarily written by code, and anything before it
-- was written by the 0005 backfill. `applied_at` is `unixepoch()` seconds
-- truncated DOWN, so the boundary sits at or before the true apply instant and
-- no code-written row can fall below it.
--
-- A pre-boundary latch is therefore `'backfill'`, exactly. A post-boundary one
-- is NOT `'signal'`: until this column existed the give-up path in
-- `reconcileCheckpointDeliveries` called `markCheckpointSignalled(id)` with no
-- provenance too, so a database from that release holds post-boundary latches
-- for answers that were THROWN AWAY. Writing 'signal' over those would convert
-- the record of a LOST human answer into a record of successful delivery —
-- the single worst value this column can hold. They are left NULL, which
-- already means "predates any of the above": unknown, and readable as unknown.
-- A missing version-5 row makes the comparison NULL and everything falls
-- through to NULL, which claims nothing at all.
UPDATE checkpoints
   SET signalled_by = CASE
         WHEN signalled_at < (SELECT applied_at FROM schema_migrations WHERE version = 5) * 1000
           THEN 'backfill'
         ELSE NULL
       END
 WHERE signalled_at IS NOT NULL;
