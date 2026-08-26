import { Context } from "@temporalio/activity";

/**
 * Activity heartbeating.
 *
 * Temporal enforces `heartbeatTimeout` server-side: an Activity that declares
 * one and then does not heartbeat within it is killed and retried, however
 * healthy it is, until its attempts are exhausted — and then the workflow fails.
 * A declared heartbeat timeout is therefore a PROMISE that the activity beats;
 * `retry-policies.ts` may only declare one for an activity class that keeps it.
 *
 * Agent runs and quality gates are long and opaque: there is no natural progress
 * event to hang a beat on, so the beat is a timer that runs for as long as the
 * work does. That is enough for what heartbeating buys — the server learns the
 * worker is alive, and a cancellation reaches the activity at the next beat.
 *
 * ## What a timer beat does NOT detect, and what does
 *
 * State this plainly, because a heartbeat looks like a liveness check and this
 * one is not: the timer beats for as long as `work()` is UNSETTLED, so an
 * activity wedged on a socket that never answers, or an agent process that
 * stopped producing output an hour ago, keeps beating exactly like a healthy
 * one. Only the process dying, the worker losing the connection, or `work()`
 * settling changes anything. The beat proves the WORKER is alive; it proves
 * nothing about the work.
 *
 * A hang is therefore bounded by `startToCloseTimeout` alone — 15 minutes for a
 * Manager call, 30 for verification, 2 hours for a Worker run
 * (`retry-policies.ts`) — and by an operator cancelling the task, which the
 * next beat delivers. Nothing here shortens that, and no test in this package
 * claims otherwise.
 *
 * Making it a real stall detector needs an input this package does not have:
 * the runtime's own progress events (10 section 8 asks for the agent run's
 * PHASE and session id in the beat details, which is exactly that signal). The
 * beat would then carry the phase and stop when the phase has not advanced for
 * N intervals, and the server's `heartbeatTimeout` — a minute or two — would
 * catch a wedged run instead of its start-to-close budget. That signal is owned
 * by `@meidoya/agent-runtime` and the execution node's runner, not by this
 * file; a mechanism added here before either can feed it would be a parameter
 * nothing passes, which is how the previous dead engines started.
 */

/** How often a long-running activity beats. Well under any declared timeout. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export type HeartbeatFn = (details?: unknown) => void;

/**
 * Beats the Activity Context if there is one.
 *
 * Outside an activity — a unit test calling the function directly, or the
 * daemon reusing an activity as a plain function — `Context.current()` throws,
 * and there is nothing to tell. Swallowing that is not hiding an error: it is
 * the difference between "no heartbeat is possible here" and "the heartbeat
 * failed", and only the latter would be worth reporting.
 */
export const activityHeartbeat: HeartbeatFn = (details?: unknown): void => {
  try {
    Context.current().heartbeat(details);
  } catch {
    // Not running inside a Temporal Activity.
  }
};

export type HeartbeatOptions = {
  /** Defaults to {@link activityHeartbeat}; injected by tests. */
  heartbeat?: HeartbeatFn;
  /** Defaults to {@link HEARTBEAT_INTERVAL_MS}. */
  intervalMs?: number;
};

/**
 * Runs `work`, beating every `intervalMs` until it settles.
 *
 * The first beat is immediate, so an activity that is picked up and then blocks
 * has already reported once before the interval elapses. The timer is cleared in
 * a `finally`, so a throwing activity leaves nothing behind, and it is `unref`ed
 * so it can never hold the process open.
 */
export async function withHeartbeat<T>(
  work: () => Promise<T>,
  options: HeartbeatOptions = {},
): Promise<T> {
  const beat = options.heartbeat ?? activityHeartbeat;
  const interval = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  beat();
  const timer = setInterval(beat, interval);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
