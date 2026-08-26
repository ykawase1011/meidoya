import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Bounded subprocess primitive migrated from hermes-fleet (13 section 1).
 *
 * Invariants: output is capped at a hard byte limit, and termination always
 * targets the process GROUP so grandchildren cannot survive as orphans.
 *
 * The byte cap binds BOTH readers, not just `result.stdout`. The line reader
 * used to be exempt: `pending` accumulated an unbounded line and `lineQueue`
 * an unbounded number of them, so a child emitting one enormous line delivered
 * megabytes through `stdoutLines()` while `result.stdout` dutifully reported a
 * truncated 1 KB — the invariant held only for the field nobody reads, and the
 * execution node OOMed. Resident line-buffer memory is now bounded by
 * `maxLineBytes` (one line) and `maxQueuedLines` / `maxQueuedLineBytes` (the
 * backlog). Both set `stdoutLinesTruncated`; a single line past its cap also
 * kills the process GROUP unconditionally, because a line with no boundary in
 * sight is the one shape that can never be relieved by dropping.
 */
export type BoundedSubprocessOptions = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /**
   * The child's COMPLETE environment. Omitting it does NOT inherit this
   * process's environment: the default is `minimalEnv()`, so a caller that
   * forgets to think about the environment gets one with no credentials in it
   * rather than the node's whole keyring. See `minimalEnv`.
   */
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** Hard cap per stream. Bytes beyond the cap are dropped, never buffered. */
  readonly maxOutputBytes?: number;
  /**
   * Longest single line `stdoutLines()` will assemble. A line longer than this
   * is delivered truncated and its tail is discarded up to the next newline;
   * without it a child that never emits `\n` buffers without limit.
   * Defaults to `maxOutputBytes`.
   */
  readonly maxLineBytes?: number;
  /** Most lines held for a slow consumer. Defaults to 10_000. */
  readonly maxQueuedLines?: number;
  /** Most characters held for a slow consumer. Defaults to `maxOutputBytes`. */
  readonly maxQueuedLineBytes?: number;
  /** Terminate as soon as either stream, or the line buffer, hits its cap. */
  readonly killOnOverflow?: boolean;
  /** Delay between SIGTERM and the SIGKILL sweep of the group. */
  readonly killGraceMs?: number;
  readonly signal?: AbortSignal;
};

export type TerminationReason = "exit" | "timeout" | "cancelled" | "overflow";

export type BoundedProcessResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** True when `stdoutLines()` dropped output to stay inside its memory bound. */
  readonly stdoutLinesTruncated: boolean;
  readonly reason: TerminationReason;
  readonly durationMs: number;
};

export type BoundedProcessHandle = {
  readonly pid: number | undefined;
  /** Newline-delimited stdout, bounded by the same byte cap. */
  stdoutLines(): AsyncIterable<string>;
  /** Kills the whole process group. Safe to call repeatedly. */
  kill(signal?: NodeJS.Signals): void;
  wait(): Promise<BoundedProcessResult>;
};

/**
 * Variables a child needs to be a working process at all: where to find
 * binaries, where its home and scratch space are, and how to render text.
 * Nothing here names a credential.
 *
 * `USER` and `LOGNAME` USED TO BE HERE, and they are the reason this list is
 * worth a paragraph. A quality gate is given a scratch `HOME` precisely so it
 * cannot find the operator's home — and then `USER=yu` handed the answer back,
 * because `/Users/${USER}` is the operator's home on every macOS machine and
 * `/home/${USER}` on every Linux one. Measured end to end before this round,
 * a confined gate reported its scratch HOME and the operator's login name in
 * the same JSON object, and used the second to read `~/.config/gh/hosts.yml`
 * with an absolute path the first was supposed to have hidden. Nothing a child
 * legitimately needs is spelled `USER`: a process that wants its own identity
 * asks the OS (`getuid`), which still answers.
 */
export const MINIMAL_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
];

/**
 * The default child environment: `MINIMAL_ENV_KEYS` copied from `base`.
 *
 * WHY this is the DEFAULT rather than an opt-in: omitting `env` used to hand
 * the child `process.env` verbatim, which on an execution node is exactly
 * where `CREDENTIAL_ENV_KEYS` live. Every caller that spawns something it does
 * not fully trust — quality gates above all — then leaked the node's API keys
 * by writing no code at all, which is the one mistake no review catches. A
 * caller that genuinely wants the parent environment (the vendor runtime
 * adapters, which are the processes the credentials are FOR) says so by
 * passing `env` explicitly.
 */
export function minimalEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of MINIMAL_ENV_KEYS) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_QUEUED_LINES = 10_000;

/** Kill a whole process group; a negative pid addresses the group leader's group. */
export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // Group already gone (ESRCH) or not permitted; fall back to the direct pid.
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

class BoundedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): boolean {
    if (this.size >= this.cap) {
      this.truncated = true;
      return true;
    }
    const room = this.cap - this.size;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size = this.cap;
      this.truncated = true;
      return true;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    return false;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export function spawnBounded(options: BoundedSubprocessOptions): BoundedProcessHandle {
  const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const startedAt = Date.now();

  const child: ChildProcessWithoutNullStreams = spawn(options.command, [...(options.args ?? [])], {
    // WHY: detached puts the child in its own process group so one kill(-pid)
    // reaps every descendant it spawned.
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    // Never `...(env === undefined ? {} : …)`: an absent `env` means MINIMAL,
    // not INHERITED. See `minimalEnv`.
    env: options.env ?? minimalEnv(),
  }) as ChildProcessWithoutNullStreams;

  const stdout = new BoundedBuffer(cap);
  const stderr = new BoundedBuffer(cap);

  let reason: TerminationReason = "exit";
  let killed = false;
  let sigkillTimer: NodeJS.Timeout | undefined;

  const lineCap = Math.max(1, options.maxLineBytes ?? cap);
  const queuedLineCap = Math.max(1, options.maxQueuedLines ?? DEFAULT_MAX_QUEUED_LINES);
  const queuedByteCap = Math.max(1, options.maxQueuedLineBytes ?? cap);

  const lineQueue: string[] = [];
  let lineWaiters: Array<() => void> = [];
  let pending = "";
  let queuedChars = 0;
  /** Set while skipping the tail of a line that already exceeded `lineCap`. */
  let skippingLine = false;
  let linesTruncated = false;
  let stdoutEnded = false;

  const notify = (): void => {
    const waiters = lineWaiters;
    lineWaiters = [];
    for (const w of waiters) w();
  };

  const doKill = (signal: NodeJS.Signals = "SIGTERM"): void => {
    killed = true;
    killProcessGroup(child.pid, signal);
    if (sigkillTimer === undefined) {
      sigkillTimer = setTimeout(() => {
        killProcessGroup(child.pid, "SIGKILL");
      }, grace);
      sigkillTimer.unref?.();
    }
  };

  const terminate = (why: TerminationReason): void => {
    if (killed) return;
    reason = why;
    doKill("SIGTERM");
  };

  /**
   * Enqueues a completed line, or drops it to stay inside the memory bound.
   *
   * A BACKLOG overflow means the consumer is slower than the producer, which a
   * drop relieves; killing the child over it would be a denial of service on
   * ourselves. Only `killOnOverflow` escalates it.
   */
  const pushLine = (line: string): void => {
    if (lineQueue.length >= queuedLineCap || queuedChars + line.length > queuedByteCap) {
      linesTruncated = true;
      if (options.killOnOverflow === true) terminate("overflow");
      return;
    }
    lineQueue.push(line);
    queuedChars += line.length;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    const overflow = stdout.push(chunk);

    let rest = chunk.toString("utf8");
    for (let idx = rest.indexOf("\n"); idx >= 0; idx = rest.indexOf("\n")) {
      const segment = rest.slice(0, idx);
      rest = rest.slice(idx + 1);
      if (skippingLine) {
        // The head of this line was already delivered truncated; its tail goes
        // in the bin rather than in memory.
        skippingLine = false;
      } else {
        pushLine((pending + segment).replace(/\r$/, ""));
      }
      pending = "";
    }

    if (!skippingLine) {
      pending += rest;
      if (pending.length > lineCap) {
        // A single line past the cap is the OOM vector this primitive exists
        // to close: there is no boundary at which it would ever be flushed, so
        // it is NOT a truncation event to be tolerated like a full buffer. The
        // group dies regardless of `killOnOverflow`; the alternative is holding
        // an unbounded string for a child that has already misbehaved.
        pushLine(pending.slice(0, lineCap));
        pending = "";
        skippingLine = true;
        linesTruncated = true;
        terminate("overflow");
      }
    }

    notify();
    if (overflow && options.killOnOverflow === true) terminate("overflow");
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const overflow = stderr.push(chunk);
    if (overflow && options.killOnOverflow === true) terminate("overflow");
  });

  child.stdout.on("end", () => {
    if (pending.length > 0 && !skippingLine) pushLine(pending);
    pending = "";
    stdoutEnded = true;
    notify();
  });

  if (options.stdin !== undefined) {
    child.stdin.end(options.stdin);
  } else {
    child.stdin.end();
  }

  let timer: NodeJS.Timeout | undefined;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
    timer.unref?.();
  }

  const onAbort = (): void => terminate("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) terminate("cancelled");

  const result = new Promise<BoundedProcessResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // Sweep the group once more: the leader can exit while descendants linger.
      killProcessGroup(child.pid, "SIGKILL");
      if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
      stdoutEnded = true;
      notify();
      resolve({
        code,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutLinesTruncated: linesTruncated,
        reason,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("error", () => finish(null, null));
    child.on("close", (code, signal) => finish(code, signal));
  });

  async function* stdoutLines(): AsyncIterable<string> {
    for (;;) {
      while (lineQueue.length > 0) {
        const line = lineQueue.shift() as string;
        queuedChars -= line.length;
        yield line;
      }
      if (stdoutEnded) return;
      await new Promise<void>((res) => lineWaiters.push(res));
    }
  }

  return {
    pid: child.pid,
    stdoutLines,
    kill: (signal?: NodeJS.Signals) => {
      reason = "cancelled";
      doKill(signal ?? "SIGTERM");
    },
    wait: () => result,
  };
}

export async function runBounded(
  options: BoundedSubprocessOptions,
): Promise<BoundedProcessResult> {
  const handle = spawnBounded(options);
  return handle.wait();
}
