import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import type { DomainEvent, WorkspacePolicy } from "@meidoya/domain";
import type {
  ArtifactProbePort,
  BudgetCharge,
  BudgetDecision,
  BudgetExtension,
  CheckpointPolicyDecision,
  CheckpointPolicyPort,
  CheckpointPolicyQuery,
  ClockPort,
  ExecutionBudgetPort,
  IdPort,
  InteractionPolicyPort,
  OutboxIntent,
} from "@meidoya/task-engine";
import {
  BudgetLedger,
  LIMIT_EXCEEDED_CHOICES,
  type BudgetLedgerState,
  type StepKind,
} from "@meidoya/execution-budget";
import {
  resolveGate,
  type GateKind,
  type GateOverrides,
  type LayeredGatePolicy,
} from "@meidoya/checkpoint-policy";
import {
  decideOutboxIntents,
  resolveInteractionConfig,
  type InteractionConfig,
} from "@meidoya/interaction-policy";
import { toOutboxIntentInput } from "@meidoya/notification-outbox";
import type { ControlEventBus } from "./events.js";

/* ------------------------------------------------------- checkpoint policy */

const GATE_OF_KIND: Readonly<Record<string, GateKind | undefined>> = {
  clarification: "clarification",
  "plan-approval": "plan",
  "review-approval": "review",
  "side-effect-approval": "side-effect",
  "limit-exceeded": undefined,
};

const APPROVE_CHOICES = [
  { id: "approve", label: "Approve" },
  { id: "add-instruction", label: "Add instruction" },
  { id: "cancel", label: "Cancel" },
];

/**
 * A workspace's gate configuration: the workspace policy plus the mandatory
 * security floor the operator configured for it. 06 section 2: a lower layer
 * may raise a gate but never relax the mandatory one.
 */
export type WorkspaceGatePolicy = {
  policy: WorkspacePolicy;
  mandatoryGates?: GateOverrides;
};

/**
 * Resolves the human gate for one checkpoint request against the workspace
 * policy. The gate decision is control-plane data; an agent can request a
 * checkpoint but can never waive one.
 *
 * Every unknown fails CLOSED: an unknown workspace, an unknown risk under
 * `on-risk`, an unknown findings state under `on-findings`. A missing fact is
 * not permission to skip a human.
 */
export function createCheckpointPolicyPort(
  policyOf: (workspaceId: string) => WorkspaceGatePolicy | undefined,
): CheckpointPolicyPort {
  return {
    evaluate(query: CheckpointPolicyQuery): CheckpointPolicyDecision {
      const prompt = (detail: string): CheckpointPolicyDecision => ({
        required: true,
        prompt: detail,
        choices: APPROVE_CHOICES,
      });

      // A limit checkpoint is never optional: it exists because a budget blew.
      // 06 section 8 fixes its choices, extension included.
      if (query.kind === "limit-exceeded") {
        return {
          required: true,
          prompt: "Task paused: an execution limit was reached.",
          choices: LIMIT_EXCEEDED_CHOICES.map((choice) => ({ ...choice })),
        };
      }

      const configured = policyOf(query.workspaceId);
      if (configured === undefined) {
        // Fail closed: without a policy we cannot know a gate is unnecessary.
        return prompt(
          `Task ${query.taskId} is waiting for ${query.kind.replace(/-/g, " ")}` +
            " (no policy is configured for its workspace).",
        );
      }
      const policy = configured.policy;

      const mandatory: GateOverrides = {
        ...configured.mandatoryGates,
        // A security-mandated request raises the floor for this one checkpoint.
        ...(query.securityMandated === true
          ? { plan: "always" as const, review: "always" as const, "side-effect": "always" as const }
          : {}),
      };

      const layered: LayeredGatePolicy = {
        environmentDefault: {
          clarification: policy.humanGates.clarification,
          plan: policy.humanGates.plan,
          review: policy.humanGates.review,
          "side-effect": policy.humanGates.sideEffect,
        },
        ...(Object.keys(mandatory).length > 0 ? { mandatorySecurity: mandatory } : {}),
      };

      const gateKind = GATE_OF_KIND[query.kind];
      if (gateKind === undefined) return { required: false };
      const gate = resolveGate(gateKind, layered);

      const required = ((): boolean => {
        switch (gate.kind) {
          case "clarification":
            // `when-needed` exists only when someone asked for it; the Manager
            // asks, the control plane decides whether the ask is honoured.
            return (
              gate.mode === "always" ||
              (gate.mode === "when-needed" && query.requested === true)
            );
          case "plan":
            // 06 section 1.2: `on-risk` covers every risk above low, and an
            // unstated risk is treated as risky.
            return gate.mode === "always" || (gate.mode === "on-risk" && query.risk !== "low");
          case "review":
            return (
              gate.mode === "always" ||
              gate.mode === "before-complete" ||
              (gate.mode === "on-findings" && query.hasFindings !== false)
            );
          case "side-effect":
            // `policy` means: only when a security policy demands it. The floor
            // above has already turned such a demand into `always`.
            return gate.mode === "always";
        }
      })();

      if (!required) return { required: false };
      return prompt(`Task ${query.taskId} is waiting for ${query.kind.replace(/-/g, " ")}.`);
    },
  };
}

