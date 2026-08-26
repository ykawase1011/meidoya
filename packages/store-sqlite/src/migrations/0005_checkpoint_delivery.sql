-- 0005: make a committed checkpoint answer recoverable.
--
-- Answering a checkpoint is two operations with no transaction across them:
-- the version-guarded UPDATE that commits the answer, and the Temporal signal
-- that tells the workflow about it. Losing the process (or the socket) between
-- them left the row resolved and the workflow parked in `condition()` forever,
-- with every retry bouncing off the "not pending" check as a 409.
--
-- `signalled_at` records that the second half actually happened, so a retry or
-- a reconciliation sweep can tell "already answered AND delivered" (a genuine
-- conflict) from "answered but never delivered" (unfinished work that must be
-- finished, not refused).

ALTER TABLE checkpoints ADD COLUMN signalled_at INTEGER;

-- This corrected backfill records itself in the ledger as
-- `checkpoint_delivery_scoped`; the original recorded `checkpoint_delivery`.
-- The name is NOT a reliable record of which of the two a database ran: this
-- SQL was corrected one commit before the ledger name was changed, so a
-- database provisioned in between ran THIS backfill under the OLD name.
-- `checkpoint_delivery` therefore means "ambiguous", and 0008 decides the
-- question from a row shape only the original could leave behind rather than
-- from the name. Nothing may fence on the name alone.
--
-- Backfill. Rows resolved before this migration were written by code that had
-- no flag, so the honest answer is inferred from the owning task: a task still
-- PARKED with a resolved checkpoint is exactly the wedged shape this migration
-- exists to repair, and its newest resolved checkpoint is left undelivered so
-- the reconciliation sweep re-signals it. Every other resolved row is treated
-- as delivered, so the sweep does not spray signals at workflows that already
-- consumed their answer (or have since closed).
--
-- Two things this predicate has to get right, and originally did not:
--
--   * PARKED is not the same as `waiting%`. A `limit-exceeded` checkpoint parks
--     its task in `needs_attention` (task-engine `gates.ts`, 06 section 8) —
--     the one parked status with no `waiting` prefix. Excluding it latched the
--     exact answer the sweep exists to recover, so a budget extension a human
--     had already granted was dropped and every retry 409'd forever.
--   * The state being inferred is per-CHECKPOINT, not per-TASK. A task keeps
--     every checkpoint it ever resolved, so scoping the exclusion to the task
--     re-opened all of them and had the first boot re-signal answers the
--     workflow consumed rounds ago. Only the task's LATEST resolved checkpoint
--     can be the one it is currently parked on.
UPDATE checkpoints
   SET signalled_at = COALESCE(answered_at, created_at)
 WHERE status != 'pending'
   AND signalled_at IS NULL
   AND NOT (
         task_id IN (
           SELECT id FROM tasks
            WHERE status LIKE 'waiting%' OR status = 'needs_attention'
         )
     AND id = (
           SELECT c2.id
             FROM checkpoints c2
            WHERE c2.task_id = checkpoints.task_id
              AND c2.status != 'pending'
            ORDER BY COALESCE(c2.answered_at, c2.created_at) DESC, c2.id DESC
            LIMIT 1
         )
       );

-- The sweep's only query: resolved rows that were never signalled. Partial, so
-- it stays the size of the backlog (normally zero) rather than the table.
CREATE INDEX IF NOT EXISTS checkpoints_undelivered_idx
  ON checkpoints(answered_at)
  WHERE signalled_at IS NULL AND status != 'pending';
