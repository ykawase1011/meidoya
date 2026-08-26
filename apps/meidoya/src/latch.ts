import {
  listCandidates,
  releaseLatch,
  type CheckpointLatchCandidate,
  type ReleaseOutcome,
} from "@meidoya/store-sqlite";
import type { MeidoyaDatabase } from "@meidoya/store-sqlite";

/**
 * `meidoya admin latch` — the operator-run repair that replaced migration 0008.
 *
 * WHY THE CLI AND NOT THE DAEMON. Three reasons, in order of weight:
 *
 *   1. The wedge is a reason the daemon may not be usable. A task parked on an
 *      undelivered answer is exactly the state an operator reaches for this in,
 *      and a repair that needs a healthy control plane to reach the row is not
 *      available when it is needed. This reads the database file directly, so
 *      it works with the daemon stopped.
 *   2. It is a database-level fact, not a task-level one. `signalled_at` and
 *      `signalled_by` are delivery bookkeeping the Control Plane API
 *      deliberately does not model — no verb exposes them, and adding one would
 *      put a "mark this answer undelivered" primitive into the scoped,
 *      token-authenticated surface that ordinary clients speak, for a thing
 *      only a machine operator should ever do.
 *   3. Authority. Everything on the socket is authorised by a session
 *      credential bound to an ingress profile. Filesystem access to the SQLite
 *      file is a strictly stronger and more honest authority for a repair that
 *      edits rows behind the API's back — whoever can open the file is already
 *      the machine's operator.
 *
 * It needs NO daemon-side method. The reconciliation sweep already selects on
 * `signalled_at IS NULL AND status != 'pending'` (repository
 * `listUndeliveredCheckpoints`), so a released row is picked up by the running
 * daemon with no change on that side at all.
 */

export type LatchIo = {
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * Opens the database the operator named. `mode` is the whole point of the
   * parameter: `list` and a dry-run `release` ask for `"read"`, and the opener
   * must then neither create the file nor write to it. Pointing the previous
   * version at a typo INVENTED that database and reported it healthy, and
   * pointing it at any other SQLite file converted that file to WAL — a
   * persistent, on-disk change — before reading a single row.
   *
   * Injected so tests can supply their own; they supply a real one over a real
   * file, because a stub is exactly how the defect above stayed invisible.
   */
  open: (path: string, mode: "read" | "write") => MeidoyaDatabase;
};

export const LATCH_USAGE = `meidoya admin latch list    --db <path> [--json]
meidoya admin latch release --db <path> --checkpoint <id> [--apply] [--force]

  Lists resolved checkpoints under a task that is still parked on a human,
  with the delivery latch and its provenance, so a human can decide whether an
  answer really reached its workflow. \`release\` clears one latch by id and the
  daemon's reconciliation sweep re-delivers it; without --apply it only reports
  what it would do.

  --db is required, is never guessed, and must already exist: it is
  control_plane.sqlite.path from the daemon's config (MEIDOYA_SQLITE_PATH is
  read as a fallback). \`list\` and a dry-run \`release\` open it read-only.

  --force is needed to clear a latch that records an OBSERVED delivery, or one
  whose task is no longer parked on a human.`;

function isoOrDash(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString();
}

/**
 * One candidate, as evidence rather than as a verdict. Every field a human
 * needs to go and check the workflow is here, and no field claims to know the
 * answer.
 */
function formatCandidate(c: CheckpointLatchCandidate): string[] {
  return [
    `${c.checkpointId}  [${c.latch}]`,
    `  task       ${c.taskId}  ${c.taskStatus}  ${c.taskTitle}`,
    `  checkpoint ${c.checkpointKind}  ${c.checkpointStatus}`,
    `  answered   ${isoOrDash(c.answeredAt)}   (created ${isoOrDash(c.createdAt)})`,
    `  latched    ${isoOrDash(c.signalledAt)}  by ${c.signalledBy ?? "(none recorded)"}`,
  ];
}

const LATCH_LEGEND = [
  "latch states:",
  "  undelivered  not latched; the sweep already owes this answer a signal",
  "  backfill     a MIGRATION inferred delivery. Never observed — the suspects",
  "  signal       the workflow received it. Releasing needs --force",
  "  discarded    the sweep gave up; the answer was NOT delivered",
  "  unknown      latched before provenance existed. Could be either",
];