/* ------------------------------------------------------- execution budget */

const STEP_KIND_OF_CHARGE: Readonly<Record<BudgetCharge["kind"], StepKind | undefined>> = {
  "agent-run": "agent-run",
  "verification-group": "verification-group",
  "review-group": "review-group",
  "manager-replan": "manager-replan",
  // Rounds are loop guards, not steps; they have their own counters.
  "fix-round": undefined,
  "review-round": undefined,
};

/**
 * Where a root budget survives a daemon restart. 06 section 4 makes `max_steps`
 * a ROOT budget; a process restart that forgot the spent total would mint a
 * fresh one, so the ledger is written back after every charge.
 */
export type BudgetStateStore = {
  load(rootTaskId: string): BudgetLedgerState | undefined;
  save(rootTaskId: string, state: BudgetLedgerState): void | Promise<void>;
};

export type ExecutionBudgetPortOptions = {
  /** Workspace policy of a task; supplies the limits. */
  policyOf: (taskId: string) => WorkspacePolicy | undefined;
  /**
   * Maps any task to the ROOT task that owns its budget. Child tasks and
   * subworkflows charge the root, so splitting work cannot mint budget.
   */
  rootOf?: (taskId: string) => string;
  store?: BudgetStateStore;
  startedAt?: () => number;
  now?: () => number;
  /**
   * How many root ledgers stay resident. The cache is a cache: every mutation
   * is written through to `store` before it is acknowledged, so an evicted
   * ledger is reconstructed from the persisted snapshot on next use with the
   * spent total intact. A ledger whose write-through is still IN FLIGHT is ahead
   * of its snapshot and is retained regardless of this bound — see
   * `createExecutionBudgetPort` — so the resident set can briefly exceed it, by
   * at most the number of persists in flight.
   *
   * Ignored when no `store` is configured — see `maxResidentLedgers` in
   * `createExecutionBudgetPort` for why evicting then would MINT budget.
   */
  maxResidentLedgers?: number;
};

/**
 * Resident-ledger ceiling. High enough that a normal daemon never evicts a
 * ledger it is still charging, low enough that the map cannot grow with the
 * number of root tasks the process has ever seen.
 */
const DEFAULT_MAX_RESIDENT_LEDGERS = 512;

