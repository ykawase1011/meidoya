import type { MeidoyaDatabase } from "./db.js";

/**
 * The operator-run replacement for migration 0008.
 *
 * A resolved checkpoint carries a delivery latch (`signalled_at`, migration
 * 0005) that says its answer reached the workflow, and a provenance
 * (`signalled_by`, migration 0007) that says who decided that. When the latch
 * is wrong the task is parked forever: the reconciliation sweep only looks at
 * `signalled_at IS NULL`, so a wrongly-latched row is invisible to it.
 *
 * Four migrations tried to find that row from SQL alone and none could: whether
 * an answer actually reached its workflow is a fact about a Temporal workflow's
 * history, not about these columns. What SQL CAN do is list the candidates
 * together with every stored fact bearing on the question, and let a human who
 * can look at the workflow decide. That is all this module does.
 *
 * Nothing here runs on boot. `listCandidates` is read-only; `releaseLatch`
 * changes exactly one row, named by id, and reports what it did.
 */

/** How a candidate's latch got there, as far as the database knows. */
export type LatchState =
  /** `signalled_at IS NULL` — already queued; the sweep will retry it. */
  | "undelivered"
  /** A migration INFERRED delivery. Never observed. The suspect rows. */
  | "backfill"
  /** `markCheckpointSignalled` ran because the signal landed. */
  | "signal"
  /** The sweep gave up on a workflow it corroborated as gone. NOT delivered. */
  | "discarded"
  /**
   * Latched, with no provenance recorded. Written before 0007 existed, when the
   * sweep's give-up path latched rows the same way a successful delivery did,
   * so this may be either. Unknown, and readable as unknown.
   */
  | "unknown";

export type CheckpointLatchCandidate = {
  checkpointId: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  checkpointKind: string;
  checkpointStatus: string;
  createdAt: number;
  answeredAt: number | null;
  signalledAt: number | null;
  signalledBy: string | null;
  latch: LatchState;
};

function latchState(signalledAt: number | null, signalledBy: string | null): LatchState {
  if (signalledAt === null) return "undelivered";
  if (signalledBy === "backfill") return "backfill";
  if (signalledBy === "signal") return "signal";
  if (signalledBy === "discarded") return "discarded";
  return "unknown";
}

type Row = {
  checkpointId: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  checkpointKind: string;
  checkpointStatus: string;
  createdAt: number;
  answeredAt: number | null;
  signalledAt: number | null;
  signalledBy: string | null;
};

/**
 * Every resolved checkpoint belonging to a task that is still parked on a
 * human.
 *
 * The filter is deliberately WIDE and deliberately NOT a verdict. It selects on
 * the one thing that is not a guess — the task is parked, so something is
 * unfinished — and then reports the latch of every resolved checkpoint under
 * it, delivered or not. A narrower query ("only `backfill` rows") would be the
 * migrations' mistake in a new place: it would decide, silently, that a NULL
 * provenance or a `discarded` row cannot be the problem, and the operator would
 * never see the row that actually explains the wedge.
 *
 * Ordered by task then by answer time, oldest first, so two runs on one
 * database print identical output.
 */
export function listCandidates(db: MeidoyaDatabase): CheckpointLatchCandidate[] {
  const rows = db
    .prepare(
      `SELECT c.id            AS checkpointId,
              c.task_id       AS taskId,
              t.title         AS taskTitle,
              t.status        AS taskStatus,
              c.kind          AS checkpointKind,
              c.status        AS checkpointStatus,
              c.created_at    AS createdAt,
              c.answered_at   AS answeredAt,
              c.signalled_at  AS signalledAt,
              c.signalled_by  AS signalledBy
         FROM checkpoints c
         JOIN tasks t ON t.id = c.task_id
        WHERE c.status != 'pending'
          AND (t.status LIKE 'waiting%' OR t.status = 'needs_attention')
        ORDER BY c.task_id ASC, COALESCE(c.answered_at, c.created_at) ASC, c.id ASC`,
    )
    .all() as Row[];
  return rows.map((r) => ({ ...r, latch: latchState(r.signalledAt, r.signalledBy) }));
}

/** Looks one checkpoint up by id, parked task or not, for `release`'s report. */
export function findCandidate(
  db: MeidoyaDatabase,
  checkpointId: string,
): CheckpointLatchCandidate | undefined {
  const row = db
    .prepare(
      `SELECT c.id            AS checkpointId,
              c.task_id       AS taskId,
              t.title         AS taskTitle,
              t.status        AS taskStatus,
              c.kind          AS checkpointKind,
              c.status        AS checkpointStatus,
              c.created_at    AS createdAt,
              c.answered_at   AS answeredAt,
              c.signalled_at  AS signalledAt,
              c.signalled_by  AS signalledBy
         FROM checkpoints c
         JOIN tasks t ON t.id = c.task_id
        WHERE c.id = ?`,
    )
    .get(checkpointId) as Row | undefined;
  if (row === undefined) return undefined;
  return { ...row, latch: latchState(row.signalledAt, row.signalledBy) };
}

