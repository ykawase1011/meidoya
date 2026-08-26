import { describe, expect, it } from "vitest";
import { AgentEventFactory } from "./event-stream.js";
import { driveResume, driveRun } from "./session.js";
import type {
  AgentEvent,
  AgentResumeInput,
  AgentRunInput,
  AgentRuntime,
  AgentRuntimeCapabilities,
} from "./types.js";

const input: AgentRunInput = {
  runId: "run-1",
  role: "worker",
  workerProfile: "implementer",
  provider: "codex",
  modelProfile: "standard",
  resolvedModel: "configured-model",
  scope: {
    workspaceId: "ws",
    projectAccess: [],
    capabilities: [],
    networkPolicy: "deny",
    sideEffectPolicy: "deny",
  },
  capabilities: [],
  prompt: "do it",
};

class ScriptedRuntime implements AgentRuntime {
  readonly id = "scripted";
  cancelled: string[] = [];
  running = true;

  constructor(private readonly script: (f: AgentEventFactory) => AgentEvent[]) {}

  async *run(i: AgentRunInput): AsyncIterable<AgentEvent> {
    const factory = new AgentEventFactory(i.runId, () => 0);
    for (const event of this.script(factory)) yield event;
  }

  resume(i: AgentResumeInput): AsyncIterable<AgentEvent> {
    return this.run(i);
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
    this.running = false;
  }

  capabilities(): AgentRuntimeCapabilities {
    return {
      provider: "codex",
      supportsResume: true,
      supportsStructuredOutput: true,
      supportsStreaming: true,
      modelProfiles: ["high", "standard", "economy"],
      grantableCapabilities: [],
    };
  }
}

describe("driveRun", () => {
  it("collects the session id and structured output on success", async () => {
    const runtime = new ScriptedRuntime((f) => [
      f.make({ type: "session", externalSessionId: "sess-9" }),
      f.make({ type: "message", text: "working" }),
      f.make({ type: "result", status: "succeeded", structuredOutput: { type: "complete" } }),
    ]);

    const outcome = await driveRun(runtime, input);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.session).toEqual({ runId: "run-1", externalSessionId: "sess-9" });
    if (outcome.status === "succeeded") {
      expect(outcome.structuredOutput).toEqual({ type: "complete" });
      expect(outcome.text).toBe("working");
    }
    expect(runtime.cancelled).toEqual([]);
  });

  it("terminates the process while waiting on a user and keeps only the session id", async () => {
    const runtime = new ScriptedRuntime((f) => [
      f.make({ type: "session", externalSessionId: "sess-1" }),
      f.make({ type: "awaiting-user", question: "which branch?" }),
      f.make({ type: "result", status: "succeeded" }),
    ]);

    const outcome = await driveRun(runtime, input);
    expect(outcome.status).toBe("waiting_user");
    // 09 section 10: process terminated, nothing but the external session id persists.
    expect(runtime.cancelled).toEqual(["run-1"]);
    expect(runtime.running).toBe(false);
    expect(outcome.session).toEqual({ runId: "run-1", externalSessionId: "sess-1" });
    expect(Object.keys(outcome.session ?? {})).toEqual(["runId", "externalSessionId"]);
  });

  it("maps failures with error class and retryability", async () => {
    const runtime = new ScriptedRuntime((f) => [
      f.make({ type: "result", status: "failed", errorClass: "timeout", retryable: true }),
    ]);
    const outcome = await driveRun(runtime, input);
    expect(outcome).toMatchObject({ status: "failed", errorClass: "timeout", retryable: true });
  });

  it("treats a stream that ends without a result as a retryable failure", async () => {
    const runtime = new ScriptedRuntime((f) => [f.make({ type: "phase", phase: "planning" })]);
    const outcome = await driveRun(runtime, input);
    expect(outcome).toMatchObject({ status: "failed", errorClass: "stream_ended_without_result" });
  });

  it("resumes from a persisted external session id", async () => {
    const seen: string[] = [];
    const runtime = new ScriptedRuntime((f) => [f.make({ type: "result", status: "succeeded" })]);
    const resumeInput: AgentResumeInput = { ...input, externalSessionId: "sess-1" };
    const outcome = await driveResume(runtime, resumeInput, {
      onEvent: (e) => seen.push(e.type),
    });
    expect(outcome.status).toBe("succeeded");
    expect(seen).toEqual(["result"]);
  });
});

describe("AgentEventFactory", () => {
  it("assigns monotonic sequence numbers", () => {
    const f = new AgentEventFactory("run-x", () => 42);
    const a = f.make({ type: "phase", phase: "a" });
    const b = f.make({ type: "phase", phase: "b" });
    expect([a.sequence, b.sequence]).toEqual([0, 1]);
    expect(a.runId).toBe("run-x");
    expect(a.timestamp).toBe(42);
  });
});
