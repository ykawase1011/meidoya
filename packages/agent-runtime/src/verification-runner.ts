import { spawnBounded, type BoundedProcessHandle } from "./subprocess.js";

/**
 * The one verification command runner. Both the control plane (meidoyad) and
 * execution nodes (meidoya-node) wrap this; neither implements spawning itself.
 *
 * Invariants (10 section 2):
 *  - No shell, ever. The argv comes from the operator's allowlist, so a plan can
 *    only pick an entry; `;`, `&&`, `$(…)` and friends are just characters that
 *    never appear in an allowlisted argv and are never interpreted.
 *  - Termination kills the process GROUP (via spawnBounded), so a gate that
 *    backgrounds a grandchild cannot leave it running after timeout or cancel.
 *  - Cancellation is real: pass an AbortSignal and every in-flight gate dies.
 */

/**
 * Structurally compatible with `QualityGateCommand` from `@meidoya/task-engine`
 * (declared locally to keep this package free of a task-engine dependency).
 */
export type AllowedCommand = {
  readonly name: string;
  readonly argv: readonly string[];
};

export type AllowedCommandCatalog = readonly AllowedCommand[];

export type VerificationCommandSpec = {
  readonly name: string;
  readonly cwd?: string;
  /** Ignored by design: legacy free-form command lines are never executed. */
  readonly command?: string;
};

export type VerificationCommandResult = {
  exitCode: number;
  durationMs: number;
  resolvedCommand?: string;
  failureSignature?: string;
};

export type VerificationCommandRunnerOptions = {
  /** Operator-configured gates. Anything not listed here cannot run. */
  readonly catalog: AllowedCommandCatalog;
  /** Working directory used when a spec carries none. */
  readonly cwd: string;
  /**
   * Resolves (and authorises) the working directory, e.g. a filesystem sandbox.
   * Throwing denies the run without spawning anything.
   */
  readonly resolveCwd?: (cwd: string) => string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  /** Delay between SIGTERM and the SIGKILL sweep of the process group. */
  readonly killGraceMs?: number;
  /** Cancels every in-flight and subsequent gate (kills the process group). */
  readonly signal?: AbortSignal;
};

/** Exit codes reported for refusals, chosen not to collide with a real gate. */
export const VERIFICATION_EXIT = {
  denied: 126,
  spawnError: 127,
  timeout: 124,
  cancelled: 125,
} as const;

/**
 * `gate` or `group:gate`. Mirrors `QUALITY_GATE_SELECTOR_PATTERN` in
 * `@meidoya/task-engine`; kept in sync by quality-gates.test.ts there.
 */
export const QUALITY_GATE_SELECTOR_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const NAME_SELECTOR = QUALITY_GATE_SELECTOR_PATTERN;

function gateKey(selector: string): string {
  const sep = selector.lastIndexOf(":");
  return sep > 0 ? selector.slice(sep + 1) : selector;
}

export type VerificationCommandRunner = {
  run(spec: VerificationCommandSpec): Promise<VerificationCommandResult>;
  /**
   * Kills every gate this runner still has running and detaches from the
   * caller's AbortSignal. Safe to call repeatedly, and REQUIRED once the work
   * the runner was made for has settled: a runner per activity that never
   * detached left one retained `abort` listener per activity on a
   * process-lifetime signal, each one pinning that runner's `inFlight` set and
   * catalog for as long as the signal lived.
   */
  cancel(): void;
};

export function createVerificationCommandRunner(
  options: VerificationCommandRunnerOptions,
): VerificationCommandRunner {
  const inFlight = new Set<BoundedProcessHandle>();
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
    // `{ once: true }` only removes the listener when the signal actually
    // fires; the common case is a runner that finishes and is never aborted.
    options.signal?.removeEventListener("abort", cancel);
    for (const handle of inFlight) handle.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", cancel, { once: true });

  return {
    cancel,
    async run(spec: VerificationCommandSpec): Promise<VerificationCommandResult> {
      const started = Date.now();
      const deny = (signature: string): VerificationCommandResult => ({
        exitCode: VERIFICATION_EXIT.denied,
        durationMs: Date.now() - started,
        failureSignature: `${spec.name}:${signature}`,
      });

      if (cancelled || options.signal?.aborted === true) {
        return {
          exitCode: VERIFICATION_EXIT.cancelled,
          durationMs: Date.now() - started,
          failureSignature: `${spec.name}:cancelled`,
        };
      }
      if (!NAME_SELECTOR.test(spec.name)) return deny("invalid-command-name");

      const key = gateKey(spec.name);
      const gate = options.catalog.find((c) => c.name === key);
      const argv0 = gate?.argv[0];
      if (gate === undefined || argv0 === undefined) return deny("command-not-allowlisted");

      let cwd: string;
      try {
        cwd = options.resolveCwd?.(spec.cwd ?? options.cwd) ?? spec.cwd ?? options.cwd;
      } catch (error) {
        return deny(`sandbox-denied:${(error as Error).name}`);
      }

      const resolvedCommand = gate.argv.join(" ");
      const handle = spawnBounded({
        command: argv0,
        args: gate.argv.slice(1),
        cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxOutputBytes === undefined
          ? {}
          : { maxOutputBytes: options.maxOutputBytes }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
        killOnOverflow: true,
      });
      inFlight.add(handle);
      // A cancel that landed between the check above and the spawn still wins.
      if (cancelled) handle.kill("SIGTERM");
      try {
        const result = await handle.wait();
        const durationMs = Date.now() - started;
        if (result.reason === "timeout") {
          return {
            exitCode: VERIFICATION_EXIT.timeout,
            durationMs,
            resolvedCommand,
            failureSignature: `${spec.name}:timeout`,
          };
        }
        if (result.reason === "cancelled") {
          return {
            exitCode: VERIFICATION_EXIT.cancelled,
            durationMs,
            resolvedCommand,
            failureSignature: `${spec.name}:cancelled`,
          };
        }
        if (result.code === null) {
          return {
            exitCode: VERIFICATION_EXIT.spawnError,
            durationMs,
            resolvedCommand,
            failureSignature: `${spec.name}:spawn-error`,
          };
        }
        return {
          exitCode: result.code,
          durationMs,
          resolvedCommand,
          ...(result.code === 0 ? {} : { failureSignature: `${spec.name}:exit-${result.code}` }),
        };
      } finally {
        inFlight.delete(handle);
      }
    },
  };
}
