import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ArtifactRef,
  HumanCheckpoint,
  Task,
  TaskId,
  TaskStatus,
  WorkspaceId,
} from "@meidoya/domain";
import type { MeidoyaDatabase } from "@meidoya/store-sqlite";
import type { OutboxIntent, StepRecord, TaskRepositoryPort } from "@meidoya/task-engine";
import { insertIntents } from "@meidoya/notification-outbox";
import type { SerialWriteQueue } from "./write-queue.js";
import type { ResolvedControlPlaneConfig } from "./config.js";

type TaskRow = {
  id: string;
  workspace_id: string;
  conversation_id: string | null;
  parent_task_id: string | null;
  origin: string;
  pipeline: string;
  title: string;
  intent_json: string;
  status: string;
  temporal_workflow_id: string;
  version: number;
  created_at: number;
  updated_at: number;
};

type CheckpointRow = {
  id: string;
  task_id: string;
  kind: string;
  status: string;
  prompt: string;
  choices_json: string;
  version: number;
};

/** `checkpoints` joined to its task, as the delivery paths need it. */
type CheckpointDeliveryRow = {
  id: string;
  task_id: string;
  workspace_id: string;
  status: string;
  version: number;
  answer_json: string | null;
  signalled_at: number | null;
};

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
    origin: row.origin as Task["origin"],
    pipeline: row.pipeline as Task["pipeline"],
    title: row.title,
    intent: JSON.parse(row.intent_json) as Task["intent"],
    status: row.status as TaskStatus,
    temporalWorkflowId: row.temporal_workflow_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCheckpoint(row: CheckpointRow): HumanCheckpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind as HumanCheckpoint["kind"],
    status: row.status as HumanCheckpoint["status"],
    prompt: row.prompt,
    choices: JSON.parse(row.choices_json) as HumanCheckpoint["choices"],
    version: row.version,
  };
}

/**
 * Everything needed to (re-)deliver one committed checkpoint answer to its
 * workflow, without consulting anything else. `signalled` is the recovery
 * signal: false means the answer is committed but the workflow has never been
 * told, which is unfinished work rather than a conflict.
 */
/**
 * Why a checkpoint row carries a `signalled_at` (migration 0007). `'backfill'`
 * is written only by migrations; code writes the other two.
 */
export type CheckpointSignalSource = "backfill" | "signal" | "discarded";

export type CheckpointDelivery = {
  checkpointId: string;
  taskId: TaskId;
  workspaceId: WorkspaceId;
  status: HumanCheckpoint["status"];
  version: number;
  signalled: boolean;
  text?: string;
};

function toDelivery(row: CheckpointDeliveryRow): CheckpointDelivery {
  // answer_json is whatever the resolving caller stored; only `text` is read
  // back, and a row written by an older build may not have it at all.
  let text: string | undefined;
  if (row.answer_json !== null) {
    try {
      const parsed = JSON.parse(row.answer_json) as unknown;
      if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
        const candidate = (parsed as { text?: unknown }).text;
        if (typeof candidate === "string") text = candidate;
      }
    } catch {
      text = undefined;
    }
  }
  return {
    checkpointId: row.id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    status: row.status as HumanCheckpoint["status"],
    version: row.version,
    signalled: row.signalled_at !== null,
    ...(text === undefined ? {} : { text }),
  };
}

export type CreateTaskInput = {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  conversationId?: string;
  parentTaskId?: string;
  origin: Task["origin"];
  pipeline: Task["pipeline"];
  title: string;
  intent: Task["intent"];
  temporalWorkflowId: string;
  now: number;
};

/** Raised when a version-guarded checkpoint write lost its race. */
export class CheckpointConflictError extends Error {
  override readonly name = "CheckpointConflictError";

  constructor(
    readonly checkpointId: string,
    readonly expectedVersion: number,
    readonly currentVersion: number | undefined,
    readonly currentStatus: string | undefined,
  ) {
    super(
      currentVersion === undefined
        ? `checkpoint ${checkpointId} does not exist`
        : `checkpoint ${checkpointId} expected version ${expectedVersion} but is at ${currentVersion} (${currentStatus ?? "unknown"})`,
    );
  }
}

