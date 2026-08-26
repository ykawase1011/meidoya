import {
  AgentEventFactory,
  assertNoInjectedCredentials,
  parseWithRepairOnce,
  redactError,
  type AgentEvent,
  type AgentResumeInput,
  type AgentRunInput,
  type AgentRuntime,
  type AgentRuntimeCapabilities,
  type RepairRequest,
} from "@meidoya/agent-runtime";
import type { CodexInvocation, CodexInvoker } from "./invoker.js";
import { buildCodexArgs, parseCodexLine } from "./protocol.js";

export type CodexRuntimeOptions = {
  readonly invoker: CodexInvoker;
  readonly id?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxOutputBytes?: number;
};

type TurnState = {
  sessionId: string | undefined;
  text: string | undefined;
  errorMessage: string | undefined;
  exitCode: number | null;
  reason: string;
};

function newTurnState(): TurnState {
  return { sessionId: undefined, text: undefined, errorMessage: undefined, exitCode: null, reason: "exit" };
}

export class CodexRuntime implements AgentRuntime {
  readonly id: string;
  readonly #invoker: CodexInvoker;
  readonly #options: CodexRuntimeOptions;
  /** Only the external session id survives a turn; see 09 section 10. */
  readonly #sessions = new Map<string, string>();

  constructor(options: CodexRuntimeOptions) {
    // Same boundary the Claude adapter enforces: the Codex credential is
    // node-local, so an `env` handed in from the Control Plane may not carry
    // one (09 section 3).
    assertNoInjectedCredentials(options.env);
    this.id = options.id ?? "codex";
    this.#invoker = options.invoker;
    this.#options = options;
  }

  capabilities(): AgentRuntimeCapabilities {
    return {
      provider: "codex",
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

  #invocation(input: AgentRunInput, prompt: string, resumeSessionId?: string): CodexInvocation {
    const timeoutMs = input.timeoutMs ?? this.#options.defaultTimeoutMs;
    const maxOutputBytes = input.maxOutputBytes ?? this.#options.defaultMaxOutputBytes;
    return {
      runId: input.runId,
      args: buildCodexArgs({
        resolvedModel: input.resolvedModel,
        capabilities: input.capabilities,
        ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
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
    invocation: CodexInvocation,
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
      const parsed = parseCodexLine(event.line);
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
        case "error":
          state.errorMessage = parsed.message;
          yield factory.make({ type: "log", level: "error", message: parsed.message });
          break;
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
    if (state.errorMessage !== undefined || abnormal || (state.exitCode ?? 0) !== 0) {
      yield factory.make({
        type: "result",
        status: "failed",
        errorClass: abnormal ? state.reason : "codex_error",
        retryable: true,
        ...(state.errorMessage === undefined ? {} : { text: state.errorMessage }),
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
    // Repair goes back to the SAME Codex thread so the agent sees its own output.
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
