import { reapAbandonedTestServers } from "./server-registry.js";
import { sweepAbandonedStartSlots } from "./start-semaphore.js";

/**
 * vitest `globalSetup`: reclaim before the run, and again after it.
 *
 * The "after" half handles the ordinary case — a worker that failed a start,
 * or a file that never tore its environment down — because by then every worker
 * process has exited, so every reservation those workers wrote is owned by a
 * PID that is gone.
 *
 * The "before" half is the one that matters, and it is why this is not a signal
 * handler: a run killed with SIGKILL — a CI step timeout, a closed laptop, ^C
 * landing while `spawnSync` blocks the event loop — cannot run any JavaScript on
 * its way out. Its durable record is the port reservations it wrote to the temp
 * dir BEFORE each start, and the next run is the only thing in a position to
 * read them. Reservations belonging to a live process are left alone, so a
 * second checkout building at the same time is never disturbed.
 */
export default function setup(): () => void {
  sweepAbandonedStartSlots();
  const before = reapAbandonedTestServers();
  if (before > 0) {
    process.stdout.write(
      `reclaimed ${String(before)} Temporal test server(s) orphaned by an earlier interrupted run\n`,
    );
  }
  return () => {
    reapAbandonedTestServers();
    sweepAbandonedStartSlots();
  };
}
