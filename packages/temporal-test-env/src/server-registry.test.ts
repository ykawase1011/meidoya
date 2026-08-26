import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  listReservations,
  listRunningTestServers,
  reapAbandonedTestServers,
  reapReservation,
  registryDir,
  releaseServerPort,
  reserveServerPort,
  TEST_SERVER_BINARY,
} from "./server-registry.js";

/**
 * WHO THIS CODE IS ALLOWED TO KILL.
 *
 * The previous reaper decided that with `getppid() == 1` and a substring match
 * on the whole command line, which is not ownership: a disowned
 * `tail -f …temporal-test-server-….log` matched it, a server started under
 * `nohup` or launchd matched it, and inside a container every process matches
 * it because every tree roots at PID 1. Nothing tested any of that, so nothing
 * would have noticed.
 *
 * These tests fix the boundary in both directions — what MUST be reaped and
 * what MUST NOT — and every process they use is one they spawned themselves,
 * tracked and SIGKILLed in `afterEach`. A stand-in server is a symlink to
 * `/bin/sleep` named like the real binary, executed with a port as its only
 * argument, so its argv is byte-for-byte the shape the SDK produces:
 * `<…/temporal-test-server-sdk-typescript-…> <port>`.
 */

const temporary: string[] = [];
const children = new Set<ChildProcess>();

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meidoya-registry-test-"));
  temporary.push(dir);
  return dir;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A process that looks exactly like a running ephemeral test server. */
function fakeServer(dir: string, port: number, suffix = "1.22.0"): ChildProcess {
  const link = path.join(dir, `${TEST_SERVER_BINARY}-${suffix}`);
  if (!existsSync(link)) symlinkSync("/bin/sleep", link);
  const child = spawn(link, [String(port)], { stdio: "ignore" });
  children.add(child);
  return child;
}

async function settle(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recognising a test server", () => {
  it("uses the machine-wide temp dir for its journal", () => {
    expect(registryDir()).toBe(path.join(os.tmpdir(), "meidoya-temporal-servers"));
  });

  it("finds a process whose argv is the binary and a port", async () => {
    const dir = tempDir();
    const child = fakeServer(dir, 45111);
    await settle();
    const found = listRunningTestServers().find((s) => s.pid === child.pid);
    expect(found?.port).toBe(45111);
    expect(path.basename(found?.executable ?? "")).toMatch(new RegExp(`^${TEST_SERVER_BINARY}`));
  }, 20_000);

  /**
   * F9's third part, reproduced. The old predicate was
   * `command.includes(TEST_SERVER_BINARY)` over the WHOLE command line, so a
   * live, unrelated process that merely names the binary in an ARGUMENT was
   * listed as an orphaned server and SIGKILLed. Matching argv[0]'s basename is
   * what makes that impossible.
   */
  it("does not mistake a process that merely mentions the binary for one", async () => {
    const logPath = path.join(tempDir(), `${TEST_SERVER_BINARY}-1.22.0.log`);
    writeFileSync(logPath, "", "utf8");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 600000)", logPath], {
      stdio: "ignore",
    });
    children.add(child);
    await settle();
    expect(child.pid).toBeDefined();
    expect(isAlive(child.pid ?? 0)).toBe(true);
    expect(listRunningTestServers().map((s) => s.pid)).not.toContain(child.pid);
  }, 20_000);

  /**
   * The same defect with the port check satisfied too, so the argv[0] rule is
   * what is on trial rather than the "last token is a number" rule. This is the
   * shape of a supervisor or wrapper holding a live server: the binary is named
   * in its arguments and the line ends in a port. Substring-matching the command
   * line calls this a server; matching argv[0] does not.
   */
  it("does not mistake a supervisor holding a server for the server", async () => {
    const dir = tempDir();
    const link = path.join(dir, `${TEST_SERVER_BINARY}-1.22.0`);
    symlinkSync("/bin/sleep", link);
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => undefined, 600000)", link, "45888"],
      { stdio: "ignore" },
    );
    children.add(child);
    await settle();
    expect(isAlive(child.pid ?? 0)).toBe(true);
    expect(listRunningTestServers().map((s) => s.pid)).not.toContain(child.pid);
  }, 20_000);

  it("does not mistake the binary run without a port for a server", async () => {
    const dir = tempDir();
    const link = path.join(dir, `${TEST_SERVER_BINARY}-1.22.0`);
    symlinkSync("/bin/sleep", link);
    const child = spawn(link, ["600", "--extra"], { stdio: "ignore" });
    children.add(child);
    await settle();
    expect(listRunningTestServers().map((s) => s.pid)).not.toContain(child.pid);
  }, 20_000);
});

describe("reserving a port", () => {
  it("records the reservation before the server exists, naming this process", async () => {
    const dir = tempDir();
    const reservation = await reserveServerPort({ dir });
    expect(reservation.ownerPid).toBe(process.pid);
    expect(reservation.port).toBeGreaterThan(0);
    expect(listReservations({ dir })).toEqual([reservation]);
    releaseServerPort(reservation, { dir });
    expect(listReservations({ dir })).toEqual([]);
  });

  it("hands out a port nothing is listening on", async () => {
    const dir = tempDir();
    const a = await reserveServerPort({ dir });
    const b = await reserveServerPort({ dir });
    expect(a.port).not.toBe(b.port);
  });
});

