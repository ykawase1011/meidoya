import {
  AgentEventFactory,
  parseWithRepairOnce,
  redactError,
  type AgentEvent,
  type AgentResumeInput,
  type AgentRunInput,
  type AgentRuntime,
  type AgentRuntimeCapabilities,
  type RepairRequest,
} from "@meidoya/agent-runtime";
import { assertNoInjectedCredentials } from "./credentials.js";
import type { ClaudeInvocation, ClaudeInvoker } from "./invoker.js";
import { buildClaudeArgs, parseClaudeLine } from "./protocol.js";

export type ClaudeRuntimeOptions = {
  readonly invoker: ClaudeInvoker;
  readonly id?: string;
  /** Non-credential overlay only; credentials stay node-local. */
  readonly env?: NodeJS.ProcessEnv;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxOutputBytes?: number;
};

type TurnState = {
  sessionId: string | undefined;
  text: string | undefined;
  ok: boolean | undefined;
  errorSubtype: string | undefined;
  exitCode: number | null;
  reason: string;
};

function newTurnState(): TurnState {
  return {
    sessionId: undefined,
    text: undefined,
    ok: undefined,
    errorSubtype: undefined,
    exitCode: null,
    reason: "exit",
  };
}

export class ClaudeRuntime implements AgentRuntime {
  readonly id: string;
  readonly #invoker: ClaudeInvoker;
  readonly #options: ClaudeRuntimeOptions;
  readonly #sessions = new Map<string, string>();

  constructor(options: ClaudeRuntimeOptions) {
    assertNoInjectedCredentials(options.env);
    this.id = options.id ?? "claude";
    this.#invoker = options.invoker;
    this.#options = options;
  }

  capabilities(): AgentRuntimeCapabilities {
    return {
      provider: "claude",
      supportsResume: true,
      supportsStructuredOutput: true,
      supportsStreaming: true,
      modelProfiles: ["high", "standard", "economy"],
      grantableCapabilities: ["repo.read", "repo.write", "shell", "network"],
    };
  }

  run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    return this.#execute(input, undefined);
  }

  resume(input: AgentResumeInput): AsyncIterable<AgentEvent> {
    return this.#execute(input, input.externalSessionId);
  }

  async cancel(runId: string): Promise<void> {
    await this.#invoker.cancel(runId);
    this.#sessions.delete(runId);
  }

  externalSessionId(runId: string): string | undefined {
    return this.#sessions.get(runId);
  }

  #invocation(input: AgentRunInput, prompt: string, resumeSessionId?: string): ClaudeInvocation {
    const timeoutMs = input.timeoutMs ?? this.#options.defaultTimeoutMs;
    const maxOutputBytes = input.maxOutputBytes ?? this.#options.defaultMaxOutputBytes;
    return {
      runId: input.runId,
      args: buildClaudeArgs({
        resolvedModel: input.resolvedModel,
        capabilities: input.capabilities,
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      }),
      stdin: prompt,
      ...(input.workdir === undefined ? {} : { cwd: input.workdir }),
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    };
  }

  async *#turn(
    factory: AgentEventFactory,
    invocation: ClaudeInvocation,
    state: TurnState,
  ): AsyncIterable<AgentEvent> {
    for await (const event of this.#invoker.invoke(invocation)) {
      if (event.kind === "exit") {
        state.exitCode = event.code;
        state.reason = event.reason;
        continue;
      }
      if (event.kind === "stderr") {
        // Redaction is applied by the event factory, for this and every other
        // field, so no egress can be missed by forgetting a call here.
        yield factory.make({ type: "log", level: "warn", message: event.text });
        continue;
      }
      const parsed = parseClaudeLine(event.line);
      switch (parsed.type) {
        case "session":
          state.sessionId = parsed.sessionId;
          yield factory.make({ type: "session", externalSessionId: parsed.sessionId });
          break;
        case "message":
          state.text = parsed.text;
          yield factory.make({ type: "message", text: parsed.text });
          break;
        case "phase":
          yield factory.make({ type: "phase", phase: parsed.phase });
          break;
        case "result": {
          state.ok = parsed.ok;
          if (parsed.text !== undefined) state.text = parsed.text;
          if (parsed.sessionId !== undefined) {
            if (state.sessionId === undefined) {
              yield factory.make({ type: "session", externalSessionId: parsed.sessionId });
            }
            state.sessionId = parsed.sessionId;
          }
          if (!parsed.ok) state.errorSubtype = parsed.subtype ?? "error";
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Every event leaves through `#emit`, and every throw leaves through
   * `redactError`, so both egresses are redacted by construction.
   */
  async *#execute(input: AgentRunInput, resumeSessionId?: string): AsyncIterable<AgentEvent> {
    try {
      yield* this.#emit(input, resumeSessionId);
    } catch (error) {
      throw redactError(error);
    }
  }

  async *#emit(input: AgentRunInput, resumeSessionId?: string): AsyncIterable<AgentEvent> {
    const factory = new AgentEventFactory(input.runId);
    const state = newTurnState();

    yield* this.#turn(factory, this.#invocation(input, input.prompt, resumeSessionId), state);

    const sessionId = state.sessionId ?? resumeSessionId;
    if (sessionId !== undefined) this.#sessions.set(input.runId, sessionId);

    if (state.reason === "cancelled") {
      yield factory.make({ type: "result", status: "cancelled" });
      return;
    }

    // A turn the invoker had to KILL never succeeded, whatever it managed to
    // print first: a SIGTERM'd child reports `code: null`, which `?? 0` turns
    // into a clean exit, so the reason has to be checked explicitly.
    const abnormal = state.reason === "timeout" || state.reason === "overflow";
    if (state.ok === false || abnormal || (state.exitCode ?? 0) !== 0) {
      yield factory.make({
        type: "result",
        status: "failed",
        errorClass: abnormal ? state.reason : (state.errorSubtype ?? "claude_error"),
        retryable: true,
      });
      return;
    }

    if (input.structuredOutput === undefined) {
      yield factory.make({
        type: "result",
        status: "succeeded",
        ...(state.text === undefined ? {} : { text: state.text }),
      });
      return;
    }

    const repairEvents: AgentEvent[] = [];
    // Repair reuses --resume so the SAME session sees its own bad output.
    const repair = async (request: RepairRequest): Promise<unknown> => {
      if (sessionId === undefined) return undefined;
      const repairState = newTurnState();
      for await (const event of this.#turn(
        factory,
        this.#invocation(input, request.prompt, sessionId),
        repairState,
      )) {
        repairEvents.push(event);
      }
      return repairState.text;
    };

    const outcome = await parseWithRepairOnce(input.structuredOutput, state.text, repair);
    for (const event of repairEvents) yield event;

    if (outcome.ok) {
      // No `text` beside `structuredOutput`. It would be the SAME payload in
      // serialized form, and a serialized document is exactly what redaction
      // must not be pointed at: `text` is free text to the event factory, so
      // the copy would come out with every `"key": "step-1"` rewritten to
      // `[redacted]` — a corrupted twin of a field that is already here,
      // parsed and validated. Consumers read `structuredOutput`.
      yield factory.make({
        type: "result",
        status: "succeeded",
        structuredOutput: outcome.value,
      });
      return;
    }

    yield factory.make({
      type: "result",
      status: "failed",
      errorClass: outcome.errorClass,
      retryable: true,
      text: outcome.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
    });
  }
}