export function isCheckpointConflict(error: unknown): error is CheckpointConflictError {
  return error instanceof CheckpointConflictError;
}

/**
 * Raised when a write reaches the repository from inside an open transaction
 * span through anything other than that transaction's own handle.
 *
 * There are only three things the repository could do with such a write, and
 * two of them are wrong:
 *
 *  - inline it into the open `BEGIN IMMEDIATE ... COMMIT` span. That is the
 *    original defect: an unrelated component's write silently joins someone
 *    else's transaction and is destroyed by its ROLLBACK.
 *  - put it on the serial write queue. The queue slot is held by the open
 *    transaction, so the write cannot run until the transaction finishes; if
 *    the transaction is awaiting it (the normal shape for a callee), the
 *    daemon deadlocks permanently — `BEGIN IMMEDIATE` never closes and
 *    `drain()` never returns.
 *  - refuse it, loudly. That is what the repository does.
 */
export class TransactionScopeError extends Error {
  override readonly name = "TransactionScopeError";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * How the body of a `transaction()` call issues its statements.
 *
 * - `"scoped"` — the body declared the `tx` parameter, so it can and must use
 *   the handle. Ambient repository calls from inside the span are refused, and
 *   that refusal is what keeps a *callee* invoked from the body (which shares
 *   the body's async context and so is invisible to AsyncLocalStorage) from
 *   silently joining the transaction.
 * - `"ambient"` — **deprecated**. The body declared no parameter, so it cannot
 *   possibly use the handle; its plain `repository.*` calls are inlined into
 *   the span. This mode cannot distinguish the body from a callee, so a callee
 *   invoked from an ambient body still joins the transaction. It exists only
 *   so the pre-existing `TaskRepositoryPort.transaction(fn: () => Promise<T>)`
 *   callers keep working until the port grows a handle parameter; see the
 *   migration note on {@link SqliteTaskRepository.transaction}.
 */
type TransactionMode = "scoped" | "ambient";

/**
 * Identifies one open `BEGIN IMMEDIATE ... COMMIT` span. Held in an
 * AsyncLocalStorage so unrelated concurrent contexts cannot join it — but
 * async context alone is not enough, because a callee invoked from the body
 * *inherits* that context. `handleDepth` is the missing signal: it is non-zero
 * only while a statement issued through this span's own `TransactionScope` is
 * executing, which no callee can fake without being handed the handle.
 */
type TransactionState = {
  readonly repo: SqliteTaskRepository;
  readonly queue: SerialWriteQueue;
  readonly mode: TransactionMode;
  scope: TransactionScope | undefined;
  open: boolean;
  handleDepth: number;
};

const transactionContext = new AsyncLocalStorage<TransactionState>();

/** The open span visible to the calling async context, if any. */
function openSpan(): TransactionState | undefined {
  const state = transactionContext.getStore();
  // A settled span is a stale inheritance (a `.then`/`setTimeout` continuation
  // registered inside the body). It is not an open transaction, and treating it
  // as one is what made those continuations permanently unwritable.
  return state !== undefined && state.open ? state : undefined;
}

/**
 * SQLite-backed TaskRepositoryPort. Every mutation goes through the daemon's
 * single serial write queue; reads run directly on the same connection.
 */
export class SqliteTaskRepository implements TaskRepositoryPort {
  constructor(
    readonly db: MeidoyaDatabase,
    private readonly queue: SerialWriteQueue,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The single decision point for every mutation. Exactly one of three things
   * happens, and none of them is "silently join someone else's transaction":
   *
   *  1. No open span on this repository's queue is visible → the write goes on
   *     the serial queue and therefore runs strictly after any transaction
   *     currently holding the slot. This covers unrelated concurrent contexts
   *     *and* continuations that were registered inside a transaction body but
   *     only fire after it settled (their inherited context is stale, not open).
   *  2. The write is issued through this span's own `TransactionScope`, or the
   *     span is a deprecated `"ambient"` one → inline, inside BEGIN/COMMIT.
   *  3. Anything else — a callee invoked from the body, a second repository
   *     sharing the queue → `TransactionScopeError`. See that class for why
   *     both alternatives (inline, enqueue) are unacceptable.
   */
  #write<T>(fn: () => T): Promise<T> {
    const span = openSpan();
    // A span on a *different* queue cannot deadlock this one and cannot roll
    // this write back, so it is simply not our business.
    if (span === undefined || span.queue !== this.queue) return this.queue.enqueue(fn);

    if (span.repo === this && (span.handleDepth > 0 || span.mode === "ambient")) {
      try {
        return Promise.resolve(fn());
      } catch (error) {
        return Promise.reject(asError(error));
      }
    }

    return Promise.reject(
      new TransactionScopeError(
        span.repo === this
          ? "write issued from inside an open transaction without its handle: " +
            "use the `tx` handle passed to transaction(), or issue the write from " +
            "outside the transaction body"
          : "write issued from inside another repository's open transaction on the " +
            "same serial write queue: inlining it would let someone else's ROLLBACK " +
            "discard it, and queueing it would deadlock the queue",
      ),
    );
  }

  /**
   * Guarded access to the serial write queue for components that hold a raw
   * `runWrite`-style callback rather than this repository (the chat gateway and
   * the notification outbox publisher are wired that way).
   *
   * Calling `queue.enqueue` directly from inside an open transaction is a
   * permanent, whole-daemon deadlock: the slot is held by the transaction, the
   * transaction is waiting on the enqueued job, `BEGIN IMMEDIATE` never closes
   * and `drain()` never returns. Routing those callbacks through here turns
   * that into an immediate, explicit rejection.
   */
  runWrite<T>(fn: () => T | Promise<T>): Promise<T> {
    const span = openSpan();
    if (span !== undefined && span.queue === this.queue) {
      return Promise.reject(
        new TransactionScopeError(
          "write enqueued on the serial write queue from inside an open transaction: " +
            "this would deadlock the queue permanently",
        ),
      );
    }
    return this.queue.enqueue(fn);
  }

  /**
   * better-sqlite3 transactions cannot wrap an async function, so BEGIN/COMMIT
   * are issued explicitly. The whole span occupies one write-queue slot, so
   * nothing unrelated executes between BEGIN and COMMIT.
   *
   * The arity of `fn` selects the mode (see {@link TransactionMode}): a body
   * that declares the `tx` parameter gets the safe, handle-only semantics; a
   * body that declares no parameter cannot use the handle and therefore gets
   * the deprecated ambient semantics.
   *
   * MIGRATION: `TaskRepositoryPort.transaction` still types `fn` as
   * `() => Promise<T>`, so port-typed callers cannot declare the parameter and
   * are stuck on the ambient mode. Widening the port to
   * `transaction<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T>` and
   * routing each body's writes through `tx` moves them onto the safe mode with
   * no behavioural change other than the one that matters: a callee invoked
   * from the body can no longer be rolled back with it.
   */
  async transaction<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
    const mode: TransactionMode = fn.length === 0 ? "ambient" : "scoped";
    const outer = openSpan();
    if (outer !== undefined && outer.queue === this.queue) {
      // SQLite has no real nesting here, so an inner transaction can only join
      // the outer one — which means everything it writes shares the outer
      // ROLLBACK. That is acceptable only when the outer span deliberately
      // opted into ambient semantics on this same repository.
      if (outer.repo !== this || outer.mode !== "ambient") {
        throw new TransactionScopeError(
          "transaction() called from inside an open transaction: the inner body " +
            "would share the outer BEGIN/COMMIT span and be destroyed by its " +
            "ROLLBACK. Use the enclosing transaction's handle instead.",
        );
      }
      const scope = outer.scope;
      if (scope === undefined) throw new TransactionScopeError("transaction scope is unavailable");
      return fn(scope);
    }
    return this.queue.enqueue(() => {
      const state: TransactionState = {
        repo: this,
        queue: this.queue,
        mode,
        scope: undefined,
        open: true,
        handleDepth: 0,
      };
      const scope = new TransactionScope(this, state);
      state.scope = scope;
      return transactionContext.run(state, async () => {
        try {
          this.db.exec("BEGIN IMMEDIATE");
          const result = await fn(scope);
          state.open = false;
          this.db.exec("COMMIT");
          return result;
        } catch (error) {
          state.open = false;
          // Both halves of this matter, and both used to be wrong.
          //
          // `BEGIN IMMEDIATE` is now inside the try, so a BEGIN that fails
          // (SQLITE_BUSY against another writer) does not leave the span
          // half-entered; and the ROLLBACK is CONDITIONAL, because SQLite
          // rolls back on its own for some errors and a COMMIT can fail with
          // the transaction already closed. Rolling back unconditionally threw
          // "cannot rollback - no transaction is active" from the catch block,
          // which replaced the real error with a misleading one and, when the
          // failure was a COMMIT, could leave this queue slot wedged for the
          // life of the process. The rollback's own failure is swallowed on
          // purpose: the caller is owed the error that started this.
          if (this.db.inTransaction) {
            try {
              this.db.exec("ROLLBACK");
            } catch {
              // Nothing left to undo, or the connection is past saving. Either
              // way the original error below is the one worth reporting.
            }
          }
          throw error;
        }
      });
    });
  }

  /* ------------------------------------------------------------ tasks */

  createTask(input: CreateTaskInput): Promise<Task> {
    return this.#write(() => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, workspace_id, conversation_id, parent_task_id, origin,
              pipeline, title, intent_json, status, temporal_workflow_id, version,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, 0, ?, ?)`,
        )
        .run(
          input.taskId,
          input.workspaceId,
          input.conversationId ?? null,
          input.parentTaskId ?? null,
          input.origin,
          input.pipeline,
          input.title,
          JSON.stringify(input.intent),
          input.temporalWorkflowId,
          input.now,
          input.now,
        );
      const task = this.loadTaskSync(input.taskId);
      if (!task) throw new Error(`task ${input.taskId} vanished after insert`);
      return task;
    });
  }

  loadTaskSync(taskId: TaskId): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  loadTask(taskId: TaskId): Task | undefined {
    return this.loadTaskSync(taskId);
  }

  listTasks(workspaceId: WorkspaceId, options: { status?: string[]; limit: number }): Task[] {
    const statuses = options.status ?? [];
    const sql =
      statuses.length === 0
        ? "SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?"
        : `SELECT * FROM tasks WHERE workspace_id = ? AND status IN (${statuses
            .map(() => "?")
            .join(",")}) ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = this.db
      .prepare(sql)
      .all(workspaceId, ...statuses, options.limit) as TaskRow[];
    return rows.map(toTask);
  }

