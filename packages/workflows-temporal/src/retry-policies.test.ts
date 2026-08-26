import { describe, expect, it } from "vitest";
import type { ActivityOptions } from "@temporalio/workflow";

import { HEARTBEAT_INTERVAL_MS } from "./heartbeat.js";
import { NON_RETRYABLE_ERROR_TYPES } from "./refusals.js";
import {
  DB_ACTIVITY_OPTIONS,
  MANAGER_ACTIVITY_OPTIONS,
  NOTIFICATION_ACTIVITY_OPTIONS,
  VERIFICATION_ACTIVITY_OPTIONS,
  WORKER_ACTIVITY_OPTIONS,
} from "./retry-policies.js";

const ALL: Record<string, ActivityOptions> = {
  DB_ACTIVITY_OPTIONS,
  NOTIFICATION_ACTIVITY_OPTIONS,
  MANAGER_ACTIVITY_OPTIONS,
  WORKER_ACTIVITY_OPTIONS,
  VERIFICATION_ACTIVITY_OPTIONS,
};

describe("activity options", () => {
  it("always bound an attempt", () => {
    for (const [name, options] of Object.entries(ALL)) {
      expect(options.startToCloseTimeout, `${name} has no startToCloseTimeout`).toBeDefined();
      expect(options.retry?.maximumAttempts, `${name} retries forever`).toBeGreaterThan(0);
    }
  });

  /**
   * `heartbeatTimeout` is enforced server-side: an activity that declares one
   * and does not beat within it is killed and retried until its attempts run
   * out, then fails the workflow. All three long-running classes used to
   * declare one while NOTHING in this repository called `heartbeat()`, which
   * made every real agent run and every real quality gate impossible to pass.
   *
   * So the list of sets that declare one is pinned. An entry here is a claim
   * that the process implementing those activities beats — for MANAGER that
   * claim is `heartbeat.test.ts`; for WORKER and VERIFICATION, which the
   * execution node implements, it is the node's own heartbeat tests. Add an
   * entry only with that proof in the same change.
   */
  it("declare a heartbeat timeout exactly where the activities heartbeat", () => {
    const declaring = Object.entries(ALL)
      .filter(([, options]) => options.heartbeatTimeout !== undefined)
      .map(([name]) => name)
      .sort();
    // MANAGER beats from `createActivities` (`heartbeat.test.ts`); WORKER and
    // VERIFICATION beat from the execution node's runner. DB and NOTIFICATION
    // are short and beat nothing, so they must declare nothing.
    expect(declaring).toEqual([
      "MANAGER_ACTIVITY_OPTIONS",
      "VERIFICATION_ACTIVITY_OPTIONS",
      "WORKER_ACTIVITY_OPTIONS",
    ]);
  });

  /**
   * A timeout must be several beats wide: one lost beat is a network hiccup,
   * not a dead worker. The node beats every 20s, this package every 15s.
   */
  it("leaves room for lost beats", () => {
    const NODE_BEAT_MS = 20_000;
    expect(MANAGER_ACTIVITY_OPTIONS.heartbeatTimeout).toBe("1 minute");
    expect(HEARTBEAT_INTERVAL_MS * 3).toBeLessThanOrEqual(60_000);
    for (const options of [WORKER_ACTIVITY_OPTIONS, VERIFICATION_ACTIVITY_OPTIONS]) {
      expect(options.heartbeatTimeout).toBe("2 minutes");
      expect(NODE_BEAT_MS * 3).toBeLessThanOrEqual(120_000);
    }
  });

  it("never lets a heartbeat timeout exceed its own start-to-close budget", () => {
    // A heartbeat timeout longer than the attempt it guards cannot fire.
    expect(MANAGER_ACTIVITY_OPTIONS.startToCloseTimeout).toBe("15 minutes");
    expect(WORKER_ACTIVITY_OPTIONS.startToCloseTimeout).toBe("2 hours");
    expect(VERIFICATION_ACTIVITY_OPTIONS.startToCloseTimeout).toBe("30 minutes");
  });

  /**
   * Temporal matches `nonRetryableErrorTypes` against the failure TYPE, which
   * for a plain `Error` subclass is its `name`. The set comes from
   * `refusals.ts`, which classifies every `Error` subclass in the repository;
   * `refusals.test.ts` is the guard that keeps that classification complete.
   * Pinned here too, on EVERY set, because the last three review rounds each
   * found a refusal being retried: a `ScopeViolationError` listed only as
   * `"ScopeViolation"`, a `SandboxViolationError` listed in neither spelling,
   * and a `PolicyViolation` raised by `db.chargeBudget` under the one set that
   * declared no `nonRetryableErrorTypes` at all.
   */
  it("refuses to retry a refusal, in every option set and under either spelling", () => {
    for (const [name, options] of Object.entries(ALL)) {
      const types = options.retry?.nonRetryableErrorTypes ?? [];
      for (const spelling of [
        "ScopeViolation",
        "ScopeViolationError",
        "PolicyViolation",
        "PolicyViolationError",
        "SandboxViolation",
        "SandboxViolationError",
      ]) {
        expect(types, `${name} would retry a ${spelling}`).toContain(spelling);
      }
      expect(types, `${name} does not carry the registry`).toEqual(
        expect.arrayContaining([...NON_RETRYABLE_ERROR_TYPES]),
      );
    }
  });
});
