import type { ActivityOptions } from "@temporalio/workflow";

import { NON_RETRYABLE_ERROR_TYPES } from "./refusals.js";

/**
 * Activity classes differ in cost and idempotency, so their retry/timeout budgets
 * differ. Agent runs are long and retried few times; SQLite writes are cheap and
 * idempotent so they retry aggressively.
 *
 * ## `heartbeatTimeout` is a promise, not a hint
 *
 * Temporal enforces it server-side: an activity that declares one and does not
 * call `Context.current().heartbeat()` inside it is killed and retried until its
 * attempts run out, and then the workflow fails. All three long-running classes
 * here used to declare one while NOTHING in the codebase beat — so every agent
 * run over two minutes, every Manager call over one and every quality gate over
 * two was doomed, which is every real one.
 *
 * So an option set may declare `heartbeatTimeout` only if the process that
 * implements those activities beats. That is asserted, not assumed:
 * `retry-policies.test.ts` pins which sets declare one, and `heartbeat.test.ts`
 * proves this package's activities beat.
 *
 *  - MANAGER — implemented by `createActivities` in this package, which wraps
 *    every agent invocation in `withHeartbeat` (every 15s).
 *  - WORKER and VERIFICATION — dispatched to the execution node's queue and
 *    implemented in `apps/meidoya-node`, whose runner beats through its
 *    `NodeActivityContextPort` at the start of a run and every 20s after.
 *
 * Every declared timeout is several beats wide, so a lost beat is not a kill.
 * Narrowing one below its beat interval, or declaring one for a class that does
 * not beat, is the same production-blocking bug in a new place.
 */

/**
 * Refusals: the node (or the control plane) saying "not allowed", not "failed".
 *
 * Temporal matches these against the failure's TYPE, which for a plain `Error`
 * subclass thrown from an activity is its CLASS name (`ensureApplicationFailure`
 * computes `error.constructor?.name ?? error.name`, so `name` is read only when
 * there is no constructor) — every refusal is therefore listed under both its
 * class name and its `name`. The set is NOT typed out here: it is derived from
 * `refusals.ts`, which classifies every `Error` subclass in the repository, and
 * `refusals.test.ts` fails when a class exists that nothing has classified.
 * Maintaining the strings by hand failed three times — `"ScopeViolation"`
 * against a thrown `ScopeViolationError`, a `SandboxViolationError` in neither
 * spelling, and a `PolicyViolation` from `db.chargeBudget` reaching the one
 * option set that declared no `nonRetryableErrorTypes` at all.
 *
 * Every set declares them, short-running ones included: whether a failure is a
 * refusal has nothing to do with how long its activity runs.
 */
const NON_RETRYABLE_REFUSALS = [...NON_RETRYABLE_ERROR_TYPES];

export const DB_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "200 milliseconds",
    backoffCoefficient: 2,
    maximumInterval: "10 seconds",
    maximumAttempts: 10,
    nonRetryableErrorTypes: NON_RETRYABLE_REFUSALS,
  },
};

export const NOTIFICATION_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 8,
    nonRetryableErrorTypes: NON_RETRYABLE_REFUSALS,
  },
};

export const MANAGER_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "15 minutes",
  // Kept because `createActivities` beats every HEARTBEAT_INTERVAL_MS (15s).
  heartbeatTimeout: "1 minute",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 3,
    nonRetryableErrorTypes: NON_RETRYABLE_REFUSALS,
  },
};

export const WORKER_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "2 hours",
  // The node beats every 20s for a Worker run; 2 minutes tolerates five losses.
  heartbeatTimeout: "2 minutes",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    maximumAttempts: 3,
    nonRetryableErrorTypes: NON_RETRYABLE_REFUSALS,
  },
};

/**
 * Verification runs on the execution node (10 section 3), so the workflow
 * dispatches it to that node's task queue — see `nodeTaskQueue` in
 * `workflows/task.ts`, which spreads these options exactly as the Worker proxy
 * does. Nothing here can set the queue: it depends on the task's node.
 *
 * A node that refuses the run — no sandbox, no quality-gate catalog, a project
 * it cannot resolve — raises a non-retryable `PolicyViolation`. Retrying a
 * refusal only delays the error the operator needs to see.
 */
export const VERIFICATION_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "30 minutes",
  // The node beats every 20s while a gate runs; 2 minutes tolerates five losses.
  heartbeatTimeout: "2 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 2,
    nonRetryableErrorTypes: NON_RETRYABLE_REFUSALS,
  },
};
