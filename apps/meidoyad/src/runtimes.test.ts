import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROL_PLANE_AGENT_TIMEOUT_MS,
  controlPlaneAgentTimeoutMs,
  createControlPlaneRuntimes,
} from "./runtimes.js";

describe("control-plane runtimes", () => {
  it("builds both providers with operator binary overrides", () => {
    const runtimes = createControlPlaneRuntimes({
      PATH: "/bin",
      MEIDOYA_CODEX_BIN: "/opt/codex",
      MEIDOYA_CLAUDE_BIN: "/opt/claude",
    });

    expect(runtimes.codex?.capabilities().provider).toBe("codex");
    expect(runtimes.claude?.capabilities().provider).toBe("claude");
  });

  it("bounds coordinating subprocesses below the Temporal activity timeout", () => {
    expect(controlPlaneAgentTimeoutMs({})).toBe(DEFAULT_CONTROL_PLANE_AGENT_TIMEOUT_MS);
    expect(controlPlaneAgentTimeoutMs({ MEIDOYA_CONTROL_AGENT_TIMEOUT_MS: "1234" })).toBe(1234);
    expect(() => controlPlaneAgentTimeoutMs({ MEIDOYA_CONTROL_AGENT_TIMEOUT_MS: "never" })).toThrow(
      /positive integer/,
    );
  });
});
