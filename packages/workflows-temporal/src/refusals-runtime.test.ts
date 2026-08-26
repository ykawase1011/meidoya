import { fileURLToPath } from "node:url";

import { startTimeSkippingEnv } from "@meidoya/temporal-test-env";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ERROR_CLASSIFICATION, NON_RETRYABLE_ERROR_TYPES } from "./refusals.js";
import { CONTROL_TASK_QUEUE } from "./task-queues.js";
import {
  RefusalProbeWorkflow,
  type ProbeOptionSetName,
  type RefusalProbeActivities,
} from "./workflows/refusal-probe.js";

/**
 * Does Temporal actually refuse to retry a refusal?
 *
 * `refusals.test.ts` proves the DECLARATION is complete and consistent: every
 * error class is classified, every refusal's name is in
 * `NON_RETRYABLE_ERROR_TYPES`, every option set carries the list. None of that
 * proves the server ever matches one, because the string it compares against is
 * produced by the SDK's error→failure conversion and not by us. A registry that
 * is complete, consistent and compared against the wrong string is a registry
 * that does nothing while looking maintained.
 *
 * So this file runs the real server (the time-skipping test environment), throws
 * from a real activity, and counts attempts.
 */

const workflowsPath = fileURLToPath(new URL("./workflows/refusal-probe.ts", import.meta.url));

let env: TestWorkflowEnvironment | undefined;

beforeAll(async () => {
  env = await startTimeSkippingEnv();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

/**
 * An error whose CLASS name and whose `name` property differ, exactly as the
 * repository's own refusals do (`class VerificationPolicyError extends Error`
 * with `this.name = "PolicyViolation"`).
 */
function makeError(className: string, thrownName: string): Error {
  const constructed = { [className]: class extends Error {} }[className];
  if (constructed === undefined) throw new Error("unreachable");
  const error = new constructed("refused");
  error.name = thrownName;
  return error;
}

type ProbeOutcome = { attempts: number; failureType: string };

async function probe(
  optionSet: ProbeOptionSetName,
  className: string,
  thrownName: string,
): Promise<ProbeOutcome> {
  const testEnv = env;
  if (testEnv === undefined) throw new Error("no test environment");
  let attempts = 0;
  const activities: RefusalProbeActivities = {
    async probeRefusal(shape) {
      attempts += 1;
      throw makeError(shape.className, shape.thrownName);
    },
  };
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: CONTROL_TASK_QUEUE,
    workflowsPath,
    activities,
  });
  const failureType = await worker.runUntil(
    testEnv.client.workflow.execute(RefusalProbeWorkflow, {
      taskQueue: CONTROL_TASK_QUEUE,
      workflowId: `refusal-probe-${optionSet}-${className}-${thrownName}-${Math.random()}`,
      args: [{ optionSet, className, thrownName }],
    }),
  );
  return { attempts, failureType };
}

describe("Temporal's treatment of a refusal, at runtime", () => {
  /**
   * The ground truth the whole registry rests on: WHICH string does the SDK put
   * in the failure's `type`?
   *
   * `ensureApplicationFailure` reads `error.constructor?.name ?? error.name`, so
   * it is the CLASS name that reaches the server — and `error.name` is used only
   * when there is no constructor at all. A registry that lists `name` therefore
   * lists a string the server never sees. This test is the one that says so out
   * loud; the two below show what it costs.
   */
  it("takes the failure type from the error's CLASS name, not its `name`", async () => {
    const { failureType } = await probe(
      "DB_ACTIVITY_OPTIONS",
      "ProbeRenamedError",
      "ProbeRenamedName",
    );
    expect(failureType).toBe("ProbeRenamedError");
  }, 60_000);

  it("retries a type that is in no list — the counter can see retries at all", async () => {
    const { attempts } = await probe(
      "VERIFICATION_ACTIVITY_OPTIONS",
      "ProbeTransientError",
      "ProbeTransientError",
    );
    // VERIFICATION_ACTIVITY_OPTIONS allows two attempts.
    expect(attempts).toBe(2);
  }, 60_000);

  /**
   * Every classified refusal, thrown the way its own source throws it, is
   * attempted exactly ONCE — through every option set that proxies activities.
   *
   * This is the assertion the previous five rounds were missing. It fails if a
   * refusal's listed string is not the one Temporal matches (which is how it was
   * found), if an option set drops the list, or if the SDK ever changes which
   * property becomes the failure type.
   */
  const refusals = Object.entries(ERROR_CLASSIFICATION).filter(
    ([, entry]) => entry.disposition === "refusal",
  );
  const optionSets: ProbeOptionSetName[] = [
    "DB_ACTIVITY_OPTIONS",
    "NOTIFICATION_ACTIVITY_OPTIONS",
    "MANAGER_ACTIVITY_OPTIONS",
    "WORKER_ACTIVITY_OPTIONS",
    "VERIFICATION_ACTIVITY_OPTIONS",
  ];

  for (const [className, entry] of refusals) {
    it(`attempts a thrown ${className} exactly once, in every option set`, async () => {
      for (const optionSet of optionSets) {
        const { attempts, failureType } = await probe(optionSet, className, entry.thrownName);
        expect(
          NON_RETRYABLE_ERROR_TYPES,
          `${className} reaches Temporal as type "${failureType}", which the list must contain`,
        ).toContain(failureType);
        expect(
          attempts,
          `${optionSet} retried ${className} (type "${failureType}") ${attempts} times`,
        ).toBe(1);
      }
    }, 120_000);
  }
});
