import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  startConcurrency,
  startSlotDir,
  sweepAbandonedStartSlots,
  withStartSlot,
} from "./start-semaphore.js";

/**
 * The start semaphore, tested as the concurrency primitive it claims to be.
 *
 * It had no tests at all, and the property it exists for — "at most N of these
 * run their body at once, on this machine, across processes" — is not
 * observable from a single process. So the tests below spawn REAL racers, each
 * a separate node process contending for the same slot directory, and recover
 * the maximum overlap from what they wrote down. That is the only shape in
 * which the previous implementation's defect was visible: it was configured for
 * 2 and admitted 3 to 5.
 *
 * Every child is spawned by this file, tracked, and killed in `afterEach`, so
 * nothing here can outlive the run or touch a process it did not start.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SEMAPHORE_SRC = path.join(here, "start-semaphore.ts");

/**
 * One racer. Timestamps are `performance.timeOrigin + performance.now()` —
 * wall-clock milliseconds with sub-millisecond resolution, and comparable
 * across processes, which `hrtime` counters are not guaranteed to be.
 */
const RACER = `
import { appendFileSync } from "node:fs";
import { withStartSlot } from ${JSON.stringify(SEMAPHORE_SRC)};

const [dir, log, slots, holdMs] = process.argv.slice(2);
const now = () => performance.timeOrigin + performance.now();
try {
  await withStartSlot(
    async () => {
      appendFileSync(log, \`enter \${process.pid} \${now()}\\n\`);
      await new Promise((r) => setTimeout(r, Number(holdMs)));
      appendFileSync(log, \`exit \${process.pid} \${now()}\\n\`);
    },
    { dir, slots: Number(slots), pollMs: 5, waitTimeoutMs: 60_000 },
  );
} catch (error) {
  appendFileSync(log, \`error \${process.pid} \${String(error).split("\\n")[0]}\\n\`);
  process.exitCode = 1;
}
`;

const temporary: string[] = [];
const children = new Set<ChildProcess>();

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meidoya-slot-test-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  for (const dir of temporary.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already gone, or never restricted.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

type Event = { kind: "enter" | "exit" | "error"; pid: number; at: number; detail: string };

function parseLog(log: string): Event[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [kind, pid, ...rest] = line.split(" ");
      return {
        kind: kind as Event["kind"],
        pid: Number(pid),
        at: Number(rest[0]),
        detail: rest.join(" "),
      };
    });
}

/** The largest number of racers that were inside `body` at the same instant. */
function maxOverlap(events: Event[]): number {
  const points = events
    .filter((e) => e.kind === "enter" || e.kind === "exit")
    .sort((a, b) => (a.at === b.at ? (a.kind === "exit" ? -1 : 1) : a.at - b.at));
  let current = 0;
  let peak = 0;
  for (const point of points) {
    current += point.kind === "enter" ? 1 : -1;
    peak = Math.max(peak, current);
  }
  return peak;
}

async function race(options: {
  dir: string;
  racers: number;
  slots: number;
  holdMs: number;
}): Promise<Event[]> {
  const script = path.join(tempDir(), "racer.mjs");
  writeFileSync(script, RACER, "utf8");
  const log = path.join(path.dirname(script), "race.log");
  writeFileSync(log, "", "utf8");
  await Promise.all(
    Array.from({ length: options.racers }, () => {
      const child = spawn(
        process.execPath,
        [script, options.dir, log, String(options.slots), String(options.holdMs)],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      children.add(child);
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      return new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => {
          children.delete(child);
          if (code !== 0 && stderr !== "") reject(new Error(`racer crashed: ${stderr}`));
          else resolve();
        });
      });
    }),
  );
  return parseLog(log);
}

describe("start slot admission", () => {
  it("uses a machine-wide directory, so two checkouts contend with each other", () => {
    expect(startSlotDir()).toBe(path.join(os.tmpdir(), "meidoya-temporal-starts"));
  });

  /**
   * THE PROPERTY. 24 real processes, a bound of 2, from a clean directory.
   *
   * The previous implementation failed this: it decided a slot's holder was
   * dead and then `rmSync`'d the file WITHOUT re-checking that it still held the
   * PID it had read, so a waiter could delete a slot another waiter had just
   * claimed. Measured at 3 simultaneous holders from clean.
   */
  it("never lets more than `slots` racers hold the semaphore at once", async () => {
    const dir = tempDir();
    const events = await race({ dir, racers: 24, slots: 2, holdMs: 60 });
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(events.filter((e) => e.kind === "enter")).toHaveLength(24);
    expect(maxOverlap(events)).toBeLessThanOrEqual(2);
  }, 60_000);

  /**
   * The same property from the state the self-healing exists for: a previous
   * run was killed and left tickets behind whose holders are gone.
   *
   * The previous implementation was WORSE here, not better — reclaiming a stale
   * slot was exactly the path that stole a live one, and it admitted 5.
   */
  it("holds the bound while reclaiming what a killed run left behind", async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    // PID 0x7FFFFFFF is not a legal process id on any platform this runs on, so
    // `kill(pid, 0)` reports it gone without ever naming a real process.
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(path.join(dir, `ticket-2147483647-dead-${String(i)}`), "", "utf8");
    }
    const events = await race({ dir, racers: 24, slots: 2, holdMs: 60 });
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(events.filter((e) => e.kind === "enter")).toHaveLength(24);
    expect(maxOverlap(events)).toBeLessThanOrEqual(2);
    // And the litter is gone rather than accumulating.
    expect(readdirSync(dir)).toEqual([]);
  }, 60_000);

  it("admits more when the bound is raised, so the bound is what is being measured", async () => {
    const dir = tempDir();
    const events = await race({ dir, racers: 12, slots: 4, holdMs: 80 });
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(maxOverlap(events)).toBeGreaterThan(2);
    expect(maxOverlap(events)).toBeLessThanOrEqual(4);
  }, 60_000);
});

