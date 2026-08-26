import type { NotificationOutboxStatus, OutboxAction, TaskId } from "@meidoya/domain";
import type { MeidoyaDatabase } from "@meidoya/store-sqlite";

/** What the interaction policy produced, as stored in the outbox. */
export type OutboxIntentInput = {
  action: OutboxAction;
  idempotencyKey: string;
  eventId: string;
  workspaceId: string;
  conversationId?: string;
  taskId?: TaskId;
  /** Action-specific data (emoji, rendered message, edit target). */
  payload: Record<string, unknown>;
};

export type OutboxRecord = {
  id: string;
  workspaceId: string;
  conversationId?: string;
  eventId: string;
  action: OutboxAction;
  idempotencyKey: string;
  status: NotificationOutboxStatus;
  attempt: number;
  /** Earliest time the row may be claimed. NEVER a lease expiry (see 0004). */
  availableAt: number;
  /** Set only while `sending`: when the current claim stops being exclusive. */
  leaseExpiresAt?: number;
  /** Identifies the worker holding the current claim. */
  claimToken?: string;
  createdAt: number;
  sentAt?: number;
  payload: Record<string, unknown>;
};

export type TaskUpdate = {
  taskId: TaskId;
  status: string;
  /** Optional optimistic-concurrency guard on tasks.version. */
  expectedVersion?: number;
};

export type EnqueueOptions = {
  now?: number;
  /** Injected so the caller controls ID generation (tests use a counter). */
  newId?: () => string;
};

type Row = {
  id: string;
  workspace_id: string;
  conversation_id: string | null;
  event_id: string;
  action: string;
  payload_json: string;
  idempotency_key: string;
  status: string;
  attempt: number;
  available_at: number;
  lease_expires_at: number | null;
  claim_token: string | null;
  created_at: number;
  sent_at: number | null;
};

function toRecord(row: Row): OutboxRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    eventId: row.event_id,
    action: row.action as OutboxAction,
    idempotencyKey: row.idempotency_key,
    status: row.status as NotificationOutboxStatus,
    attempt: row.attempt,
    availableAt: row.available_at,
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
    createdAt: row.created_at,
    ...(row.sent_at === null ? {} : { sentAt: row.sent_at }),
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