/** One ledger per root task; children get no budget of their own (06 section 5). */
export function createExecutionBudgetPort(
  options: ExecutionBudgetPortOptions,
): ExecutionBudgetPort {
  const rootOf = options.rootOf ?? ((taskId: string): string => taskId);
  const startedAt = options.startedAt ?? ((): number => Date.now());
  const now = options.now ?? ((): number => Date.now());
  const store = options.store;

  /** A resident ledger plus the limits it was built with, for rollback. */
  type Resident = { ledger: BudgetLedger; limits: WorkspacePolicy["limits"] };

  /**
   * Resident ledgers, in least-recently-used order (a `Map` iterates in
   * insertion order, so re-inserting on every touch makes the first key the
   * coldest). This used to be an unbounded map on a process that runs for
   * weeks: one entry per root task it had ever charged, never released.
   *
   * Eviction is only correct while the persisted snapshot is NOT BEHIND the
   * resident ledger, and "write through on every mutating path" does not by
   * itself buy that: a charge mutates the ledger synchronously and only then
   * suspends on `store.save`, so for the whole duration of that await the
   * resident ledger is ahead of the snapshot. Evicting in that window and
   * reloading afterwards resurrects the PRE-charge snapshot and mints the
   * charge back — and concurrent charges on one root are the normal case, not
   * an exotic one: 06 section 5 has child tasks and subworkflows charge the
   * ROOT, and `db.chargeBudget` is a Temporal activity served concurrently.
   *
   * There is therefore exactly ONE reason a ledger may be ahead of its
   * snapshot, and exactly one mechanism that protects it:
   *
   *   * `pins`: a persist is in flight. Refcounted, because a persist for one
   *     root can overlap a persist for another; the last one out unpins. A
   *     pinned root is RETAINED — skipped by eviction, never merely
   *     deprioritised.
   *
   * A persist that FAILS is not a second such reason, because it is UNDONE:
   * `mutate` rolls the in-memory ledger back to the state it had before the
   * charge and re-throws, so once the pin is released memory is no longer ahead
   * of the store and the ledger is an ordinary evictable cache entry again.
   * That is deliberate — the previous design pinned a failed root forever (it
   * was cleared only by a later SUCCESSFUL persist for the same root, which for
   * a finished task never comes), so one transient blip pinned a root for the
   * life of the process and a store outage pinned every root at once.
   *
   * With no store there is nowhere for the spent total to survive, and evicting
   * would hand the root a fresh full budget: exactly the silent refill 06
   * sections 4-5 forbid. So a storeless port never evicts, and that
   * configuration (tests only; `createDaemon` always supplies a store) accepts
   * the growth.
   */
  const ledgers = new Map<string, Resident>();
  const pins = new Map<string, number>();
  const maxResident =
    store === undefined
      ? Number.POSITIVE_INFINITY
      : (options.maxResidentLedgers ?? DEFAULT_MAX_RESIDENT_LEDGERS);

  /** A ledger whose snapshot may be behind memory must not be evicted. */
  const retained = (rootTaskId: string): boolean => (pins.get(rootTaskId) ?? 0) > 0;

  /**
   * Trims the map back to the bound, never touching `keep`.
   *
   * `keep` is the entry the caller is about to hand out, and excluding it is
   * not an optimisation: a `Map` iterates in insertion order, so the key just
   * (re-)inserted is the LAST candidate, and when every colder key is retained
   * it becomes the only evictable one. Evicting it would return a ledger that
   * is no longer in the map — a second charge on the same root would then load
   * a snapshot that does not know about the first, and the two would mint a
   * step between them. An entry is never evicted as a side effect of being
   * inserted.
   */
  const evictDown = (keep: string): void => {
    while (ledgers.size > maxResident) {
      // Coldest FIRST, but skipping retained keys rather than stopping at them:
      // one root with a persist in flight must not freeze eviction for every
      // other root behind it. If nothing is evictable the map is allowed to
      // exceed the ceiling for as long as the in-flight writes take — a bounded
      // overshoot, and the only alternative is losing a charge.
      let evicted = false;
      for (const key of ledgers.keys()) {
        if (key === keep || retained(key)) continue;
        ledgers.delete(key);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  };

  const touch = (rootTaskId: string, resident: Resident): void => {
    ledgers.delete(rootTaskId);
    ledgers.set(rootTaskId, resident);
    evictDown(rootTaskId);
  };

  const ledgerFor = (rootTaskId: string): Resident | undefined => {
    const existing = ledgers.get(rootTaskId);
    if (existing !== undefined) {
      touch(rootTaskId, existing);
      return existing;
    }
    const policy = policyOfRoot(rootTaskId);
    if (policy === undefined) return undefined;
    const persisted = store?.load(rootTaskId);
    const created: Resident = {
      limits: policy.limits,
      ledger:
        persisted === undefined
          ? new BudgetLedger(rootTaskId, policy.limits, startedAt())
          : BudgetLedger.restore(policy.limits, persisted),
    };
    touch(rootTaskId, created);
    return created;
  };
  const policyOfRoot = (rootTaskId: string): WorkspacePolicy | undefined =>
    options.policyOf(rootTaskId);

  /**
   * Serializes everything that mutates one root's ledger, so that the whole
   * mutate-then-persist pair is atomic for that root.
   *
   * Two things rest on this. First, ROLLBACK: `mutate` undoes an in-memory
   * charge whose persist failed, and "undo" only has a meaning while no other
   * charge has touched the same ledger in between. Second, ORDERING: `store`
   * receives snapshot N+1 only after it has acknowledged snapshot N, so the
   * newest write is the newest state by construction. That guarantee used to be
   * incidental — it held only because `createSqliteBudgetStateStore` assigns its
   * sequence number synchronously and the repository's write queue is FIFO, and
   * any store that ordered asynchronously would have clobbered a newer snapshot
   * with an older one.
   *
   * Different roots never serialize against each other, which is what the
   * per-root chain buys over a single global lock. The chain entry is dropped
   * as soon as it is the tail, so this map does not grow with the number of
   * roots the process has seen.
   */
  const chains = new Map<string, Promise<unknown>>();
  const onRoot = <T>(rootTaskId: string, run: () => Promise<T>): Promise<T> => {
    const previous = chains.get(rootTaskId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    chains.set(rootTaskId, settled);
    void settled.then(() => {
      if (chains.get(rootTaskId) === settled) chains.delete(rootTaskId);
    });
    return next;
  };

  /**
   * Writes the ledger through, pinned for the duration so eviction cannot
   * discard the mutation that is still on its way to the store.
   */
  const persist = async (rootTaskId: string, ledger: BudgetLedger): Promise<void> => {
    if (store === undefined) return;
    pins.set(rootTaskId, (pins.get(rootTaskId) ?? 0) + 1);
    try {
      await store.save(rootTaskId, ledger.snapshot());
    } finally {
      const remaining = (pins.get(rootTaskId) ?? 1) - 1;
      if (remaining <= 0) pins.delete(rootTaskId);
      else pins.set(rootTaskId, remaining);
    }
  };

  /**
   * Applies one mutation to a root's ledger and makes it durable, or applies
   * neither. Callers hold no `await` between reading the ledger and mutating it,
   * so check-and-charge stays atomic.
   *
   * A charge that cannot be persisted is ROLLED BACK. The alternative — leaving
   * the mutation in memory and re-throwing — double-counted: `db.chargeBudget`
   * is a retryable activity, so the retry charged the same logical step again
   * and `stepsUsed` went 1 -> 2 for one step. Rolling back is the choice rather
   * than an idempotency key per (root, step, attempt) because the port is given
   * no attempt identity — `BudgetCharge` carries none — so a key would have to
   * be invented here and persisted alongside every ledger, and it would still
   * need this rollback for the case where the invented key itself fails to
   * land. Undo needs no extra durable state and cannot be lost.
   *
   * The failure is still propagated: an unacknowledged charge is the honest
   * answer, and the caller is free to retry it. In the one case the store
   * cannot distinguish — a write that landed but reported failure — memory is
   * behind the snapshot rather than ahead of it, so the reload OVER-counts.
   * That is the safe direction: budget is never minted, only spent.
   */
  const mutate = async <T>(
    rootTaskId: string,
    apply: (resident: Resident) => T,
    absent: () => T,
  ): Promise<T> => {
    const resident = ledgerFor(rootTaskId);
    if (resident === undefined) return absent();
    const before = resident.ledger.snapshot();
    const result = apply(resident);
    try {
      await persist(rootTaskId, resident.ledger);
    } catch (error) {
      // Only replace an entry that is still resident: if it is gone, the store
      // already holds the state the next load will rebuild from.
      if (ledgers.has(rootTaskId)) {
        ledgers.set(rootTaskId, {
          limits: resident.limits,
          ledger: BudgetLedger.restore(resident.limits, before),
        });
      }
      throw error;
    }
    return result;
  };

  /** No ledger means no known budget. Denying is the only safe answer. */
  const noBudget = (): BudgetDecision => ({
    allowed: false,
    limit: "max_steps",
    stepsUsed: 0,
    message: "no execution budget is configured for this task's root",
  });

  return {
    async charge(charge: BudgetCharge): Promise<BudgetDecision> {
      const root = rootOf(charge.rootTaskId ?? charge.taskId);
      return onRoot(root, async () => {
        // Read-only, so it neither needs nor deserves a write: a wall-time
        // refusal spends nothing and must not enqueue a snapshot.
        const resident = ledgerFor(root);
        if (resident === undefined) return noBudget();
        const wall = resident.ledger.checkWallTime(now());
        if (wall.status !== "ok") {
          return {
            allowed: false,
            limit: wall.violation.limit,
            stepsUsed: resident.ledger.stepsUsed,
          };
        }

        return mutate(
          root,
          ({ ledger }): BudgetDecision => {
            const stepKind = STEP_KIND_OF_CHARGE[charge.kind];
            const outcome =
              charge.kind === "fix-round"
                ? ledger.recordFixRound()
                : charge.kind === "review-round"
                  ? ledger.recordReviewRound()
                  : ledger.recordStep({
                      taskId: charge.taskId,
                      stepKey: charge.stepKey ?? charge.kind,
                      kind: stepKind ?? "agent-run",
                    });
            return outcome.status === "ok"
              ? { allowed: true, stepsUsed: outcome.stepsUsed }
              : { allowed: false, limit: outcome.violation.limit, stepsUsed: ledger.stepsUsed };
          },
          noBudget,
        );
      });
    },

    snapshot(taskId: string): { stepsUsed: number } {
      return { stepsUsed: ledgerFor(rootOf(taskId))?.ledger.stepsUsed ?? 0 };
    },

    async extendOnce(taskId: string): Promise<BudgetExtension> {
      const root = rootOf(taskId);
      return onRoot(root, async () =>
        mutate(
          root,
          ({ ledger }): BudgetExtension => {
            const outcome = ledger.extendOnce();
            return outcome.ok
              ? { ok: true, maxSteps: outcome.maxSteps }
              : { ok: false, reason: outcome.reason };
          },
          () => ({ ok: false, reason: "unknown-budget" }),
        ),
      );
    },
  };
}

/** Minimal read surface of the control plane's SQLite handle. */
export type BudgetStateReader = {
  prepare(sql: string): { get(...params: unknown[]): unknown };
};

export type TaskEventAppender = (args: {
  taskId: string;
  eventType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}) => void | Promise<void>;

export const BUDGET_SNAPSHOT_EVENT = "BudgetLedgerSnapshot";

/**
 * Raised when a persisted budget snapshot EXISTS but cannot be understood.
 *
 * The distinction this error exists to make is between "this root has never
 * been charged" (no row: a fresh ledger is correct) and "this root has a spent
 * total we can no longer read" (a row we cannot decode). Collapsing the second
 * into the first is a silent budget refill: 06 sections 4-5 make `max_steps` a
 * ROOT budget precisely so that splitting or restarting work cannot mint more
 * of it, and `ledgers` is in-memory only, so every control-plane restart would
 * hand the task a full budget again — `limit-exceeded` would never fire and
 * nothing would say why. Failing closed here turns a schema drift or a
 * truncated write into a loud, one-task failure instead.
 */
export class BudgetSnapshotUnreadableError extends Error {
  readonly rootTaskId: string;
  constructor(rootTaskId: string, detail: string) {
    super(
      `the persisted execution budget for root task ${rootTaskId} is unreadable (${detail});` +
        " refusing to resume it as an empty budget",
    );
    this.rootTaskId = rootTaskId;
    // Non-retryable for Temporal: re-reading the same corrupt row never helps.
    this.name = "PolicyViolation";
  }
}

/**
 * Persists the root ledger as an append-only task event. The newest snapshot
 * wins; the zero-padded sequence in the idempotency key gives a total order
 * that does not depend on a millisecond timestamp.
 */
export function createSqliteBudgetStateStore(
  db: BudgetStateReader,
  append: TaskEventAppender,
): BudgetStateStore {
  /**
   * Last sequence written per root, most-recently-used last. Bounded for the
   * same reason the resident ledgers are: a daemon runs for weeks and would
   * otherwise keep one entry per root task it had ever saved. Forgetting an
   * entry costs one extra read and nothing else — `save` falls back to the
   * newest row in the table, and the port serializes a root's saves, so the
   * previous one is already durable by the time the next asks.
   */
  const MAX_TRACKED_SEQUENCES = 1024;
  const sequences = new Map<string, number>();
  const remember = (rootTaskId: string, seq: number): void => {
    sequences.delete(rootTaskId);
    sequences.set(rootTaskId, seq);
    for (const oldest of sequences.keys()) {
      if (sequences.size <= MAX_TRACKED_SEQUENCES) break;
      sequences.delete(oldest);
    }
  };
  const key = (rootTaskId: string, seq: number): string =>
    `budget:${rootTaskId}:${String(seq).padStart(9, "0")}`;

  const read = (
    rootTaskId: string,
  ): { seq: number; state: BudgetLedgerState } | undefined => {
    const row = db
      .prepare(
        `SELECT payload_json FROM task_events
          WHERE task_id = ? AND event_type = '${BUDGET_SNAPSHOT_EVENT}'
          ORDER BY idempotency_key DESC LIMIT 1`,
      )
      .get(rootTaskId) as { payload_json: string } | undefined;
    // `undefined` means one thing only: no snapshot row exists, so this root
    // has never been charged. Every other failure throws (see
    // `BudgetSnapshotUnreadableError`) — a snapshot we cannot read is NOT an
    // empty budget.
    if (row === undefined) return undefined;
    let parsed: { seq?: number; state?: BudgetLedgerState };
    try {
      parsed = JSON.parse(row.payload_json) as { seq?: number; state?: BudgetLedgerState };
    } catch (error) {
      throw new BudgetSnapshotUnreadableError(rootTaskId, `payload is not JSON: ${String(error)}`);
    }
    if (parsed.state === undefined) {
      throw new BudgetSnapshotUnreadableError(rootTaskId, "payload carries no `state`");
    }
    return { seq: parsed.seq ?? 0, state: parsed.state };
  };

  return {
    load(rootTaskId: string): BudgetLedgerState | undefined {
      const found = read(rootTaskId);
      if (found === undefined) return undefined;
      remember(rootTaskId, found.seq);
      return found.state;
    },
    async save(rootTaskId: string, state: BudgetLedgerState): Promise<void> {
      const seq = (sequences.get(rootTaskId) ?? read(rootTaskId)?.seq ?? 0) + 1;
      remember(rootTaskId, seq);
      await append({
        taskId: rootTaskId,
        eventType: BUDGET_SNAPSHOT_EVENT,
        idempotencyKey: key(rootTaskId, seq),
        payload: { seq, state: state as unknown as Record<string, unknown> },
      });
    },
  };
}

/* ------------------------------------------------------ interaction policy */

export type InteractionPolicyPortOptions = {
  config?: InteractionConfig;
  events: ControlEventBus;
  emittedKeys?: Set<string>;
};

/**
 * DomainEvent -> outbox intents (07 section 1). The same event is also fanned
 * out to subscribed Control Plane clients, which is how `meidoya task watch`
 * follows a task without holding an agent process.
 */
export function createInteractionPolicyPort(
  options: InteractionPolicyPortOptions,
): InteractionPolicyPort {
  const config = resolveInteractionConfig(options.config);
  const emitted = options.emittedKeys ?? new Set<string>();
  return {
    publish(event: DomainEvent): void {
      options.events.publish({
        workspaceId: event.workspaceId,
        taskId: event.taskId,
        type: event.type,
        payload: event.payload,
        at: event.createdAt,
      });
    },
    emit(event: DomainEvent): OutboxIntent[] {
      const intents = decideOutboxIntents(event, config, {
        emittedIdempotencyKeys: [...emitted],
      });
      const out: OutboxIntent[] = [];
      for (const intent of intents) {
        const input = toOutboxIntentInput(intent);
        out.push({
          workspaceId: input.workspaceId,
          ...(input.conversationId === undefined
            ? {}
            : { conversationId: input.conversationId }),
          eventId: input.eventId,
          action: input.action,
          idempotencyKey: input.idempotencyKey,
          payload: input.payload,
        });
      }
      return out;
    },
    recordEmitted(intents: readonly OutboxIntent[]): void {
      // Deliberately the LAST step, after the caller's transaction committed:
      // the ledger that turns a repeat into an edit may only remember rows the
      // database really holds. Recording it inside `emit` meant one retried
      // activity turned its own re-post into an edit of a row that never
      // existed.
      for (const intent of intents) emitted.add(intent.idempotencyKey);
    },
  };
}

/* --------------------------------------------------------------- commands */

/**
 * Raised when a verification activity reaches the CONTROL PLANE at all.
 *
 * Verification belongs on an execution node, inside its sandbox and narrowed to
 * the project under test (10 sections 1-3); `runTaskWorkflow` therefore
 * dispatches `runVerification` only to `nodeTaskQueue(executionNodeId)`. The
 * control plane has no filesystem sandbox and no checkout — a workspace's
 * `projects` here carry a `workspace_ref`, not a path — so there is nothing it
 * could honestly confine an operator's `npm test` to, and it must never be a
 * silent second executor sitting next to the database and the credentials.
 *
 * This error is what the control worker answers if a verification is ever
 * scheduled onto `meidoya/control` regardless (a hand-started workflow, a
 * mis-built workflow bundle). It is an ERROR, deliberately, and non-retryable:
 * the previous behaviour — returning exit 126 `verification-disabled` — made
 * every quality gate "fail" quietly, so a `coding` task could never satisfy
 * `verification-policy-satisfied` and simply never completed, with nothing in
 * the logs to say why.
 */
export class VerificationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    // Non-retryable for Temporal: retrying a missing deployment never helps.
    this.name = "PolicyViolation";
  }
}

export function createArtifactProbe(root: string): ArtifactProbePort {
  return {
    async exists(candidate: string): Promise<boolean> {
      try {
        await access(path.isAbsolute(candidate) ? candidate : path.join(root, candidate));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const systemClock: ClockPort = { now: () => Date.now() };

export const uuidIds: IdPort = { next: (prefix) => `${prefix}_${randomUUID()}` };
