import type {
  NodeHeartbeat,
  NodeRegistration,
  RunEvent,
  RunRequest,
} from "@meidoya/node-protocol";

export type RegistrationOutcome = {
  accepted: boolean;
  grantedCapabilities: string[];
  grantedWorkspaces: string[];
  maxConcurrency: number;
  heartbeatIntervalMs: number;
  rejections: string[];
};

export type HeartbeatOutcome = {
  acknowledged: boolean;
  directive: "continue" | "drain" | "shutdown" | "re-register";
};

/** Narrow port onto the Control Plane; the transport lives elsewhere. */
export interface ControlPlanePort {
  registerNode(registration: NodeRegistration): Promise<RegistrationOutcome>;
  heartbeatNode(heartbeat: NodeHeartbeat): Promise<HeartbeatOutcome>;
}

export type RuntimeEvent =
  | { type: "spawned"; pid: number; pgid?: number }
  | { type: "session"; sessionId: string }
  | { type: "phase"; phase: string }
  | { type: "log"; message: string }
  | {
      type: "done";
      status: "succeeded" | "failed";
      externalSessionId?: string;
      structuredOutput?: unknown;
      errorClass?: string;
      retryable?: boolean;
      /**
       * "unknown" means an external side effect may or may not have landed;
       * the run must never be auto-retried (10 section 8).
       */
      sideEffectStatus?: "none" | "committed" | "unknown";
    };

export type RunContext = {
  /** Fixed cwd for this run, already narrowed to the project or worktree. */
  cwd: string;
  scope: RunRequest["scope"];
  signal: AbortSignal;
};

/** Injected agent runtime (codex / claude). Tests provide a fake. */
export interface AgentRuntimePort {
  execute(request: RunRequest, ctx: RunContext): AsyncIterable<RuntimeEvent>;
}

/** Terminates by process GROUP so orphaned children die with the run. */
export interface ProcessGroupKiller {
  killGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

/** Temporal activity heartbeat sink: phase + external session id. */
export interface ActivityHeartbeatSink {
  heartbeat(details: {
    runId: string;
    phase: string;
    sessionId?: string;
    attempt: number;
  }): void;
}

export interface RunEventSink {
  emit(event: RunEvent): void;
}

export type Clock = {
  now(): number;
};

export const systemClock: Clock = { now: () => Date.now() };
