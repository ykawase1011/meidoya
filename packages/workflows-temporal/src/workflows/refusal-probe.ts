import { proxyActivities } from "@temporalio/workflow";

import {
  DB_ACTIVITY_OPTIONS,
  MANAGER_ACTIVITY_OPTIONS,
  NOTIFICATION_ACTIVITY_OPTIONS,
  VERIFICATION_ACTIVITY_OPTIONS,
  WORKER_ACTIVITY_OPTIONS,
} from "../retry-policies.js";

/**
 * A workflow that exists so `refusals-runtime.test.ts` can watch Temporal decide.
 *
 * The registry in `refusals.ts` is a claim about what the server does with a
 * failure — "this type is in `nonRetryableErrorTypes`, therefore it is attempted
 * once". Every test of it up to now checked the DECLARATION: that the string is
 * in the list, that every option set carries the list. None of them checked that
 * the string is the one the server compares against, and the string the server
 * compares against is produced by the SDK's error→failure conversion, not by us.
 * That gap is exactly where a refusal gets retried to exhaustion while the suite
 * is green, so this workflow drives the real thing: one activity, one option set,
 * one thrown error, and the test counts attempts.
 *
 * It is deliberately NOT exported from `workflows/index.ts` — it is bundled on
 * its own path by the test and never registered by the daemon.
 */

export type RefusalProbeActivities = {
  /** Throws an error shaped by the test; the test counts the invocations. */
  probeRefusal(shape: { className: string; thrownName: string }): Promise<void>;
};

/** The option sets a task execution actually uses, by name. */
export const PROBE_OPTION_SETS = {
  DB_ACTIVITY_OPTIONS,
  NOTIFICATION_ACTIVITY_OPTIONS,
  MANAGER_ACTIVITY_OPTIONS,
  WORKER_ACTIVITY_OPTIONS,
  VERIFICATION_ACTIVITY_OPTIONS,
} as const;

export type ProbeOptionSetName = keyof typeof PROBE_OPTION_SETS;

export type RefusalProbeInput = {
  readonly optionSet: ProbeOptionSetName;
  readonly className: string;
  readonly thrownName: string;
};

/** Returns the failure's `type` as the workflow received it, or "completed". */
export async function RefusalProbeWorkflow(input: RefusalProbeInput): Promise<string> {
  // The option set is used verbatim, `heartbeatTimeout` included: the probe
  // activity throws on its first statement, so it never reaches one.
  const activities = proxyActivities<RefusalProbeActivities>(PROBE_OPTION_SETS[input.optionSet]);
  try {
    await activities.probeRefusal({ className: input.className, thrownName: input.thrownName });
    return "completed";
  } catch (error) {
    const cause: unknown = (error as { cause?: unknown }).cause;
    const type = (cause as { type?: unknown } | undefined)?.type;
    return typeof type === "string" ? type : "unknown";
  }
}
