import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * How many ephemeral Temporal servers may be *starting* at the same moment.
 *
 * This bounds the start window only, not how many servers run concurrently, so
 * the suite keeps its file parallelism.
 *
 * Re-measured for this rewrite, on the machine this repo is developed on
 * (24 cores, idle), with the semaphore removed entirely and N servers started
 * from N separate processes released by one wall-clock barrier — time from
 * spawn to the SDK's connection succeeding, and whether it succeeded at all:
 *
 *   N=1  ok 3.45s (cold)   N=2  ok 1.58s   N=3  ok 2.19s   N=4  ok 2.90s
 *   N=5  ok 3.62s          N=6  ok 4.45-4.55s              N=7  ALL SEVEN FAIL
 *
 * The SDK gives a start 5 seconds and that deadline is compiled into the Rust
 * core bridge (`sdk-core/src/ephemeral_server/mod.rs`); there is no option for
 * it anywhere in the JS API. At N=7 every start missed it and leaked seven
 * ~34 MB servers, so this is not a tail risk — it is a cliff between 6 and 7,
 * and the suite has exactly seven files that need a server.
 *
 * A bound of 2 costs ~1.6s per start and leaves ~3.4s of headroom for the CPU
 * load a real run adds on top; 6 would leave 0.45s, which is no headroom at all.
 */
const DEFAULT_CONCURRENCY = 2;

/**
 * How long a waiter will wait for a slot before giving up LOUDLY.
 *
 * Unbounded waiting was the previous behaviour and it was the worse failure: an
 * unreadable slot directory made every waiter block forever with no error, so
 * the retry above this never fired and every test file sat until the CI step
 * timeout. A wait that ends in a thrown error is recoverable; one that never
 * ends is not.
 */
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

/**
 * How long a ticket may sit before another waiter is entitled to reclaim it.
 *
 * A ticket is held across one server start, so ~6s is the worst honest case.
 * Two minutes therefore only ever fires for a holder that is gone but whose PID
 * has been reused (so the liveness check says "alive"). Reclaiming is safe
 * because the victim is told: its own ticket vanishing is an error it throws on,
 * never a licence to proceed unbounded.
 */
const DEFAULT_MAX_HOLD_MS = 120_000;

const DEFAULT_POLL_MS = 40;

/**
 * A ticket is named `ticket-<pid>-<uuid>`, and the PID in that NAME is the only
 * record of who holds it.
 *
 * Not the file's contents: `writeFileSync` makes the directory entry visible
 * before the bytes land, so a reader that raced the write saw an empty file,
 * read no PID from it, concluded the holder was abandoned and reclaimed a slot
 * a live process was holding. That is the same class of defect as the one this
 * rewrite exists to fix, and it was caught by these tests under a full suite
 * run. A name is published atomically by the create itself, so there is no
 * window at all.
 */
const TICKET_PREFIX = "ticket-";

