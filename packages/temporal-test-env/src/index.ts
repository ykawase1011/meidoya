import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  reapReservation,
  releaseServerPort,
  reserveServerPort,
  type ServerReservation,
} from "./server-registry.js";
import { withStartSlot, type StartSlotOptions } from "./start-semaphore.js";

export {
  listReservations,
  listRunningTestServers,
  reapAbandonedTestServers,
  reapReservation,
  registryDir,
  releaseServerPort,
  reserveServerPort,
  TEST_SERVER_BINARY,
  type ServerReservation,
  type TestServerProcess,
} from "./server-registry.js";
export {
  startConcurrency,
  startSlotDir,
  sweepAbandonedStartSlots,
  withStartSlot,
  type StartSlotOptions,
} from "./start-semaphore.js";

/**
 * Releases this environment's port reservation once it is torn down.
 *
 * The reservation is the record that says "a server may be running on this port
 * and it is ours to kill". While the environment is alive that record must
 * stay, so a run killed mid-test still leaves the next run something to act on.
 * Once `teardown` has stopped the server the record is a lie, and a stale record
 * is what makes a later run kill a port it should not.
 */
function releaseOnTeardown(
  env: TestWorkflowEnvironment,
  reservation: ServerReservation,
): TestWorkflowEnvironment {
  const original = env.teardown.bind(env);
  (env as { teardown: () => Promise<void> }).teardown = async () => {
    try {
      await original();
    } finally {
      releaseServerPort(reservation);
    }
  };
  return env;
}

/**
 * Starts a time-skipping Temporal test environment, safely under load.
 *
 * Every test file that needs a workflow server must go through this instead of
 * calling `TestWorkflowEnvironment.createTimeSkipping()` directly, because that
 * call is not safe to make in parallel with itself:
 *
 *  - The SDK spawns the ephemeral server binary and then polls it for exactly 5
 *    seconds before giving up. That deadline is compiled into the Rust core
 *    bridge (`sdk-core/src/ephemeral_server/mod.rs`) — there is NO option for it
 *    anywhere in the JS API, so "raise the timeout" is not a fix available here.
 *  - Start time grows with how many start together. Measured on this repo's
 *    development machine, idle, with no semaphore at all: 1 -> 3.45s cold,
 *    2 -> 1.58s, 4 -> 2.90s, 6 -> 4.5s, and 7 -> every one of the seven FAILED
 *    at the 5s deadline. The suite has exactly seven files that need a server
 *    and vitest starts them in parallel, so this is the routine case, not the
 *    tail — and it fails whole test FILES while no assertion does.
 *  - When the deadline is missed the SDK drops the child process handle without
 *    killing it, so each failure leaks a ~34 MB server that keeps running and
 *    holding its port. That was measured too: the N=7 round leaked all seven.
 *
 * So: bound the starts, retry rather than fail the file, and collect this
 * process's own leak on the way to the retry — by the port it reserved, so it
 * can only ever kill the server it asked for. The bound is on the start window
 * only, so the files still run fully in parallel afterwards.
 */
export async function startTimeSkippingEnv(
  options: { slot?: StartSlotOptions } = {},
): Promise<TestWorkflowEnvironment> {
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // The port is picked INSIDE the slot, not before queueing for it. The probe
    // that finds a free port has to close its socket before the server can bind
    // it, so the port is only provisionally ours until the server is up; holding
    // one across an unbounded queue wait would widen that window to the length
    // of the queue. Inside the slot at most `slots` are outstanding at once, and
    // a lost race is caught by the retry with a fresh port either way.
    let reservation: ServerReservation | undefined;
    try {
      const started = await withStartSlot(async () => {
        const port = await reserveServerPort();
        reservation = port;
        return {
          port,
          env: await TestWorkflowEnvironment.createTimeSkipping({ server: { port: port.port } }),
        };
      }, options.slot ?? {});
      return releaseOnTeardown(started.env, started.port);
    } catch (error) {
      lastError = error;
      // A failed start may have just leaked a server on OUR port. Collect it now
      // rather than leaving it to compete with the retry we are about to make.
      if (reservation !== undefined) reapReservation(reservation);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000 + Math.random() * 500));
      }
    }
  }
  throw new Error(
    `could not start a time-skipping Temporal server in ${String(attempts)} attempts: ${String(lastError)}`,
  );
}
