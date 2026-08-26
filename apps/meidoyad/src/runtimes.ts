import type { Provider } from "@meidoya/domain";
import type { AgentRuntime } from "@meidoya/agent-runtime";
import { CodexRuntime, SubprocessCodexInvoker } from "@meidoya/runtime-codex";
import { ClaudeRuntime, SubprocessClaudeInvoker } from "@meidoya/runtime-claude";

export type ControlPlaneRuntimeRegistry = Partial<Record<Provider, AgentRuntime>>;

export const DEFAULT_CONTROL_PLANE_AGENT_TIMEOUT_MS = 14 * 60 * 1_000;

export function controlPlaneAgentTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env["MEIDOYA_CONTROL_AGENT_TIMEOUT_MS"];
  if (configured === undefined) return DEFAULT_CONTROL_PLANE_AGENT_TIMEOUT_MS;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("MEIDOYA_CONTROL_AGENT_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

/** Builds the vendor runtimes used by coordinating roles on the control-plane host. */
export function createControlPlaneRuntimes(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneRuntimeRegistry {
  const defaultTimeoutMs = controlPlaneAgentTimeoutMs(env);
  return {
    codex: new CodexRuntime({
      invoker: new SubprocessCodexInvoker({
        baseEnv: env,
        ...(env["MEIDOYA_CODEX_BIN"] === undefined
          ? {}
          : { binPath: env["MEIDOYA_CODEX_BIN"] }),
      }),
      defaultTimeoutMs,
    }),
    claude: new ClaudeRuntime({
      invoker: new SubprocessClaudeInvoker({
        baseEnv: env,
        ...(env["MEIDOYA_CLAUDE_BIN"] === undefined
          ? {}
          : { binPath: env["MEIDOYA_CLAUDE_BIN"] }),
      }),
      defaultTimeoutMs,
    }),
  };
}
