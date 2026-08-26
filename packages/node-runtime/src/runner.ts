import type {
  AgentRunScope,
  RunEvent,
  RunRequest,
  RunResult,
} from "@meidoya/node-protocol";
import { ConcurrencyLimiter } from "./concurrency.js";
import {
  systemClock,
  type ActivityHeartbeatSink,
  type AgentRuntimePort,
  type Clock,
  type ProcessGroupKiller,
  type RunEventSink,
  type RuntimeEvent,
} from "./ports.js";
import { sealRunScope, type ScopeEscalationAttempt } from "./run-scope.js";

type RuntimeDoneEvent = Extract<RuntimeEvent, { type: "done" }>;

/** Authoritative scope + cwd come from the Control Plane assignment. */
export interface RunAssignmentPort {
  authoritativeScope(request: RunRequest): AgentRunScope;
  /** Fixed per-worker cwd, narrowed to the project or task worktree. */
  workingDirectory(request: RunRequest, scope: AgentRunScope): string;
  /**
   * Re-check, at the moment of spawn, that the cwd chosen by
   * `workingDirectory` still resolves to the same real directory, and throw if
   * it does not. The run then queues, so the gap between choosing the cwd and
   * executing in it is unbounded — long enough for the directory or an ancestor
   * to be swapped for a symlink that escapes the sandbox. Returns the
   * re-verified absolute path, which is what the runtime is actually handed.
   */
  verifyWorkingDirectory(
    request: RunRequest,
    scope: AgentRunScope,
    cwd: string,
  ): string;
}

export type NodeRunnerOptions = {
  runtime: AgentRuntimePort;
  assignment: RunAssignmentPort;
  events: RunEventSink;
  activityHeartbeat: ActivityHeartbeatSink;
  killer: ProcessGroupKiller;
  maxConcurrency: number;
  clock?: Clock;
  /** Delay between SIGTERM and SIGKILL on cancel. */
  killGraceMs?: number;
  onIgnoredEscalation?: (
    runId: string,
    attempts: ScopeEscalationAttempt[],
  ) => void;
};

type ActiveRun = {
  runId: string;
  controller: AbortController;
  pgid: number | undefined;
  phase: string;
  sessionId: string | undefined;
  cancelled: boolean;
};

export class NodeRunner {
  private readonly limiter: ConcurrencyLimiter;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly clock: Clock;

  constructor(private readonly options: NodeRunnerOptions) {
    this.limiter = new ConcurrencyLimiter(options.maxConcurrency);
    this.clock = options.clock ?? systemClock;
  }

  get activeRunCount(): number {
    return this.runs.size;
  }

  get queuedRunCount(): number {
    return this.limiter.queuedCount;
  }

  setMaxConcurrency(limit: number): void {
    this.limiter.setLimit(limit);
  }

  async run(request: RunRequest, attempt = 1): Promise<RunResult> {
    const authoritative = this.options.assignment.authoritativeScope(request);
    const sealed = sealRunScope(request, authoritative);
    if (sealed.ignoredEscalations.length > 0) {
      this.options.onIgnoredEscalation?.(
        request.runId,
        sealed.ignoredEscalations,
      );
    }
    const sealedRequest = sealed.request;
    const cwd = this.options.assignment.workingDirectory(
      sealedRequest,
      authoritative,
    );

    const active: ActiveRun = {
      runId: request.runId,
      controller: new AbortController(),
      pgid: undefined,
      phase: "queued",
      sessionId: undefined,
      cancelled: false,
    };
    this.runs.set(request.runId, active);

    let sequence = 0;
    const emit = (
      type: RunEvent["type"],
      extra: { phase?: string; sessionId?: string } = {},
    ): void => {
      const event: RunEvent = {
        runId: request.runId,
        sequence: sequence++,
        type,
        timestamp: this.clock.now(),
        ...(extra.phase === undefined ? {} : { phase: extra.phase }),
        ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
      };
      this.options.events.emit(event);
    };

    const beat = (): void => {
      this.options.activityHeartbeat.heartbeat({
        runId: request.runId,
        phase: active.phase,
        ...(active.sessionId === undefined
          ? {}
          : { sessionId: active.sessionId }),
        attempt,
      });
    };

    try {
      return await this.limiter.run(async () => {
        active.phase = "starting";
        emit("phase", { phase: active.phase });
        beat();
        return await this.consume(sealedRequest, active, cwd, emit, beat);
      });
    } finally {
      this.runs.delete(request.runId);
    }
  }