  updateTaskStatus(args: {
    taskId: TaskId;
    nextStatus: TaskStatus;
    expectedVersion: number;
    pipeline?: Task["pipeline"];
  }): Promise<boolean> {
    return this.#write(() => {
      const now = this.now();
      const result =
        args.pipeline === undefined
          ? this.db
              .prepare(
                "UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
              )
              .run(args.nextStatus, now, args.taskId, args.expectedVersion)
          : this.db
              .prepare(
                "UPDATE tasks SET status = ?, pipeline = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
              )
              .run(args.nextStatus, args.pipeline, now, args.taskId, args.expectedVersion);
      return result.changes === 1;
    });
  }

  /** Used by cancel: the caller has no reliable view of the current version. */
  forceTaskStatus(taskId: TaskId, status: TaskStatus): Promise<boolean> {
    return this.#write(() => {
      const result = this.db
        .prepare(
          "UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(status, this.now(), taskId);
      return result.changes === 1;
    });
  }

  appendTaskEvent(args: {
    taskId: TaskId;
    eventType: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    return this.#write(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO task_events (id, task_id, event_type, idempotency_key, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `evt_${args.idempotencyKey}`,
          args.taskId,
          args.eventType,
          args.idempotencyKey,
          JSON.stringify(args.payload),
          this.now(),
        );
    });
  }

  listTaskEvents(taskId: TaskId): { eventType: string; payload: unknown; createdAt: number }[] {
    const rows = this.db
      .prepare(
        "SELECT event_type, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(taskId) as { event_type: string; payload_json: string; created_at: number }[];
    return rows.map((r) => ({
      eventType: r.event_type,
      payload: JSON.parse(r.payload_json) as unknown,
      createdAt: r.created_at,
    }));
  }

  /* ------------------------------------------------------------ steps */

  upsertStep(step: Omit<StepRecord, "id" | "version"> & { id?: string }): Promise<StepRecord> {
    return this.#write(() => {
      const id = step.id ?? `${step.taskId}:${step.stepKey}`;
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO task_steps (id, task_id, step_key, step_kind, status, visit_count,
              attempt_count, input_json, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?)
           ON CONFLICT(task_id, step_key) DO UPDATE SET
             status = excluded.status,
             visit_count = excluded.visit_count,
             attempt_count = excluded.attempt_count,
             version = task_steps.version + 1,
             updated_at = excluded.updated_at`,
        )
        .run(
          id,
          step.taskId,
          step.stepKey,
          step.stepKind,
          step.status,
          step.visitCount,
          step.attemptCount,
          now,
          now,
        );
      const found = this.listStepsSync(step.taskId).find((s) => s.stepKey === step.stepKey);
      if (!found) throw new Error(`step ${step.stepKey} vanished after upsert`);
      return found;
    });
  }

  listStepsSync(taskId: TaskId): StepRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_key ASC")
      .all(taskId) as {
      id: string;
      task_id: string;
      step_key: string;
      step_kind: string;
      status: string;
      visit_count: number;
      attempt_count: number;
      version: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      stepKey: r.step_key,
      stepKind: r.step_kind,
      status: r.status as StepRecord["status"],
      visitCount: r.visit_count,
      attemptCount: r.attempt_count,
      version: r.version,
    }));
  }

  listSteps(taskId: TaskId): StepRecord[] {
    return this.listStepsSync(taskId);
  }

  /* ------------------------------------------------------- checkpoints */

  recordCheckpoint(checkpoint: HumanCheckpoint): Promise<void> {
    return this.#write(() => {
      this.db
        .prepare(
          `INSERT INTO checkpoints (id, task_id, kind, status, prompt, choices_json, version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             prompt = excluded.prompt,
             choices_json = excluded.choices_json,
             version = excluded.version`,
        )
        .run(
          checkpoint.id,
          checkpoint.taskId,
          checkpoint.kind,
          checkpoint.status,
          checkpoint.prompt,
          JSON.stringify(checkpoint.choices),
          checkpoint.version,
          this.now(),
        );
    });
  }

  loadCheckpointSync(id: string): HumanCheckpoint | undefined {
    const row = this.db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as
      | CheckpointRow
      | undefined;
    return row === undefined ? undefined : toCheckpoint(row);
  }

  loadCheckpoint(id: string): HumanCheckpoint | undefined {
    return this.loadCheckpointSync(id);
  }

  openCheckpointFor(taskId: TaskId): HumanCheckpoint | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM checkpoints WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      )
      .get(taskId) as CheckpointRow | undefined;
    return row === undefined ? undefined : toCheckpoint(row);
  }

  /**
   * 08 section 9: compare-and-swap on the checkpoint version. `next` is the
   * post-transition checkpoint, so the row must still be at `next.version - 1`
   * (override with `expectedVersion` if the caller knows better). Losing the
   * race throws `CheckpointConflictError` — the caller must not go on to signal
   * the workflow.
   */
  resolveCheckpoint(
    next: HumanCheckpoint,
    answer: unknown,
    options: { expectedVersion?: number } = {},
  ): Promise<void> {
    const expectedVersion = options.expectedVersion ?? next.version - 1;
    return this.#write(() => {
      const result = this.db
        .prepare(
          `UPDATE checkpoints SET status = ?, version = version + 1, answer_json = ?, answered_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(next.status, JSON.stringify(answer), this.now(), next.id, expectedVersion);
      if (result.changes !== 1) {
        const current = this.loadCheckpointSync(next.id);
        throw new CheckpointConflictError(
          next.id,
          expectedVersion,
          current?.version,
          current?.status,
        );
      }
    });
  }

  /**
   * The delivery view of one checkpoint: its committed answer plus whether the
   * workflow signal for it has landed. Joined to `tasks` so a reconciliation
   * pass, which has no caller scope to work from, still knows the workspace the
   * resulting event belongs to.
   */
  loadCheckpointDeliverySync(id: string): CheckpointDelivery | undefined {
    const row = this.db
      .prepare(
        `SELECT c.id, c.task_id, t.workspace_id, c.status, c.version, c.answer_json, c.signalled_at
           FROM checkpoints c JOIN tasks t ON t.id = c.task_id
          WHERE c.id = ?`,
      )
      .get(id) as CheckpointDeliveryRow | undefined;
    return row === undefined ? undefined : toDelivery(row);
  }

  /**
   * The one committed-but-undelivered answer a given task is wedged on, if any.
   *
   * `task.answer` needs it: a task in that state has no OPEN checkpoint, so the
   * only thing an operator's answer can usefully do is finish the delivery that
   * was interrupted. Newest first, matching `openCheckpointFor`.
   */
  latestUndeliveredCheckpointFor(taskId: TaskId): CheckpointDelivery | undefined {
    const row = this.db
      .prepare(
        `SELECT c.id, c.task_id, t.workspace_id, c.status, c.version, c.answer_json, c.signalled_at
           FROM checkpoints c JOIN tasks t ON t.id = c.task_id
          WHERE c.task_id = ? AND c.signalled_at IS NULL AND c.status != 'pending'
          ORDER BY c.answered_at DESC, c.id DESC
          LIMIT 1`,
      )
      .get(taskId) as CheckpointDeliveryRow | undefined;
    return row === undefined ? undefined : toDelivery(row);
  }

  /**
   * The reconciliation backlog: answers that were committed but whose signal
   * never reached the workflow. Oldest first — a task parked on an undelivered
   * answer is holding its budget open, so the longest-wedged one is repaired
   * first.
   */
  listUndeliveredCheckpoints(limit = 100): CheckpointDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.task_id, t.workspace_id, c.status, c.version, c.answer_json, c.signalled_at
           FROM checkpoints c JOIN tasks t ON t.id = c.task_id
          WHERE c.signalled_at IS NULL AND c.status != 'pending'
          ORDER BY c.answered_at ASC, c.id ASC
          LIMIT ?`,
      )
      .all(limit) as CheckpointDeliveryRow[];
    return rows.map(toDelivery);
  }

  /**
   * The size of the whole reconciliation backlog, not just the window a sweep
   * scanned. `listUndeliveredCheckpoints` is capped, so a queue larger than the
   * cap looks identical to a full one from the sweep's own counters; this is
   * what makes "not draining" observable. Served by the partial index migration
   * 0005 creates, so it stays the size of the backlog (normally zero).
   */
  countUndeliveredCheckpoints(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM checkpoints WHERE signalled_at IS NULL AND status != 'pending'",
      )
      .get() as { n: number };
    return row.n;
  }

  /**
   * Records that the committed answer reached the workflow. Deliberately *not*
   * version-guarded and deliberately not a version bump: it is a one-way latch
   * on a row whose answer is already final, so running it twice (two retries,
   * a retry racing the sweep) is a no-op rather than a lost update, and it
   * cannot disturb the compare-and-swap that guards the answer itself.
   *
   * Returns true only for the call that actually flipped the latch.
   *
   * `by` records WHY the row is latched (migration 0007): `'signal'` means the
   * workflow received the answer, `'discarded'` means the reconciliation sweep
   * gave up on a workflow it corroborated as gone and the answer was never
   * delivered. A migration's own inferred latch is `'backfill'`. Keeping the
   * three apart is what lets a later repair use a stored fact instead of the
   * value comparison that made 0006 re-open genuinely delivered rows.
   */
  markCheckpointSignalled(id: string, by: CheckpointSignalSource = "signal"): Promise<boolean> {
    return this.#write(() => {
      const result = this.db
        .prepare(
          "UPDATE checkpoints SET signalled_at = ?, signalled_by = ? WHERE id = ? AND signalled_at IS NULL",
        )
        .run(this.now(), by, id);
      return result.changes === 1;
    });
  }

  /* --------------------------------------------------------- artifacts */

  saveArtifacts(taskId: TaskId, artifacts: ArtifactRef[]): Promise<void> {
    return this.#write(() => {
      const task = this.loadTaskSync(taskId);
      if (!task) return;
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO artifacts (id, workspace_id, task_id, kind, path, sha256, visibility, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'summary', ?)`,
      );
      for (const artifact of artifacts) {
        stmt.run(
          artifact.artifactId,
          task.workspaceId,
          taskId,
          artifact.kind,
          artifact.path,
          artifact.sha256,
          this.now(),
        );
      }
    });
  }

  listArtifacts(taskId: TaskId): ArtifactRef[] {
    const rows = this.db
      .prepare("SELECT id, kind, path, sha256 FROM artifacts WHERE task_id = ? ORDER BY id ASC")
      .all(taskId) as { id: string; kind: string; path: string; sha256: string }[];
    return rows.map((r) => ({
      artifactId: r.id,
      kind: r.kind,
      path: r.path,
      sha256: r.sha256,
    }));
  }

  /* ----------------------------------------------------------- outbox */

  enqueueNotification(intent: OutboxIntent): Promise<void> {
    return this.#write(() => {
      insertIntents(
        this.db,
        [
          {
            action: intent.action,
            idempotencyKey: intent.idempotencyKey,
            eventId: intent.eventId,
            workspaceId: intent.workspaceId,
            ...(intent.conversationId === undefined
              ? {}
              : { conversationId: intent.conversationId }),
            payload: intent.payload,
          },
        ],
        { now: this.now() },
      );
    });
  }
}