describe("releasing a slot", () => {
  /**
   * A release must be able to delete only the releaser's OWN ticket. The
   * previous implementation released by slot index, so a holder that had been
   * displaced deleted whoever held that index next — the cascade that turned one
   * stolen slot into an unbounded number.
   */
  it("leaves every other holder's ticket alone", async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const neighbour = path.join(dir, `ticket-${String(process.pid)}-neighbour`);
    writeFileSync(neighbour, "", "utf8");

    await withStartSlot(async () => undefined, { dir, slots: 4, pollMs: 5 });

    expect(existsSync(neighbour)).toBe(true);
    expect(readdirSync(dir)).toEqual([`ticket-${String(process.pid)}-neighbour`]);
  });

  it("gives the slot back even when the body throws", async () => {
    const dir = tempDir();
    await expect(
      withStartSlot(async () => {
        throw new Error("boom");
      }, { dir, slots: 1, pollMs: 5 }),
    ).rejects.toThrow(/boom/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("failing rather than hanging", () => {
  /**
   * F9's second part. `tryTake` swallowed every error into `false`, so a slot
   * directory this user cannot write made `withStartSlot` loop forever: it never
   * returned AND never threw, the three-attempt retry above it never fired, and
   * every test file sat until the CI step timeout. That is the realistic Linux
   * CI shape, because the directory is created 0755 owned by whichever uid got
   * there first.
   */
  it("throws when the slot directory cannot be written, instead of waiting forever", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores the mode
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    await expect(
      Promise.race([
        withStartSlot(async () => "started", { dir, slots: 2, pollMs: 5, waitTimeoutMs: 30_000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("HUNG")), 5_000)),
      ]),
    ).rejects.toThrow(/EACCES|EPERM/);
  }, 20_000);

  it("bounds the wait and says what it was waiting for", async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    // Two tickets held by a process that is definitely alive: this one. Their
    // CONTENTS are empty on purpose — a holder is identified by the PID in the
    // ticket's NAME, because a reader that raced `writeFileSync` saw the entry
    // before the bytes and read an empty file. Reading the holder from contents
    // makes both of these look abandoned and this test go green for the wrong
    // reason; it was caught exactly that way under a full-suite run.
    writeFileSync(path.join(dir, `ticket-${String(process.pid)}-live-a`), "", "utf8");
    writeFileSync(path.join(dir, `ticket-${String(process.pid)}-live-b`), "", "utf8");
    const started = Date.now();
    await expect(
      withStartSlot(async () => "started", { dir, slots: 2, pollMs: 5, waitTimeoutMs: 300 }),
    ).rejects.toThrow(/waited 300ms for one of 2 Temporal server start slots/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  /**
   * The escape valve must not become a silent over-admission: if this waiter's
   * own ticket is reclaimed while it waits, it can no longer prove it is inside
   * the bound, so it fails instead of starting a server anyway.
   */
  it("refuses to proceed if its own ticket is reclaimed underneath it", async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const mine = `ticket-${String(process.pid)}-live-a`;
    writeFileSync(path.join(dir, mine), "", "utf8");
    const stealer = setInterval(() => {
      for (const name of readdirSync(dir)) {
        if (name !== mine) rmSync(path.join(dir, name), { force: true });
      }
    }, 5);
    try {
      await expect(
        withStartSlot(async () => "started", { dir, slots: 1, pollMs: 5, waitTimeoutMs: 5_000 }),
      ).rejects.toThrow(/was reclaimed while this process was still waiting/);
    } finally {
      clearInterval(stealer);
    }
  }, 20_000);
});

describe("sweeping abandoned tickets", () => {
  it("removes tickets whose holder is gone and keeps the ones held", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const live = `ticket-${String(process.pid)}-live`;
    writeFileSync(path.join(dir, "ticket-2147483647-dead"), "", "utf8");
    writeFileSync(path.join(dir, "ticket-not-a-pid"), "", "utf8");
    writeFileSync(path.join(dir, live), "", "utf8");
    writeFileSync(path.join(dir, "unrelated"), "x", "utf8");

    expect(sweepAbandonedStartSlots({ dir })).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([live, "unrelated"].sort());
  });

  it("is a no-op when the directory has never existed", () => {
    expect(sweepAbandonedStartSlots({ dir: path.join(tempDir(), "never") })).toBe(0);
  });
});

describe("startConcurrency", () => {
  const KEY = "MEIDOYA_TEMPORAL_START_CONCURRENCY";

  afterEach(() => {
    delete process.env[KEY];
  });

  it("defaults to a bound with real headroom under the SDK's 5s deadline", () => {
    delete process.env[KEY];
    expect(startConcurrency()).toBe(2);
  });

  it("is overridable", () => {
    process.env[KEY] = "3";
    expect(startConcurrency()).toBe(3);
  });

  it("refuses a value that would disable the bound", () => {
    for (const bad of ["0", "-1", "", "two", "1.5"]) {
      process.env[KEY] = bad;
      expect(() => startConcurrency()).toThrow(/must be a positive integer/);
    }
  });
});