let counter = 0;
function defaultId(): string {
  counter += 1;
  return `obx_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * Inserts outbox rows. `INSERT OR IGNORE` on the unique idempotency_key makes a
 * duplicate enqueue a silent no-op rather than an error (08 section 10).
 */
export function insertIntents(
  db: MeidoyaDatabase,
  intents: readonly OutboxIntentInput[],
  options: EnqueueOptions = {}
): number {
  const now = options.now ?? Date.now();
  const newId = options.newId ?? defaultId;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO notification_outbox
       (id, workspace_id, conversation_id, event_id, action, payload_json,
        idempotency_key, status, attempt, available_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
  );
  let inserted = 0;
  for (const intent of intents) {
    const result = stmt.run(
      newId(),
      intent.workspaceId,
      intent.conversationId ?? null,
      intent.eventId,
      intent.action,
      JSON.stringify({ ...intent.payload, taskId: intent.taskId ?? null }),
      intent.idempotencyKey,
      now,
      now
    );
    inserted += result.changes;
  }
  return inserted;
}

/**
 * 07 section 5 core guarantee: the task state update and the outbox insert
 * commit together or not at all.
 */
export function enqueueWithTaskUpdate(
  db: MeidoyaDatabase,
  taskUpdate: TaskUpdate,
  intents: readonly OutboxIntentInput[],
  options: EnqueueOptions = {}
): number {
  const now = options.now ?? Date.now();
  const run = db.transaction(() => {
    const result =
      taskUpdate.expectedVersion === undefined
        ? db
            .prepare(
              "UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ?"
            )
            .run(taskUpdate.status, now, taskUpdate.taskId)
        : db
            .prepare(
              "UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?"
            )
            .run(taskUpdate.status, now, taskUpdate.taskId, taskUpdate.expectedVersion);
    if (result.changes !== 1) {
      throw new Error(
        `task update did not apply: ${taskUpdate.taskId} (expectedVersion=${String(
          taskUpdate.expectedVersion
        )})`
      );
    }
    return insertIntents(db, intents, { ...options, now });
  });
  return run();
}

/**
 * How long a claim is held before another pass may take the row back. A
 * dispatch that crashes (or a process that is killed mid-post) leaves the row
 * in `sending`; without a lease it would stay there forever, invisible to
 * every retry and to the failure count.
 */
export const DEFAULT_CLAIM_LEASE_MS = 60_000;

export const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * A notification the outbox has GIVEN UP ON. Nothing else in the system will
 * ever deliver it, so this is the last moment at which its existence can be
 * known — which is why every dead-letter path is required to emit one and the
 * default sink writes to `console.error` rather than doing nothing.
 *
 * The bug this exists for: a token rotation made every queued row fail
 * terminally, every one was written `status='failed'` on attempt 1, and not a
 * single line was logged. The backlog was gone and nobody could tell.
 */
export type OutboxDeadLetter = {
  id: string;
  workspaceId: string;
  conversationId?: string;
  eventId: string;
  action: OutboxAction;
  idempotencyKey: string;
  /** Attempt number the row died on. */
  attempt: number;
  /** Which code path gave up: a dispatch, a claim reclaim, or the startup sweep. */
  origin: "dispatch" | "reclaim" | "sweep";
  reason: "terminal" | "attempts-exhausted";
  /** The transport error, when the give-up followed one. */
  error?: unknown;
};

export type DeadLetterSink = (event: OutboxDeadLetter) => void;

/** Default sink. Loud on purpose: a lost notification must never be silent. */
export const reportDeadLetter: DeadLetterSink = (event) => {
  console.error(
    `[outbox] DEAD-LETTER ${event.action} ${event.idempotencyKey} (row ${event.id}, workspace ${event.workspaceId}, attempt ${event.attempt}, ${event.origin}/${event.reason}) — this notification will never be delivered`,
    event.error ?? ""
  );
};

/** Invokes a sink without ever letting a broken reporter break delivery. */
export function emitDeadLetter(sink: DeadLetterSink | undefined, event: OutboxDeadLetter): void {
  try {
    (sink ?? reportDeadLetter)(event);
  } catch {
    // A reporter that throws must not turn into a second failure mode.
  }
}

function deadLetterOf(
  record: OutboxRecord,
  origin: OutboxDeadLetter["origin"],
  reason: OutboxDeadLetter["reason"],
  attempt: number,
  error?: unknown
): OutboxDeadLetter {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
    eventId: record.eventId,
    action: record.action,
    idempotencyKey: record.idempotencyKey,
    attempt,
    origin,
    reason,
    ...(error === undefined ? {} : { error }),
  };
}

export type ClaimOptions = {
  now?: number;
  limit?: number;
  /** Claim lease; `sending` rows past it are reclaimed by the next pass. */
  leaseMs?: number;
  /**
   * A reclaim counts as a failed attempt, so a row that poisons every worker
   * that touches it dead-letters here instead of looping forever.
   */
  maxAttempts?: number;
  /** Injected so a test can make the claim token deterministic. */
  newToken?: () => string;
  /**
   * Rows this process is dispatching right now. A lease can only ever say
   * "nobody has touched this for a while"; it cannot tell a dead holder from a
   * slow one. The caller CAN tell, for its own dispatches, so it excludes them
   * and a transport call that outlives its lease is not re-sent underneath
   * itself. (Across processes the lease must simply exceed the transport
   * timeout — which is why it defaults to a minute.)
   */
  excludeIds?: readonly string[];
  /** Where a row this claim gives up on is reported. Defaults to console.error. */
  onDeadLetter?: DeadLetterSink;
};

let tokenCounter = 0;
function defaultToken(): string {
  tokenCounter += 1;
  return `clm_${Date.now().toString(36)}_${tokenCounter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Claims due rows and flips them to `sending` under a fresh lease.
 *
 * Two kinds of rows are due, and they are due for different reasons, read from
 * different columns:
 *   - `pending` rows whose `available_at` (retry time) has arrived;
 *   - `sending` rows whose `lease_expires_at` has passed, i.e. the dispatch
 *     that claimed them never finished (crashed process, killed daemon).
 * Conflating those two into one column is what made a slow-but-alive dispatch
 * indistinguishable from a dead one, and posted its message twice.
 *
 * Every claim is a conditional update against the exact row state the SELECT
 * saw (`status`, `available_at`, `claim_token`) inside a BEGIN IMMEDIATE
 * transaction, so of two publishers racing for a row exactly one wins: the
 * loser's UPDATE matches zero rows and the row is simply not in its batch.
 *
 * The winner stamps a NEW `claim_token`. That is what makes the loser (or a
 * timed-out previous holder) harmless: `markSent`/`markFailure` are guarded by
 * the token, so a worker that lost the row cannot report on it any more.
 */
export function claimPending(db: MeidoyaDatabase, options: ClaimOptions = {}): OutboxRecord[] {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 20;
  const leaseMs = options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const newToken = options.newToken ?? defaultToken;
  const exclude = options.excludeIds ?? [];
  const excludeSql =
    exclude.length === 0 ? "" : ` AND id NOT IN (${exclude.map(() => "?").join(", ")})`;
  const claim = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT * FROM notification_outbox
          WHERE ((status = 'pending' AND available_at <= ?)
             OR (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
            ${excludeSql}
          ORDER BY available_at ASC, created_at ASC
          LIMIT ?`
      )
      .all(now, now, ...exclude, limit) as Row[];
    const take = db.prepare(
      `UPDATE notification_outbox
          SET status = 'sending', attempt = ?, lease_expires_at = ?, claim_token = ?
        WHERE id = ? AND status = ? AND available_at = ?
          AND IFNULL(claim_token, '') = ?`
    );
    const deadLetter = db.prepare(
      `UPDATE notification_outbox
          SET status = 'failed', attempt = ?, lease_expires_at = NULL, claim_token = NULL
        WHERE id = ? AND status = 'sending' AND IFNULL(claim_token, '') = ?`
    );
    const claimed: OutboxRecord[] = [];
    for (const row of rows) {
      const previousToken = row.claim_token ?? "";
      // Taking a row back from a dead holder IS a failed attempt. Without this
      // the attempt counter never moved on the reclaim path and the
      // dead-letter threshold below was unreachable: a row that killed every
      // worker looked forever like a first try.
      const reclaimed = row.status === "sending";
      const attempt = reclaimed ? row.attempt + 1 : row.attempt;
      if (reclaimed && attempt >= maxAttempts && deliveryOf(toRecord(row)) === undefined) {
        const applied = deadLetter.run(attempt, row.id, previousToken);
        if (applied.changes === 1) {
          emitDeadLetter(
            options.onDeadLetter,
            deadLetterOf(toRecord(row), "reclaim", "attempts-exhausted", attempt)
          );
        }
        continue;
      }
      const token = newToken();
      const result = take.run(
        attempt,
        now + leaseMs,
        token,
        row.id,
        row.status,
        row.available_at,
        previousToken
      );
      // Somebody else claimed it between our SELECT and our UPDATE.
      if (result.changes !== 1) continue;
      claimed.push({
        ...toRecord(row),
        status: "sending" as const,
        attempt,
        leaseExpiresAt: now + leaseMs,
        claimToken: token,
      });
    }
    return claimed;
  });
  // IMMEDIATE: take the write lock up front so two concurrent claims serialise
  // instead of racing a read snapshot into "database is locked" on upgrade.
  return claim.immediate();
}

/**
 * Startup sweep: hands rows whose lease has EXPIRED back to the pending queue
 * at once, rather than waiting for the next poll.
 *
 * It deliberately does not touch live claims. This used to be an unconditional
 * `WHERE status = 'sending'`, justified by "at process start nothing of ours is
 * in flight" — but the rows belong to the database, not to the process, so a
 * second daemon starting during a deploy overlap handed every in-flight row of
 * the still-running daemon back to the queue and every one of those messages
 * was posted twice. Returns how many rows were handed back to `pending`.
 *
 * The sweep bumps `attempt`, so it must respect the SAME budget `claimPending`
 * does. It used to increment past `maxAttempts` unchecked, which handed a
 * stranded row one dispatch beyond its budget on every restart — the exact
 * unbounded-retry shape the dead-letter exists to stop. A row whose bumped
 * attempt has reached the budget, and which carries no delivery receipt, is
 * dead-lettered here instead.
 */
export function reclaimStaleClaims(
  db: MeidoyaDatabase,
  options: { now?: number; maxAttempts?: number; onDeadLetter?: DeadLetterSink } = {}
): number {
  const now = options.now ?? Date.now();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sweep = db.transaction(() => {
    const stale = db
      .prepare(
        `SELECT * FROM notification_outbox
          WHERE status = 'sending'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?`
      )
      .all(now) as Row[];
    const requeue = db.prepare(
      `UPDATE notification_outbox
          SET status = 'pending', available_at = ?, attempt = ?,
              lease_expires_at = NULL, claim_token = NULL
        WHERE id = ? AND status = 'sending'`
    );
    const deadLetter = db.prepare(
      `UPDATE notification_outbox
          SET status = 'failed', attempt = ?, lease_expires_at = NULL, claim_token = NULL
        WHERE id = ? AND status = 'sending'`
    );
    let reclaimed = 0;
    for (const row of stale) {
      const record = toRecord(row);
      const attempt = row.attempt + 1;
      // A delivered row still owes only a status write; giving up on it would
      // hide a notification the human has already seen.
      if (attempt >= maxAttempts && deliveryOf(record) === undefined) {
        if (deadLetter.run(attempt, row.id).changes === 1) {
          emitDeadLetter(
            options.onDeadLetter,
            deadLetterOf(record, "sweep", "attempts-exhausted", attempt)
          );
        }
        continue;
      }
      reclaimed += requeue.run(now, attempt, row.id).changes;
    }
    return reclaimed;
  });
  return sweep.immediate();
}

/** Durable proof that the transport already accepted this row's message. */
export type DeliveryReceipt = {
  /** Ref the transport returned, when the action produces one. */
  ref?: Record<string, unknown>;
  at: number;
};

export function deliveryOf(record: OutboxRecord): DeliveryReceipt | undefined {
  const raw = record.payload["delivery"];
  if (typeof raw !== "object" || raw === null) return undefined;
  const at = (raw as Record<string, unknown>)["at"];
  if (typeof at !== "number") return undefined;
  const ref = (raw as Record<string, unknown>)["ref"];
  return typeof ref === "object" && ref !== null
    ? { ref: ref as Record<string, unknown>, at }
    : { at };
}

/**
 * Records that the transport accepted the message, BEFORE the row is marked
 * sent. If the process dies between the two, the reclaimed row carries the
 * receipt and the retry skips the transport call instead of posting twice.
 *
 * Deliberately NOT guarded by the claim token: a receipt is a statement about
 * the outside world ("this message exists"), true no matter who still holds
 * the row, and suppressing it could only cause a second post.
 */
export function recordDelivery(
  db: MeidoyaDatabase,
  id: string,
  receipt: DeliveryReceipt
): void {
  db.prepare(
    "UPDATE notification_outbox SET payload_json = json_set(payload_json, '$.delivery', json(?)) WHERE id = ?"
  ).run(JSON.stringify(receipt), id);
}

/**
 * Marks a row sent. When `claimToken` is given the write only applies if the
 * row is still held by that claim: a worker whose lease expired (and whose row
 * another publisher has since taken) must not be able to close it out from
 * under the new holder. Returns whether the row was actually updated.
 */
export function markSent(
  db: MeidoyaDatabase,
  id: string,
  now = Date.now(),
  receipt?: DeliveryReceipt,
  claimToken?: string
): boolean {
  const guard = claimToken === undefined ? "" : " AND claim_token = ?";
  const tokenArgs = claimToken === undefined ? [] : [claimToken];
  const result =
    receipt === undefined
      ? db
          .prepare(
            `UPDATE notification_outbox
                SET status = 'sent', sent_at = ?, lease_expires_at = NULL, claim_token = NULL
              WHERE id = ?${guard}`
          )
          .run(now, id, ...tokenArgs)
      : db
          .prepare(
            `UPDATE notification_outbox
                SET status = 'sent', sent_at = ?, lease_expires_at = NULL, claim_token = NULL,
                    payload_json = json_set(payload_json, '$.delivery', json(?))
              WHERE id = ?${guard}`
          )
          .run(now, JSON.stringify(receipt), id, ...tokenArgs);
  return result.changes === 1;
}

export type BackoffOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
};

export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 5 * 60_000;
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
}

export type FailureOptions = BackoffOptions & {
  now?: number;
  /**
   * Platform-advertised cool-down (`ChatRateLimitError.retryAfterMs`). The
   * transports deliberately do not sleep, because the outbox owns backoff, so
   * the retry is scheduled no earlier than the hint asks for.
   */
  retryAfterMs?: number;
  /**
   * The transport classified this failure as NOT retryable (`retryable: false`
   * on the error): rejected auth, a channel or message that does not exist, a
   * payload the platform will never accept. Retrying cannot change the answer,
   * so the row dead-letters now instead of burning its whole attempt budget and
   * delaying the signal that a human has to look at it.
   */
  terminal?: boolean;
};

/**
 * Records a transport failure: attempt++ and reschedule with exponential
 * backoff. Never touches task state (07 section 5, last line).
 */
export function markFailure(
  db: MeidoyaDatabase,
  record: OutboxRecord,
  options: FailureOptions = {}
): { status: NotificationOutboxStatus; availableAt: number; applied: boolean } {
  const now = options.now ?? Date.now();
  const attempt = record.attempt + 1;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  // Same exclusivity rule as markSent: only the current holder may reschedule.
  const guard = record.claimToken === undefined ? "" : " AND claim_token = ?";
  const tokenArgs = record.claimToken === undefined ? [] : [record.claimToken];
  if (options.terminal === true || attempt >= maxAttempts) {
    const result = db
      .prepare(
        `UPDATE notification_outbox
            SET status = 'failed', attempt = ?, lease_expires_at = NULL, claim_token = NULL
          WHERE id = ?${guard}`
      )
      .run(attempt, record.id, ...tokenArgs);
    return { status: "failed", availableAt: record.availableAt, applied: result.changes === 1 };
  }
  const hint = options.retryAfterMs;
  const delay =
    hint === undefined || !Number.isFinite(hint) || hint < 0
      ? backoffDelayMs(attempt, options)
      : Math.max(backoffDelayMs(attempt, options), hint);
  const availableAt = now + delay;
  const result = db
    .prepare(
      `UPDATE notification_outbox
          SET status = 'pending', attempt = ?, available_at = ?,
              lease_expires_at = NULL, claim_token = NULL
        WHERE id = ?${guard}`
    )
    .run(attempt, availableAt, record.id, ...tokenArgs);
  return { status: "pending", availableAt, applied: result.changes === 1 };
}

export function getByIdempotencyKey(
  db: MeidoyaDatabase,
  key: string
): OutboxRecord | undefined {
  const row = db
    .prepare("SELECT * FROM notification_outbox WHERE idempotency_key = ?")
    .get(key) as Row | undefined;
  return row === undefined ? undefined : toRecord(row);
}

export function listAll(db: MeidoyaDatabase): OutboxRecord[] {
  const rows = db
    .prepare("SELECT * FROM notification_outbox ORDER BY created_at ASC, id ASC")
    .all() as Row[];
  return rows.map(toRecord);
}
