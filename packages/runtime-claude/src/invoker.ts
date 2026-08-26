import type { TerminationReason } from "@meidoya/agent-runtime";

/** One `claude -p` invocation, already reduced to argv + bounds. */
export type ClaudeInvocation = {
  readonly runId: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};

export type ClaudeInvokerEvent =
  | { readonly kind: "stdout"; readonly line: string }
  | { readonly kind: "stderr"; readonly text: string }
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly reason: TerminationReason;
      readonly stderr: string;
    };

/**
 * Port over the Claude Code CLI. The real implementation shells out to a
 * configurable `claude` binary; tests use the fake so no install is required.
 */
export interface ClaudeInvoker {
  invoke(invocation: ClaudeInvocation): AsyncIterable<ClaudeInvokerEvent>;
  cancel(runId: string): Promise<void>;
}