function withDatabase<T>(
  io: LatchIo,
  path: string,
  mode: "read" | "write",
  body: (db: MeidoyaDatabase) => T,
): T {
  const db = io.open(path, mode);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

function cmdList(io: LatchIo, dbPath: string, json: boolean): number {
  const candidates = withDatabase(io, dbPath, "read", listCandidates);
  if (json) {
    io.out(JSON.stringify(candidates, null, 2));
    return 0;
  }
  if (candidates.length === 0) {
    io.out("no resolved checkpoints under a parked task");
    return 0;
  }
  for (const candidate of candidates) for (const line of formatCandidate(candidate)) io.out(line);
  io.out("");
  for (const line of LATCH_LEGEND) io.out(line);
  io.out("");
  io.out(
    "A latched row is invisible to the reconciliation sweep. If the workflow never got the " +
      "answer, clear it with: meidoya admin latch release --db <path> --checkpoint <id> --apply",
  );
  return 0;
}

/** Exit code per outcome: 0 only when the operator learned what they asked. */
function reportRelease(io: LatchIo, result: ReleaseOutcome, json: boolean): number {
  if (json) {
    io.out(JSON.stringify(result, null, 2));
    // Exit codes must agree with the human path: an outcome that refused or
    // failed to write is not a success just because it was asked for as JSON.
    const failed: ReleaseOutcome["outcome"][] = [
      "unknown-checkpoint",
      "not-resolved",
      "refused-observed",
      "refused-finished-task",
      "not-applied",
    ];
    return failed.includes(result.outcome) ? 1 : 0;
  }
  switch (result.outcome) {
    case "unknown-checkpoint":
      io.err(`no such checkpoint: ${result.checkpointId}`);
      return 1;
    case "not-resolved":
      for (const line of formatCandidate(result.candidate)) io.out(line);
      io.err("checkpoint is still pending: there is no committed answer to re-deliver");
      return 1;
    case "already-undelivered":
      for (const line of formatCandidate(result.candidate)) io.out(line);
      io.out("already undelivered; the sweep already owes this answer a signal. Nothing to do.");
      return 0;
    case "refused-observed":
      for (const line of formatCandidate(result.candidate)) io.out(line);
      io.err(
        "refusing: this latch records an OBSERVED delivery (signalled_by='signal'), not a " +
          "migration's guess. Releasing it asks the sweep to re-signal an answer the workflow " +
          "already consumed, and if that workflow is gone the sweep reports a " +
          "CheckpointAnswerDiscarded for an answer nobody lost. Pass --force if you have " +
          "checked the workflow and it never received this answer.",
      );
      return 1;
    case "refused-finished-task":
      for (const line of formatCandidate(result.candidate)) io.out(line);
      io.err(
        `refusing: task ${result.candidate.taskId} is ${result.candidate.taskStatus}, not parked on ` +
          "a human, so its workflow is not waiting for this answer — it has almost certainly " +
          "finished. Clearing the latch asks the sweep to signal a workflow that is gone, and the " +
          "sweep will then report a CheckpointAnswerDiscarded for an answer nobody lost. Pass " +
          "--force if you have checked the workflow and it really is still waiting.",
      );
      return 1;
    case "not-applied":
      for (const line of formatCandidate(result.candidate)) io.out(line);
      io.err(
        "the latch changed between reading this evidence and writing, so nothing was cleared. " +
          "Re-run to see the row's current state before deciding again.",
      );
      return 1;
    case "would-release":
      for (const line of formatCandidate(result.candidate)) io.out(line);
      io.out("");
      io.out("would clear signalled_at and signalled_by. Nothing written — re-run with --apply.");
      return 0;
    case "released":
      for (const line of formatCandidate(result.candidate)) io.out(line);
      io.out("");
      io.out("latch cleared. The daemon's reconciliation sweep will re-deliver this answer.");
      return 0;
  }
}

/**
 * `meidoya admin latch <list|release> ...`. Returns a process exit code and
 * writes through `io`, so the whole surface is testable without a daemon, a
 * socket, or a file on disk.
 */
export function runLatchCommand(
  io: LatchIo,
  positionals: string[],
  values: Record<string, string | boolean | string[] | undefined>,
  env: Record<string, string | undefined>,
): number {
  const sub = positionals[0];
  if (sub === undefined || sub === "help") {
    io.out(LATCH_USAGE);
    return sub === undefined ? 2 : 0;
  }
  const dbPath = (values["db"] as string | undefined) ?? env["MEIDOYA_SQLITE_PATH"];
  if (dbPath === undefined || dbPath === "") {
    io.err(
      "admin latch needs the database path: --db <path> (control_plane.sqlite.path from the " +
        "daemon config), or MEIDOYA_SQLITE_PATH. It is never guessed.",
    );
    return 2;
  }
  const json = values["json"] === true;

  switch (sub) {
    case "list":
    case "release":
      break;
    default:
      io.err(`unknown admin latch command: ${sub}\n\n${LATCH_USAGE}`);
      return 2;
  }

  // A database that cannot be opened is an operator mistake — a typo, a path
  // that needs sudo, a file that is not there — and it deserves the message the
  // opener wrote rather than a stack trace. It must never be recovered from by
  // creating the file, which is exactly what the previous version did.
  try {
    if (sub === "list") return cmdList(io, dbPath, json);
    const checkpointId = values["checkpoint"] as string | undefined;
    if (checkpointId === undefined || checkpointId === "") {
      io.err("admin latch release needs --checkpoint <id>");
      return 2;
    }
    const apply = values["apply"] === true;
    const result = withDatabase(io, dbPath, apply ? "write" : "read", (db) =>
      releaseLatch(db, checkpointId, { apply, force: values["force"] === true }),
    );
    return reportRelease(io, result, json);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