export type ReleaseOutcome =
  | { outcome: "unknown-checkpoint"; checkpointId: string }
  /** Still pending: there is no committed answer to re-deliver. */
  | { outcome: "not-resolved"; candidate: CheckpointLatchCandidate }
  /** Already `signalled_at IS NULL`; the sweep already owns it. */
  | { outcome: "already-undelivered"; candidate: CheckpointLatchCandidate }
  /**
   * Latched by an OBSERVED delivery (`signal`). Clearing it asks the sweep to
   * re-signal an answer the workflow already consumed; refused unless the
   * operator says `--force`.
   */
  | { outcome: "refused-observed"; candidate: CheckpointLatchCandidate }
  /**
   * The task is no longer parked on a human, so its workflow is not waiting for
   * this answer. Refused unless the operator says `--force`. See
   * `isParkedTaskStatus`.
   */
  | { outcome: "refused-finished-task"; candidate: CheckpointLatchCandidate }
  /** Nothing was written; this is what `--apply` would do. */
  | { outcome: "would-release"; candidate: CheckpointLatchCandidate }
  /**
   * The row moved between the evidence being gathered and the write, so the
   * write was refused. Nothing changed and nothing is claimed.
   */
  | { outcome: "not-applied"; candidate: CheckpointLatchCandidate }
  | { outcome: "released"; candidate: CheckpointLatchCandidate };

/**
 * Whether a task is still parked on a human — the same predicate
 * `listCandidates` selects on, in one place so the listing and the release
 * fence cannot drift apart.
 */
export function isParkedTaskStatus(status: string): boolean {
  return status.startsWith("waiting") || status === "needs_attention";
}

/**
 * Clears one checkpoint's delivery latch so the reconciliation sweep will
 * re-deliver its answer.
 *
 * Dry by default: with `apply: false` it reports `would-release` and writes
 * nothing, so the evidence and the consequence can be read before anything
 * changes. The row is named by id — never by a predicate — because a predicate
 * over the whole table is what 0006 and 0008 were, and a predicate cannot be
 * reviewed against the workflow it will affect.
 *
 * A duplicate signal is inert: TaskWorkflow consumes at most one answer per
 * checkpoint id. The real cost of a wrong release is a `CheckpointAnswerDiscarded`
 * report when the workflow is gone, which is why `signal`-provenance rows and
 * finished tasks need `force`, and why the caller prints the evidence either way.
 *
 * F8, four defects in this one function, all in the write path:
 *
 *  1. NO TASK-STATUS FENCE. `findCandidate` looks a checkpoint up by id and
 *     ignores the task's status entirely, so a checkpoint under a `succeeded`
 *     task released with no `--force` at all — a strictly worse case than the
 *     `signal` provenance that DID require it, because the workflow is not just
 *     possibly gone, it is finished. The sweep then re-signals a dead workflow
 *     and emits `CheckpointAnswerDiscarded` for an answer nobody lost, which is
 *     the one log line this module says must never cry wolf.
 *  2. NOT ATOMIC. `db.inTransaction` was `false` at the UPDATE: the evidence was
 *     gathered by one autocommit statement and the write made by another.
 *  3. THE WRITE WAS NOT FENCED ON WHAT WAS VALIDATED. Its `WHERE` re-checked
 *     only `signalled_at IS NOT NULL` — never the provenance `--force` was
 *     decided from — so a genuine delivery landing in between was wiped by a
 *     release the operator had authorised against a `backfill` row.
 *  4. IT REPORTED SUCCESS IT DID NOT ACHIEVE. `.changes` was never read, so
 *     `changes: 0` still printed "latch cleared" and exited 0.
 *
 * So the whole decision now runs inside one `BEGIN IMMEDIATE`, the write is
 * fenced on the exact `(signalled_at, signalled_by)` pair the refusal rules were
 * applied to, and a write that changes no row is reported as `not-applied`.
 */
export function releaseLatch(
  db: MeidoyaDatabase,
  checkpointId: string,
  options: { apply: boolean; force?: boolean },
): ReleaseOutcome {
  const decide = (): ReleaseOutcome => {
    const candidate = findCandidate(db, checkpointId);
    if (candidate === undefined) return { outcome: "unknown-checkpoint", checkpointId };
    if (candidate.checkpointStatus === "pending") return { outcome: "not-resolved", candidate };
    if (candidate.signalledAt === null) return { outcome: "already-undelivered", candidate };
    if (candidate.latch === "signal" && options.force !== true) {
      return { outcome: "refused-observed", candidate };
    }
    if (!isParkedTaskStatus(candidate.taskStatus) && options.force !== true) {
      return { outcome: "refused-finished-task", candidate };
    }
    if (!options.apply) return { outcome: "would-release", candidate };

    const result = db
      .prepare(
        `UPDATE checkpoints
            SET signalled_at = NULL, signalled_by = NULL
          WHERE id = ?
            AND signalled_at IS NOT NULL
            AND signalled_at IS ?
            AND signalled_by IS ?`,
      )
      .run(checkpointId, candidate.signalledAt, candidate.signalledBy);
    if (result.changes === 0) return { outcome: "not-applied", candidate };
    const after = findCandidate(db, checkpointId);
    return { outcome: "released", candidate: after ?? candidate };
  };

  // One transaction over the read AND the write, but only when there IS a write:
  // a dry run must stay usable against a read-only connection, and `BEGIN
  // IMMEDIATE` takes a write lock.
  //
  // Immediate rather than deferred, so the lock is taken before the evidence is
  // read rather than after — a deferred transaction that has already read cannot
  // wait for the write lock without risking deadlock, so SQLite refuses to run
  // the busy handler for it at all.
  if (!options.apply) return decide();
  return db.transaction(decide).immediate();
}
