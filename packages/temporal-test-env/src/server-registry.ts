import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * WHAT THIS OWNS, AND WHY OWNERSHIP HAD TO BE INVENTED.
 *
 * The ephemeral time-skipping server is spawned by the SDK's Rust bridge, and
 * when a start misses the bridge's 5-second connect deadline the bridge drops
 * the child handle WITHOUT killing it. The process keeps running, keeps its
 * port, and — once the run that caused it exits — is reparented to init. Those
 * accumulate and make the next run likelier to fail, so something has to
 * collect them, and the only thing in a position to is a LATER run: a run
 * killed by SIGKILL executes no JavaScript on its way out, so it cannot clean
 * up after itself. That is the same argument the mutation harness's crash
 * journal is built on, and this is built the same way.
 *
 * The previous version decided ownership with `getppid() == 1` over a substring
 * match on the whole command line, and that is not ownership at all. It listed
 * — and SIGKILLed — a disowned `tail -f …temporal-test-server-….log`, because
 * the binary's name appears in that command line as an ARGUMENT. It would kill
 * a genuinely live server started under `nohup`, launchd, or a closed tmux
 * pane, and inside a container, where every process tree roots at PID 1, it
 * would kill EVERY such server including one a sibling process is using.
 *
 * So ownership is now a fact this package creates rather than one it infers:
 *
 *   1. This package CHOOSES the port before the server starts, and passes it to
 *      `createTimeSkipping`. The server is then the only process on the machine
 *      whose argv is exactly `<…/temporal-test-server-sdk-typescript-*> <port>`.
 *   2. That port is written to a journal file in the temp dir BEFORE the start,
 *      naming the PID that reserved it. The write is durable, so it survives the
 *      SIGKILL that stops the reserving process from ever running code again.
 *   3. Reaping kills a process only when its argv matches a reservation this
 *      journal holds AND that reservation's owner is this process or a process
 *      that is gone. A reservation owned by a live, unrelated process is left
 *      strictly alone — that is a concurrent run's server, not litter.
 *
 * A process we did not reserve a port for is therefore unkillable by this code,
 * whatever its name, arguments, or parent.
 */

/**
 * The ephemeral time-skipping server binary `@temporalio/testing` downloads into
 * the OS temp dir. Matched against the BASENAME OF ARGV[0] only — never against
 * the command line — so a process that merely mentions it cannot be mistaken
 * for one.
 */
export const TEST_SERVER_BINARY = "temporal-test-server-sdk-typescript";

export type TestServerProcess = { pid: number; executable: string; port: number };

export type ServerReservation = { port: number; ownerPid: number; claimedAt: number };

export function registryDir(): string {
  return path.join(os.tmpdir(), "meidoya-temporal-servers");
}