/**
 * Transaction-scoped handle passed to `SqliteTaskRepository.transaction`.
 *
 * Holding this object is what proves a caller is the transaction's own body
 * rather than something the body happened to call: async context cannot make
 * that distinction, because a callee inherits the body's context. Every write
 * here raises `handleDepth` for the duration of the underlying statement, and
 * `#write` inlines a statement into a `"scoped"` span only while that depth is
 * non-zero. Using the handle after the transaction settled throws instead of
 * silently writing outside the span.
 */
export class TransactionScope {
  constructor(
    private readonly repo: SqliteTaskRepository,
    private readonly state: { open: boolean; handleDepth: number },
  ) {}

  /**
   * Repository write methods call `#write` — and therefore the statement
   * itself — synchronously, so the depth is back to zero by the time the
   * returned promise is handed out. A continuation of that promise is *not*
   * covered, which is exactly right: it is no longer the handle talking.
   */
  #issue<T>(op: () => T): T {
    if (!this.state.open) throw new TransactionScopeError("transaction has already been settled");
    this.state.handleDepth += 1;
    try {
      return op();
    } finally {
      this.state.handleDepth -= 1;
    }
  }

  #assertOpen(): void {
    if (!this.state.open) throw new TransactionScopeError("transaction has already been settled");
  }

  /** Raw connection, for statements the repository has no method for. */
  get db(): MeidoyaDatabase {
    this.#assertOpen();
    return this.repo.db;
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    return this.#issue(() => this.repo.createTask(input));
  }

  updateTaskStatus(args: Parameters<SqliteTaskRepository["updateTaskStatus"]>[0]): Promise<boolean> {
    return this.#issue(() => this.repo.updateTaskStatus(args));
  }

  forceTaskStatus(taskId: TaskId, status: TaskStatus): Promise<boolean> {
    return this.#issue(() => this.repo.forceTaskStatus(taskId, status));
  }

  appendTaskEvent(args: Parameters<SqliteTaskRepository["appendTaskEvent"]>[0]): Promise<void> {
    return this.#issue(() => this.repo.appendTaskEvent(args));
  }

  upsertStep(step: Parameters<SqliteTaskRepository["upsertStep"]>[0]): Promise<StepRecord> {
    return this.#issue(() => this.repo.upsertStep(step));
  }

  recordCheckpoint(checkpoint: HumanCheckpoint): Promise<void> {
    return this.#issue(() => this.repo.recordCheckpoint(checkpoint));
  }

  resolveCheckpoint(
    next: HumanCheckpoint,
    answer: unknown,
    options?: { expectedVersion?: number },
  ): Promise<void> {
    return this.#issue(() => this.repo.resolveCheckpoint(next, answer, options ?? {}));
  }

  /**
   * `by` is forwarded, not dropped. Forwarding only the id silently recorded
   * every latch made through a transaction as `'signal'` — "the workflow heard
   * the answer" — including the give-up path's, which is the record of an
   * answer that was THROWN AWAY. That is exactly the damage migration 0006 did
   * from the other direction, and a signature that omitted the parameter gave
   * no warning at all.
   */
  markCheckpointSignalled(id: string, by?: CheckpointSignalSource): Promise<boolean> {
    return this.#issue(() =>
      by === undefined
        ? this.repo.markCheckpointSignalled(id)
        : this.repo.markCheckpointSignalled(id, by),
    );
  }

  saveArtifacts(taskId: TaskId, artifacts: ArtifactRef[]): Promise<void> {
    return this.#issue(() => this.repo.saveArtifacts(taskId, artifacts));
  }

  enqueueNotification(intent: OutboxIntent): Promise<void> {
    return this.#issue(() => this.repo.enqueueNotification(intent));
  }

  loadTask(taskId: TaskId): Task | undefined {
    this.#assertOpen();
    return this.repo.loadTaskSync(taskId);
  }

  loadCheckpoint(id: string): HumanCheckpoint | undefined {
    this.#assertOpen();
    return this.repo.loadCheckpointSync(id);
  }

  loadCheckpointDelivery(id: string): CheckpointDelivery | undefined {
    this.#assertOpen();
    return this.repo.loadCheckpointDeliverySync(id);
  }

  listSteps(taskId: TaskId): StepRecord[] {
    this.#assertOpen();
    return this.repo.listStepsSync(taskId);
  }
}