/** The PID a ticket's name attributes it to, or `undefined` if it has none. */
function holderOf(name: string): number | undefined {
  const match = /^ticket-(\d+)-/.exec(name);
  if (match?.[1] === undefined) return undefined;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function startConcurrency(): number {
  const raw = process.env["MEIDOYA_TEMPORAL_START_CONCURRENCY"];
  if (raw === undefined) return DEFAULT_CONCURRENCY;
  // The whole string, not a prefix of it: `parseInt` alone reads "1.5" as 1 and
  // "3 servers" as 3, so a typo in CI would silently pick a bound nobody chose.
  const parsed = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `MEIDOYA_TEMPORAL_START_CONCURRENCY must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * The semaphore lives in the OS temp dir, not in the repo, because the resource
 * it protects is machine-wide: the ephemeral server binary is a single
 * executable in that same temp dir, and two checkouts starting servers at once
 * contend exactly as hard as one checkout does.
 */
export function startSlotDir(): string {
  return path.join(os.tmpdir(), "meidoya-temporal-starts");
}

export type StartSlotOptions = {
  /** Overridden by the tests so real racers can contend without a shared machine. */
  dir?: string;
  slots?: number;
  waitTimeoutMs?: number;
  maxHoldMs?: number;
  pollMs?: number;
};

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/** True only for "this path is not there", which is the one benign race here. */
function isMissing(error: unknown): boolean {
  return isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — very much alive.
    return isErrnoException(error) && error.code === "EPERM";
  }
}

type Ticket = { name: string; mtimeNs: bigint };

/**
 * Where this waiter stands in the machine-wide queue, or `undefined` if its own
 * ticket is gone.
 *
 * Order is the tickets' `mtimeNs` — the instant the filesystem created them —
 * and NOT anything the waiter wrote into the name. That distinction is the
 * whole correctness argument: every observer reads the same creation instants,
 * and a ticket created after this waiter listed the directory necessarily has a
 * later `mtimeNs` than this waiter's own, so it can only rank behind. A
 * timestamp chosen by the waiter *before* creating its file would leave a window
 * in which two waiters each rank themselves first. Nanoseconds, via the bigint
 * stat, because `mtimeMs` is a lossy float and ties are what that window is.
 *
 * Reclaiming happens here and only here, and only for a ticket that is NOT ours.
 */
function rankOf(dir: string, ourName: string, maxHoldMs: number): number | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const now = Date.now();
  const live: Ticket[] = [];
  let ours = false;
  for (const name of names) {
    if (!name.startsWith(TICKET_PREFIX)) continue;
    const full = path.join(dir, name);
    let mtimeNs: bigint;
    let ageMs: number;
    try {
      const stat = statSync(full, { bigint: true });
      mtimeNs = stat.mtimeNs;
      ageMs = now - Number(stat.mtimeMs);
    } catch (error) {
      if (isMissing(error)) continue; // Released between the listing and the stat.
      throw error;
    }
    if (name === ourName) {
      ours = true;
      live.push({ name, mtimeNs });
      continue;
    }
    const holder = holderOf(name);
    if (holder === undefined || !isAlive(holder) || ageMs > maxHoldMs) {
      // Safe to delete: either nothing holds it, or it has been held far longer
      // than any start can take. Never our own ticket, so a reclaim can never
      // cascade into stealing the slot of the waiter doing the reclaiming.
      try {
        rmSync(full);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      continue;
    }
    live.push({ name, mtimeNs });
  }
  if (!ours) return undefined;
  live.sort((a, b) => (a.mtimeNs === b.mtimeNs ? (a.name < b.name ? -1 : 1) : a.mtimeNs < b.mtimeNs ? -1 : 1));
  return live.findIndex((t) => t.name === ourName);
}

/** Deletes tickets nothing is holding. Hygiene only; `rankOf` does it too. */
export function sweepAbandonedStartSlots(options: { dir?: string } = {}): number {
  const dir = options.dir ?? startSlotDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(TICKET_PREFIX)) continue;
    const full = path.join(dir, name);
    const holder = holderOf(name);
    if (holder !== undefined && isAlive(holder)) continue;
    try {
      rmSync(full);
      removed += 1;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return removed;
}

/**
 * Runs `body` with at most `slots - 1` other callers on this machine running
 * theirs, and always gives the slot back.
 *
 * The claim is one `O_EXCL` create of a file whose name contains a UUID, so it
 * always succeeds and can never collide. Admission is then decided by rank, and
 * **the only file this function ever deletes on its own behalf is that one**:
 * `rmSync` in the `finally` names a path no other process will ever create, so
 * releasing a slot cannot take one away from anybody. The previous
 * implementation deleted `slot-<n>` by index after deciding its holder was
 * dead, without re-checking that the file still held the PID it had read —
 * which let a waiter delete a slot another waiter had just claimed, and then let
 * the victim's own `finally` delete the thief's, cascading. Measured at 3 to 5
 * simultaneous holders against a configured bound of 2.
 *
 * Failures throw. Every filesystem error other than "it isn't there" propagates,
 * and the wait is bounded, because a semaphore that hangs is worse than one that
 * fails: a hang never reaches the retry above it.
 */
export async function withStartSlot<T>(
  body: () => Promise<T>,
  options: StartSlotOptions = {},
): Promise<T> {
  const dir = options.dir ?? startSlotDir();
  const slots = options.slots ?? startConcurrency();
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  mkdirSync(dir, { recursive: true });
  const name = `${TICKET_PREFIX}${String(process.pid)}-${randomUUID()}`;
  const ticket = path.join(dir, name);
  // `wx` so this is a create, never a truncate of somebody else's file. Any
  // error at all — EACCES on a directory this user cannot write, EROFS, ENOSPC
  // — is raised, not swallowed into a silent forever-wait.
  writeFileSync(ticket, String(process.pid), { flag: "wx" });

  const deadline = Date.now() + waitTimeoutMs;
  try {
    for (;;) {
      const rank = rankOf(dir, name, maxHoldMs);
      if (rank === undefined) {
        throw new Error(
          `Temporal start slot ${ticket} was reclaimed while this process was still waiting for ` +
            `it, so this waiter can no longer prove it is within the bound of ${String(slots)}. ` +
            `Refusing to start a server unbounded.`,
        );
      }
      if (rank < slots) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `waited ${String(waitTimeoutMs)}ms for one of ${String(slots)} Temporal server start ` +
            `slots in ${dir} and never got one (${String(rank + 1)} ahead in the queue). ` +
            `Starting a server without a slot is what this exists to prevent, so this fails instead.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs + Math.random() * pollMs));
    }
    return await body();
  } finally {
    rmSync(ticket, { force: true });
  }
}
