import type { AgentEvent, AgentResumeInput, AgentRunInput, AgentRuntime } from "./types.js";

/**
 * 09 section 10: while waiting on a user the process must be terminated and only
 * the external session id persisted. Task state is reconstructed elsewhere.
 */
export type PersistedSession = {
  readonly runId: string;
  readonly externalSessionId: string;
};

export type RunOutcome =
  | {
      readonly status: "succeeded";
      readonly session?: PersistedSession;
      readonly text?: string;
      readonly structuredOutput?: unknown;
    }
  | {
      readonly status: "waiting_user";
      readonly question: string;
      readonly session?: PersistedSession;
    }
  | {
      readonly status: "failed";
      readonly errorClass: string;
      readonly retryable: boolean;
      readonly session?: PersistedSession;
    }
  | { readonly status: "cancelled"; readonly session?: PersistedSession };

export type DriveOptions = {
  readonly onEvent?: (event: AgentEvent) => void;
};

async function drive(
  runtime: AgentRuntime,
  runId: string,
  events: AsyncIterable<AgentEvent>,
  options: DriveOptions,
): Promise<RunOutcome> {
  let sessionId: string | undefined;
  let lastText: string | undefined;

  const session = (): { session: PersistedSession } | Record<string, never> =>
    sessionId === undefined ? {} : { session: { runId, externalSessionId: sessionId } };

  for await (const event of events) {
    options.onEvent?.(event);
    switch (event.type) {
      case "session":
        sessionId = event.externalSessionId;
        break;
      case "message":
        lastText = event.text;
        break;
      case "awaiting-user": {
        // Terminate the process; keep only the external session id.
        await runtime.cancel(runId);
        return { status: "waiting_user", question: event.question, ...session() };
      }
      case "result": {
        if (event.status === "succeeded") {
          const text = event.text ?? lastText;
          return {
            status: "succeeded",
            ...(text === undefined ? {} : { text }),
            ...(event.structuredOutput === undefined
              ? {}
              : { structuredOutput: event.structuredOutput }),
            ...session(),
          };
        }
        if (event.status === "cancelled") return { status: "cancelled", ...session() };
        return {
          status: "failed",
          errorClass: event.errorClass ?? "unknown",
          retryable: event.retryable ?? false,
          ...session(),
        };
      }
      default:
        break;
    }
  }

  return { status: "failed", errorClass: "stream_ended_without_result", retryable: true, ...session() };
}

export function driveRun(
  runtime: AgentRuntime,
  input: AgentRunInput,
  options: DriveOptions = {},
): Promise<RunOutcome> {
  return drive(runtime, input.runId, runtime.run(input), options);
}

export function driveResume(
  runtime: AgentRuntime,
  input: AgentResumeInput,
  options: DriveOptions = {},
): Promise<RunOutcome> {
  return drive(runtime, input.runId, runtime.resume(input), options);
}