/* ---------------------------------------------------------------- seed */

/**
 * Projects the operator's config into the reference tables. Config is the
 * source of truth for identity; nothing here can be written by an agent.
 */
export function seedFromConfig(
  db: MeidoyaDatabase,
  config: ResolvedControlPlaneConfig,
  now: number = Date.now(),
): void {
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO environments (id, timezone, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone, updated_at = excluded.updated_at`,
    ).run(config.environmentId, config.timezone, now, now);

    for (const workspace of config.workspaces) {
      db.prepare(
        `INSERT INTO workspaces (id, environment_id, kind, display_name, status, policy_json, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           display_name = excluded.display_name,
           policy_json = excluded.policy_json,
           version = workspaces.version + 1,
           updated_at = excluded.updated_at`,
      ).run(
        workspace.workspaceId,
        config.environmentId,
        workspace.kind,
        workspace.displayName,
        JSON.stringify(workspace.policy),
        now,
        now,
      );

      for (const projectId of workspace.projects) {
        db.prepare(
          `INSERT OR IGNORE INTO projects (id, workspace_id, display_name, workspace_ref, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(`${workspace.workspaceId}/${projectId}`, workspace.workspaceId, projectId, projectId, now);
      }
    }

    for (const binding of config.ingressBindings) {
      db.prepare(
        `INSERT INTO ingress_bindings (id, workspace_id, source, account_ref, channel_ref, profile_ref, scope_lock, enabled)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           account_ref = excluded.account_ref,
           channel_ref = excluded.channel_ref,
           profile_ref = excluded.profile_ref,
           enabled = excluded.enabled`,
      ).run(
        binding.id,
        binding.workspaceId,
        binding.source,
        binding.accountRef,
        binding.channelRef,
        binding.profileRef,
        binding.enabled ? 1 : 0,
      );
    }

    if (config.headMaid !== undefined) {
      db.prepare("UPDATE delegation_grants SET enabled = 0 WHERE source_workspace_id = ?").run(
        config.headMaid.workspaceId,
      );
      for (const [targetWorkspaceId, capabilities] of Object.entries(
        config.headMaid.enabled ? config.headMaid.grants : {},
      )) {
        if (capabilities.length === 0) continue;
        db.prepare(
          `INSERT INTO delegation_grants
             (id, source_workspace_id, target_workspace_id, capabilities_json, enabled, created_at)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(source_workspace_id, target_workspace_id) DO UPDATE SET
             capabilities_json = excluded.capabilities_json,
             enabled = 1`,
        ).run(
          `delegation/${config.headMaid.workspaceId}/${targetWorkspaceId}`,
          config.headMaid.workspaceId,
          targetWorkspaceId,
          JSON.stringify(capabilities),
          now,
        );
      }
    }
  });
  run();
}
