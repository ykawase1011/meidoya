import type { TerminationReason } from "@meidoya/agent-runtime";
import type { CodexInvocation, CodexInvoker, CodexInvokerEvent } from "./invoker.js";

export type FakeCodexScript = {
  /** JSONL lines the fake `codex exec --json` emits. */
  readonly lines: readonly string[];
  readonly code?: number;
  readonly stderr?: string;
  /** How the invoker ended the turn; `timeout`/`overflow` mean it was killed. */
  readonly reason?: TerminationReason;
};

/** In-memory CodexInvoker so tests never need a `codex` binary or network. */
export class FakeCodexInvoker implements CodexInvoker {
  readonly invocations: CodexInvocation[] = [];
  readonly cancelled: string[] = [];
  #scripts: FakeCodexScript[];

  constructor(scripts: FakeCodexScript | readonly FakeCodexScript[]) {
    this.#scripts = Array.isArray(scripts) ? [...(scripts as FakeCodexScript[])] : [scripts as FakeCodexScript];
  }

  async *invoke(invocation: CodexInvocation): AsyncIterable<CodexInvokerEvent> {
    this.invocations.push(invocation);
    const script = this.#scripts.length > 1 ? (this.#scripts.shift() as FakeCodexScript) : (this.#scripts[0] as FakeCodexScript);
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
