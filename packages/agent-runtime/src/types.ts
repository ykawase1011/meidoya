import type {
  ModelProfile,
  Provider,
  Role,
  WorkerCapability,
  WorkerProfile,
} from "@meidoya/domain";
import type { AgentRunScope } from "@meidoya/node-protocol";

/**
 * Vendor-neutral runtime contract (09 section 1).
 *
 * WHY: nothing Codex- or Claude-specific may appear in this package. Adapters
 * translate their own wire formats into these types at their boundary.
 */
export type StructuredOutputKind =
  | "MaidDecision"
  | "ExecutionPlan"
  | "ManagerDecision"
  | "WorkerResult"
  | "ReviewFindings";

export type AgentRunInput = {
  readonly runId: string;
  readonly role: Role;
  readonly workerProfile?: WorkerProfile;
  readonly provider: Provider;
  readonly modelProfile: ModelProfile;
  /** Concrete vendor model name, already resolved by the model-router config mapping. */
  readonly resolvedModel: string;
  readonly scope: AgentRunScope;
  readonly capabilities: readonly WorkerCapability[];
  readonly prompt: string;
  readonly structuredOutput?: StructuredOutputKind;
  readonly workdir?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};

export type AgentResumeInput = AgentRunInput & {
  /** External (vendor) session/thread id persisted by the Control Plane. */
  readonly externalSessionId: string;
};

export type AgentEventBase = {
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: number;
};

export type AgentEvent =
  | (AgentEventBase & { readonly type: "session"; readonly externalSessionId: string })
  | (AgentEventBase & { readonly type: "phase"; readonly phase: string })
  | (AgentEventBase & {
      readonly type: "log";
      readonly level: "debug" | "info" | "warn" | "error";
      readonly message: string;
    })
  | (AgentEventBase & { readonly type: "message"; readonly text: string })
  | (AgentEventBase & {
      readonly type: "awaiting-user";
      readonly question: string;
    })
  | (AgentEventBase & {
      readonly type: "result";
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly text?: string;
      readonly structuredOutput?: unknown;
      readonly errorClass?: string;
      readonly retryable?: boolean;
    });

export type AgentRuntimeCapabilities = {
  readonly provider: Provider;
  readonly supportsResume: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsStreaming: boolean;
  readonly modelProfiles: readonly ModelProfile[];
  readonly grantableCapabilities: readonly WorkerCapability[];
};

export interface AgentRuntime {
  readonly id: string;

  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  resume(input: AgentResumeInput): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
  capabilities(): AgentRuntimeCapabilities;
}