function reservationPath(dir: string, port: number): string {
  return path.join(dir, `port-${String(port)}.json`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function isMissing(error: unknown): boolean {
  return isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

/**
 * Every running ephemeral test server, by PID and the port it was told to bind.
 *
 * The SDK spawns the server with an argv of exactly TWO fields — the absolute
 * path to the executable, and the port — and this insists on precisely that:
 * two whitespace-separated fields, the second all digits, the first an absolute
 * path whose basename starts with the binary name.
 *
 * "Exactly two" is the load-bearing clause, and it is stricter than it looks
 * necessary to be. Splitting on the LAST space instead lets a longer command
 * line through whenever it happens to end in `…/temporal-test-server-… <number>`
 * — a supervisor, a debugger, an editor — because `basename` of everything
 * before the port is then the binary's own name. Matching the shape the SDK
 * actually produces, and nothing else, is what makes "we did not start it" the
 * default answer.
 *
 * The cost is that a temp directory containing a space is not recognised, and
 * on such a machine leaked servers are simply never collected. That is a loss
 * of hygiene and never of correctness — the semaphore is what bounds starts —
 * and it fails in the only acceptable direction.
 */
export function listRunningTestServers(): TestServerProcess[] {
  let output: string;
  try {
    // Absolute path on purpose: `ps` is commonly shadowed on developer PATHs by
    // rewrites like `procs`, which does not accept these flags.
    output = execFileSync("/bin/ps", ["-A", "-o", "pid=,args="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    // A platform without this `ps` gets no reaping. That degrades hygiene; it
    // never affects correctness, because the semaphore is what bounds starts.
    return [];
  }
  const found: TestServerProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (match === null) continue;
    const [, pidText, argv] = match;
    if (pidText === undefined || argv === undefined) continue;
    const fields = argv.split(/\s+/);
    if (fields.length !== 2) continue;
    const [executable, portText] = fields;
    if (executable === undefined || portText === undefined) continue;
    if (!/^\d+$/.test(portText)) continue;
    if (!path.isAbsolute(executable)) continue;
    if (!path.basename(executable).startsWith(TEST_SERVER_BINARY)) continue;
    found.push({ pid: Number(pidText), executable, port: Number(portText) });
  }
  return found;
}

/** Asks the OS for a free loopback port and hands it back. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => {
          reject(new Error("could not determine a free port for the Temporal test server"));
        });
        return;
      }
      const { port } = address;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Reserves a port for a server this process is about to start, and records the
 * reservation on disk BEFORE the start.
 *
 * Before, not after, is the entire point: the window this protects is the one
 * where the process is killed during the start, and a record written afterwards
 * would not exist for exactly the servers that get leaked.
 */
export async function reserveServerPort(
  options: { dir?: string; port?: number } = {},
): Promise<ServerReservation> {
  const dir = options.dir ?? registryDir();
  mkdirSync(dir, { recursive: true });
  const port = options.port ?? (await freePort());
  const reservation: ServerReservation = {
    port,
    ownerPid: process.pid,
    claimedAt: Date.now(),
  };
  writeFileSync(reservationPath(dir, port), JSON.stringify(reservation), "utf8");
  return reservation;
}

/** Forgets a reservation without killing anything. */
export function releaseServerPort(
  reservation: ServerReservation,
  options: { dir?: string } = {},
): void {
  rmSync(reservationPath(options.dir ?? registryDir(), reservation.port), { force: true });
}

/**
 * Kills the server holding one reservation's port, if it is still running, and
 * drops the reservation. Returns whether anything was killed.
 *
 * This is what a failed start calls, and it is why the failure path no longer
 * depends on reparenting: the leaked server's parent is the still-alive worker
 * that just failed to connect to it, so a `PPID == 1` test would never have
 * matched during the run it leaked in — that check was a no-op for the exact
 * leak it named.
 */
export function reapReservation(
  reservation: ServerReservation,
  options: { dir?: string } = {},
): boolean {
  let killed = false;
  for (const server of listRunningTestServers()) {
    if (server.port !== reservation.port) continue;
    try {
      // SIGKILL: it is a server nobody is talking to, holding ~34 MB and a
      // listening port, with no state worth flushing.
      process.kill(server.pid, "SIGKILL");
      killed = true;
    } catch {
      // Already gone. Nothing to do.
    }
  }
  releaseServerPort(reservation, options);
  return killed;
}

function readReservation(file: string): ServerReservation | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { port, ownerPid, claimedAt } = parsed as Record<string, unknown>;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return undefined;
  if (typeof ownerPid !== "number" || !Number.isInteger(ownerPid) || ownerPid <= 0) return undefined;
  return { port, ownerPid, claimedAt: typeof claimedAt === "number" ? claimedAt : 0 };
}

/**
 * Kills every reserved server whose owner is gone (or is this process), and
 * returns how many died.
 *
 * A reservation whose owner is still alive and is not us belongs to a
 * concurrent run and is untouched. A reservation with no running server behind
 * it is just a stale record: the file is dropped, nothing is signalled, and it
 * is not counted.
 *
 * The residual imprecision is PID reuse: if the owner's PID has been handed to
 * some other process, the reservation looks live and is skipped, so a leaked
 * server survives one extra run. That is a missed collection, never a wrong
 * kill, which is the direction this must fail in.
 */
export function reapAbandonedTestServers(options: { dir?: string } = {}): number {
  const dir = options.dir ?? registryDir();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  const running = new Map(listRunningTestServers().map((s) => [s.port, s]));
  let killed = 0;
  for (const name of files) {
    if (!/^port-\d+\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    const reservation = readReservation(file);
    if (reservation === undefined) {
      rmSync(file, { force: true }); // Unreadable record; there is nothing it can authorise.
      continue;
    }
    if (reservation.ownerPid !== process.pid && isAlive(reservation.ownerPid)) continue;
    const server = running.get(reservation.port);
    if (server !== undefined) {
      try {
        process.kill(server.pid, "SIGKILL");
        killed += 1;
      } catch {
        // Already gone.
      }
    }
    rmSync(file, { force: true });
  }
  return killed;
}

/** The reservations currently on disk, for the tests and for diagnostics. */
export function listReservations(options: { dir?: string } = {}): ServerReservation[] {
  const dir = options.dir ?? registryDir();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const reservations: ServerReservation[] = [];
  for (const name of files) {
    if (!/^port-\d+\.json$/.test(name)) continue;
    const reservation = readReservation(path.join(dir, name));
    if (reservation !== undefined) reservations.push(reservation);
  }
  return reservations.sort((a, b) => a.port - b.port);
}
