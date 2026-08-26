import { describe, expect, it } from "vitest";
import { CREDENTIAL_ENV_KEYS } from "./redaction.js";
import { minimalEnv, runBounded, spawnBounded } from "./subprocess.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe("runBounded", () => {
  it("captures stdout and stderr and the exit code", async () => {
    const result = await runBounded({
      command: "sh",
      args: ["-c", "echo out; echo err 1>&2; exit 3"],
    });
    expect(result.code).toBe(3);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.reason).toBe("exit");
    expect(result.stdoutTruncated).toBe(false);
  });

  it("passes stdin through", async () => {
    const result = await runBounded({ command: "cat", stdin: "hello" });
    expect(result.stdout).toBe("hello");
  });

  it("enforces a hard byte cap on stdout", async () => {
    const result = await runBounded({
      command: "sh",
      args: ["-c", "for i in $(seq 1 500); do echo 0123456789012345678901234567890123456789; done"],
      maxOutputBytes: 100,
    });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(100);
    expect(result.stdoutTruncated).toBe(true);
  });

  it("enforces a hard byte cap on stderr", async () => {
    const result = await runBounded({
      command: "sh",
      args: ["-c", "for i in $(seq 1 500); do echo noise 1>&2; done"],
      maxOutputBytes: 64,
    });
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64);
    expect(result.stderrTruncated).toBe(true);
  });

  it("kills on timeout and reports the reason", async () => {
    const result = await runBounded({
      command: "sh",
      args: ["-c", "sleep 30"],
      timeoutMs: 150,
      killGraceMs: 100,
    });
    expect(result.reason).toBe("timeout");
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it("cancels via AbortSignal", async () => {
    const controller = new AbortController();
    const pending = runBounded({
      command: "sh",
      args: ["-c", "sleep 30"],
      signal: controller.signal,
      killGraceMs: 100,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.reason).toBe("cancelled");
  });

  it("does not throw when the binary is missing", async () => {
    const result = await runBounded({ command: "meidoya-no-such-binary-xyz" });
    expect(result.code).toBeNull();
  });
});

describe("process group termination", () => {
  it("reaps grandchildren spawned by the child", async () => {
    const handle = spawnBounded({
      command: "sh",
      args: ["-c", "sleep 30 & echo $!; wait"],
      killGraceMs: 100,
    });

    let grandchildPid: number | undefined;
    for await (const line of handle.stdoutLines()) {
      grandchildPid = Number(line.trim());
      break;
    }

    expect(grandchildPid).toBeGreaterThan(0);
    expect(alive(grandchildPid as number)).toBe(true);

    handle.kill();
    const result = await handle.wait();
    expect(result.reason).toBe("cancelled");

    expect(await waitUntil(() => !alive(grandchildPid as number))).toBe(true);
  });

  it("reaps grandchildren on timeout too", async () => {
    const handle = spawnBounded({
      command: "sh",
      args: ["-c", "sleep 30 & echo $!; wait"],
      timeoutMs: 200,
      killGraceMs: 100,
    });

    let grandchildPid: number | undefined;
    for await (const line of handle.stdoutLines()) {
      grandchildPid = Number(line.trim());
      break;
    }

    const result = await handle.wait();
    expect(result.reason).toBe("timeout");
    expect(await waitUntil(() => !alive(grandchildPid as number))).toBe(true);
  });

  it("streams stdout line by line", async () => {
    const handle = spawnBounded({ command: "sh", args: ["-c", "echo a; echo b; echo c"] });
    const lines: string[] = [];
    for await (const line of handle.stdoutLines()) lines.push(line);
    await handle.wait();
    expect(lines).toEqual(["a", "b", "c"]);
  });
});

/**
 * The byte cap used to bind only `result.stdout`. `stdoutLines()` accumulated
 * `pending` and `lineQueue` outside it, so a child emitting one very long line
 * delivered a megabyte through the reader the invokers actually use while
 * `result.stdout` reported a neat 1 KB truncation. That is an OOM on an
 * execution node, dressed up as a satisfied invariant.
 */
describe("stdoutLines is bounded by the same cap as stdout", () => {
  it("does not deliver more than the cap from a single enormous line", async () => {
    const handle = spawnBounded({
      // One line, no newline until the very end: nothing can flush it early.
      command: "sh",
      args: ["-c", "for i in $(seq 1 200); do printf '0123456789%.0s' $(seq 1 500); done; echo"],
      maxOutputBytes: 1_000,
      killGraceMs: 100,
    });

    let delivered = 0;
    for await (const line of handle.stdoutLines()) delivered += line.length;
    const result = await handle.wait();

    // 1_000_000 characters were produced; the reader must not have held them.
    expect(delivered).toBeLessThanOrEqual(1_000);
    expect(result.stdoutLinesTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_000);
  }, 30_000);

  it("kills the process group when the line buffer overflows", async () => {
    const handle = spawnBounded({
      command: "sh",
      args: ["-c", "sleep 30 & echo $!; while :; do printf 'xxxxxxxxxxxxxxxxxxxx'; done"],
      maxOutputBytes: 500,
      // No `killOnOverflow`: an unbounded LINE kills regardless, because there
      // is no point at which dropping would relieve it.
      killGraceMs: 100,
    });

    let grandchildPid: number | undefined;
    for await (const line of handle.stdoutLines()) {
      grandchildPid = Number(line.trim());
      break;
    }

    const result = await handle.wait();
    expect(result.reason).toBe("overflow");
    if (grandchildPid !== undefined && grandchildPid > 0) {
      expect(await waitUntil(() => !alive(grandchildPid))).toBe(true);
    }
  }, 30_000);

  it("bounds the backlog of queued lines for a consumer that never reads", async () => {
    const handle = spawnBounded({
      command: "sh",
      args: ["-c", "for i in $(seq 1 5000); do echo 0123456789; done"],
      maxOutputBytes: 200,
      maxQueuedLines: 5,
    });

    // Deliberately let the child finish before touching stdoutLines().
    const result = await handle.wait();
    const lines: string[] = [];
    for await (const line of handle.stdoutLines()) lines.push(line);

    expect(lines.length).toBeLessThanOrEqual(5);
    expect(result.stdoutLinesTruncated).toBe(true);
  }, 30_000);

  it("leaves ordinary line streaming untouched", async () => {
    const handle = spawnBounded({ command: "sh", args: ["-c", "echo a; echo b; echo c"] });
    const lines: string[] = [];
    for await (const line of handle.stdoutLines()) lines.push(line);
    const result = await handle.wait();
    expect(lines).toEqual(["a", "b", "c"]);
    expect(result.stdoutLinesTruncated).toBe(false);
  });
});

describe("child environment", () => {
  /**
   * An obvious dummy. Never a real credential, and never printed: the
   * assertions below compare against the marker, they do not echo the child's
   * environment into the failure message.
   */
  const DUMMY = "not-a-real-key-000";

  it("does not inherit the parent environment when `env` is omitted", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = DUMMY;
    try {
      const result = await runBounded({
        command: "sh",
        args: ["-c", 'test -n "$ANTHROPIC_API_KEY" && echo leaked || echo clean'],
      });
      expect(result.stdout.trim()).toBe("clean");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("still gives the child PATH and HOME so it can be a working process", async () => {
    const result = await runBounded({
      command: "sh",
      args: ["-c", 'test -n "$PATH" && test -n "$HOME" && echo ok'],
    });
    expect(result.stdout.trim()).toBe("ok");
  });

  it("passes an explicit env through verbatim", async () => {
    const result = await runBounded({
      command: "/bin/sh",
      args: ["-c", 'echo "$MEIDOYA_MARKER"'],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MEIDOYA_MARKER: "explicit" },
    });
    expect(result.stdout.trim()).toBe("explicit");
  });

  it("minimalEnv copies only the non-credential keys", () => {
    const env = minimalEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: DUMMY,
      GITHUB_TOKEN: DUMMY,
      RANDOM_OPERATOR_VAR: "v",
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
    for (const key of CREDENTIAL_ENV_KEYS) expect(env[key]).toBeUndefined();
  });

  /**
   * `USER` and `LOGNAME` are not credentials, which is exactly why they
   * survived every review: nothing that looks for credentials looks at them.
   * They are the operator's login name, and `/Users/${USER}` (or
   * `/home/${USER}`) is the home directory that a scratch HOME exists to keep
   * a child out of — as an ABSOLUTE path, which no HOME substitution reaches.
   * Measured before this round: a sandboxed quality gate reported its scratch
   * HOME and the operator's login name in the same JSON object, and used the
   * second to read `~/.config/gh/hosts.yml`.
   *
   * Nothing a child legitimately needs is spelled `USER`; a process that wants
   * its own identity asks the OS, which still answers.
   */
  it("minimalEnv does not hand a child the operator's login name", () => {
    const env = minimalEnv({ PATH: "/usr/bin", HOME: "/home/x", USER: "operator", LOGNAME: "operator" });
    expect(env.USER).toBeUndefined();
    expect(env.LOGNAME).toBeUndefined();
    expect(Object.values(env)).not.toContain("operator");
  });
});