describe("reaping this process's own leak", () => {
  /**
   * F9's fourth part. The old intra-run reap keyed on `PPID == 1`, and a server
   * leaked by a failed start is a child of the still-alive vitest worker, so it
   * NEVER matched during the run it leaked in — the check was a no-op for the
   * exact leak it was written for. Reaping by reservation works while the owner
   * is alive, because ownership no longer means orphanhood.
   */
  it("kills the server on its own reserved port while this process is alive", async () => {
    const dir = tempDir();
    const reservation = await reserveServerPort({ dir });
    const child = fakeServer(dir, reservation.port);
    await settle();
    expect(isAlive(child.pid ?? 0)).toBe(true);

    expect(reapReservation(reservation, { dir })).toBe(true);
    await settle();
    expect(isAlive(child.pid ?? 0)).toBe(false);
    expect(listReservations({ dir })).toEqual([]);
  }, 20_000);

  it("kills the server on its own port and no other", async () => {
    const dir = tempDir();
    const mine = await reserveServerPort({ dir });
    const theirs = fakeServer(dir, 45999);
    const ours = fakeServer(dir, mine.port);
    await settle();

    expect(reapReservation(mine, { dir })).toBe(true);
    await settle();
    expect(isAlive(ours.pid ?? 0)).toBe(false);
    expect(isAlive(theirs.pid ?? 0)).toBe(true);
  }, 20_000);

  it("reports nothing killed when the start left no server behind", async () => {
    const dir = tempDir();
    const reservation = await reserveServerPort({ dir });
    expect(reapReservation(reservation, { dir })).toBe(false);
    expect(listReservations({ dir })).toEqual([]);
  });
});

describe("reaping what a killed run left behind", () => {
  it("kills a reserved server whose owner is gone", async () => {
    const dir = tempDir();
    const reservation = await reserveServerPort({ dir });
    const child = fakeServer(dir, reservation.port);
    await settle();
    // Rewrite the reservation as a dead owner's: 0x7FFFFFFF is not a legal PID
    // on any platform this runs on, so no real process is ever named.
    writeFileSync(
      path.join(dir, `port-${String(reservation.port)}.json`),
      JSON.stringify({ ...reservation, ownerPid: 2_147_483_647 }),
      "utf8",
    );

    expect(reapAbandonedTestServers({ dir })).toBe(1);
    await settle();
    expect(isAlive(child.pid ?? 0)).toBe(false);
    expect(listReservations({ dir })).toEqual([]);
  }, 20_000);

  /**
   * THE BOUNDARY. A server on a port nobody reserved is somebody else's — a
   * developer's `nohup`'d server, another tool's, a colleague's session on a
   * shared box. It is not litter and this must not touch it.
   */
  it("never kills a server it holds no reservation for", async () => {
    const dir = tempDir();
    const child = fakeServer(dir, 45222);
    await settle();

    expect(reapAbandonedTestServers({ dir })).toBe(0);
    await settle();
    expect(isAlive(child.pid ?? 0)).toBe(true);
  }, 20_000);

  /**
   * And a reservation held by a LIVE process belongs to a concurrent run — a
   * second checkout, a `pnpm test` in another terminal. Killing it would break
   * that run, which is exactly what `PPID == 1` did inside a container.
   */
  it("leaves a concurrent run's reservation and server alone", async () => {
    const dir = tempDir();
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 600000)"], {
      stdio: "ignore",
    });
    children.add(owner);
    const reservation = await reserveServerPort({ dir });
    const child = fakeServer(dir, reservation.port);
    await settle();
    writeFileSync(
      path.join(dir, `port-${String(reservation.port)}.json`),
      JSON.stringify({ ...reservation, ownerPid: owner.pid }),
      "utf8",
    );

    expect(reapAbandonedTestServers({ dir })).toBe(0);
    await settle();
    expect(isAlive(child.pid ?? 0)).toBe(true);
    expect(listReservations({ dir })).toHaveLength(1);
  }, 20_000);

  it("drops a stale record with no server behind it, without counting a kill", async () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "port-45333.json"),
      JSON.stringify({ port: 45333, ownerPid: 2_147_483_647, claimedAt: 0 }),
      "utf8",
    );
    expect(reapAbandonedTestServers({ dir })).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("drops an unreadable record rather than acting on it", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "port-45444.json"), "{not json", "utf8");
    writeFileSync(path.join(dir, "port-45555.json"), JSON.stringify({ port: "nope" }), "utf8");
    writeFileSync(path.join(dir, "unrelated.txt"), "keep me", "utf8");
    expect(reapAbandonedTestServers({ dir })).toBe(0);
    expect(readdirSync(dir)).toEqual(["unrelated.txt"]);
  });

  it("is a no-op when no run has ever reserved anything", () => {
    expect(reapAbandonedTestServers({ dir: path.join(tempDir(), "never") })).toBe(0);
  });
});
