import type { TerminationReason } from "@meidoya/agent-runtime";
import type { ClaudeInvocation, ClaudeInvoker, ClaudeInvokerEvent } from "./invoker.js";

export type FakeClaudeScript = {
  /** stream-json lines the fake `claude -p` emits. */
  readonly lines: readonly string[];
  readonly code?: number;
  readonly stderr?: string;
  /** How the invoker ended the turn; `timeout`/`overflow` mean it was killed. */
  readonly reason?: TerminationReason;
};

/** In-memory ClaudeInvoker so tests never need a `claude` binary or network. */
export class FakeClaudeInvoker implements ClaudeInvoker {
  readonly invocations: ClaudeInvocation[] = [];
  readonly cancelled: string[] = [];
  #scripts: FakeClaudeScript[];

  constructor(scripts: FakeClaudeScript | readonly FakeClaudeScript[]) {
    this.#scripts = Array.isArray(scripts)
      ? [...(scripts as FakeClaudeScript[])]
      : [scripts as FakeClaudeScript];
  }

  async *invoke(invocation: ClaudeInvocation): AsyncIterable<ClaudeInvokerEvent> {
    this.invocations.push(invocation);
    const script =
      this.#scripts.length > 1
        ? (this.#scripts.shift() as FakeClaudeScript)
        : (this.#scripts[0] as FakeClaudeScript);
    for (const line of script.lines) {
      yield { kind: "stdout", line };
    }
    const stderr = script.stderr ?? "";
    if (stderr.length > 0) yield { kind: "stderr", text: stderr };
    yield { kind: "exit", code: script.code ?? 0, reason: script.reason ?? "exit", stderr };
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
  }
}
