import type { TerminationReason } from "@meidoya/agent-runtime";

/** One Codex CLI invocation, already reduced to argv + bounds. */
export type CodexInvocation = {
  readonly runId: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};

export type CodexInvokerEvent =
  | { readonly kind: "stdout"; readonly line: string }
  | { readonly kind: "stderr"; readonly text: string }
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly reason: TerminationReason;
      readonly stderr: string;
    };

/**
 * Port over the Codex CLI. The real implementation shells out to a configurable
 * `codex` binary; tests use the fake so no Codex install is ever required.
 */
export interface CodexInvoker {
  invoke(invocation: CodexInvocation): AsyncIterable<CodexInvokerEvent>;
  cancel(runId: string): Promise<void>;
}