  private async consume(
    request: RunRequest,
    active: ActiveRun,
    cwd: string,
    emit: (
      type: RunEvent["type"],
      extra?: { phase?: string; sessionId?: string },
    ) => void,
    beat: () => void,
  ): Promise<RunResult> {
    try {
      // Time-of-check to time-of-use: `cwd` was resolved before this run
      // queued. Re-verify it right here, so the path the runtime is spawned
      // into is one that resolved inside the sandbox a moment ago, not minutes
      // ago. A swap between the two is a violation and the run never starts.
      const verifiedCwd = this.options.assignment.verifyWorkingDirectory(
        request,
        request.scope,
        cwd,
      );
      const iterator = this.options.runtime.execute(request, {
        cwd: verifiedCwd,
        scope: request.scope,
        signal: active.controller.signal,
      });

      for await (const event of iterator) {
        switch (event.type) {
          case "spawned":
            active.pgid = event.pgid ?? event.pid;
            break;
          case "session":
            active.sessionId = event.sessionId;
            emit("session-id", { sessionId: event.sessionId });
            beat();
            break;
          case "phase":
            active.phase = event.phase;
            emit("phase", { phase: event.phase });
            beat();
            break;
          case "log":
            // Internal progress stays on the node/log side, never in chat.
            emit("log");
            break;
          case "done":
            emit("heartbeat", { phase: active.phase });
            return this.finish(request, active, event);
        }
      }

      return {
        runId: request.runId,
        status: "failed",
        errorClass: "runtime_stream_ended_without_result",
        retryable: true,
      };
    } catch (error) {
      if (active.cancelled) {
        return { runId: request.runId, status: "cancelled" };
      }
      return {
        runId: request.runId,
        status: "failed",
        errorClass:
          error instanceof Error ? error.name : "unknown_runtime_error",
        retryable: true,
        ...(active.sessionId === undefined
          ? {}
          : { externalSessionId: active.sessionId }),
      };
    }
  }

  private finish(
    request: RunRequest,
    active: ActiveRun,
    event: RuntimeDoneEvent,
  ): RunResult {
    const sessionId = event.externalSessionId ?? active.sessionId;
    const base = {
      runId: request.runId,
      ...(sessionId === undefined ? {} : { externalSessionId: sessionId }),
    };

    if (active.cancelled) {
      return { ...base, status: "cancelled" };
    }

    // Unknown external side effect: never auto-retry, surface for a human.
    if (event.sideEffectStatus === "unknown") {
      return {
        ...base,
        status: "failed",
        errorClass: "needs_attention",
        retryable: false,
        ...(event.structuredOutput === undefined
          ? {}
          : { structuredOutput: event.structuredOutput }),
      };
    }

    if (event.status === "succeeded") {
      return {
        ...base,
        status: "succeeded",
        ...(event.structuredOutput === undefined
          ? {}
          : { structuredOutput: event.structuredOutput }),
      };
    }

    return {
      ...base,
      status: "failed",
      errorClass: event.errorClass ?? "runtime_failed",
      retryable: event.retryable ?? true,
    };
  }

  /**
   * Cancel terminates the whole process GROUP: agent CLIs spawn children that
   * would otherwise survive a plain pid kill.
   */
  cancel(runId: string, options: { graceMs?: number } = {}): boolean {
    const active = this.runs.get(runId);
    if (active === undefined) return false;
    active.cancelled = true;
    active.controller.abort();
    if (active.pgid !== undefined) {
      this.options.killer.killGroup(active.pgid, "SIGTERM");
      const grace = options.graceMs ?? this.options.killGraceMs ?? 5_000;
      const timer = setTimeout(() => {
        if (this.runs.has(runId) && active.pgid !== undefined) {
          this.options.killer.killGroup(active.pgid, "SIGKILL");
        }
      }, grace);
      timer.unref?.();
    }
    return true;
  }

  cancelAll(): void {
    for (const runId of [...this.runs.keys()]) this.cancel(runId);
  }
}
