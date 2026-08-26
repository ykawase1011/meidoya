import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentResumeInput,
  AgentRunInput,
  AgentRuntime,
  AgentRuntimeCapabilities,
} from "@meidoya/agent-runtime";
import { AgentEventFactory } from "@meidoya/agent-runtime";
import type { AgentInvocation } from "@meidoya/task-engine";
import type { ModelMapping } from "@meidoya/model-router";
import {
  createDaemonAgentPort,
  createLocalAgentPort,
  createPromptBuilder,
  promptOutputKind,
} from "./agents.js";

/**
 * Captures the `AgentRunInput` the port actually hands to the runtime, so a
 * test can assert on the derived `capabilities` / `scope` without a real
 * vendor process.
 */
class CapturingRuntime implements AgentRuntime {
  readonly id = "capturing";
  received: AgentRunInput[] = [];

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    this.received.push(input);
    const factory = new AgentEventFactory(input.runId, () => 0);
    yield factory.make({ type: "result", status: "succeeded", structuredOutput: { ok: true } });
  }

  resume(input: AgentResumeInput): AsyncIterable<AgentEvent> {
    return this.run(input as unknown as AgentRunInput);
  }

  async cancel(): Promise<void> {}

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

const modelMapping: ModelMapping = {
  codex: { high: "codex-high", standard: "codex-standard", economy: "codex-economy" },
  claude: { high: "claude-high", standard: "claude-standard", economy: "claude-economy" },
};

describe("agent prompts", () => {
  const prompts = createPromptBuilder(
    () => "Fix the parser race.",
    () => ["parser"],
    "Asia/Tokyo",
  );

  it("bounds Maid classification to configured projects and the ingress origin", () => {
    const prompt = prompts.maidAssessment({
      workspaceId: "ws",
      requestKey: "request-1",
      origin: "cli",
      messageRef: "message-1",
      idempotencyKey: "request-1",
    });
    expect(promptOutputKind(prompt)).toBe("MaidDecision");
    expect(prompt).toContain('Available project IDs: ["parser"]');
    expect(prompt).toContain("Preserve origin cli");
    expect(prompt).toContain("Interpretation mode: auto");
    expect(prompt).toContain("Default schedule timezone: Asia/Tokyo");
    expect(prompt).toContain("schedule.create");
    expect(prompt).toContain("Selected ingress agent profile: secretary");
    expect(prompt).toContain("maid and executive secretary");
    expect(prompt).toContain("return respond instead of creating a task");
  });

  it("gives the secretary trusted current-work context", () => {
    const prompt = prompts.maidAssessment(
      {
        workspaceId: "ws",
        requestKey: "greeting",
        origin: "chat",
        messageRef: "message-1",
        idempotencyKey: "greeting",
      },
      {
        activeTaskCount: 0,
        waitingTaskCount: 1,
        enabledScheduleCount: 2,
        openTasks: [{ title: "README確認", status: "waiting_user_input" }],
      },
    );

    expect(prompt).toContain('"activeTaskCount":0');
    expect(prompt).toContain('"waitingTaskCount":1');
    expect(prompt).toContain("README確認");
    expect(prompt).toContain("must not merely echo the user");
  });

  it("forces the dedicated CLI schedule entry into schedule interpretation", () => {
    const prompt = prompts.maidAssessment({
      workspaceId: "ws",
      requestKey: "request-schedule",
      origin: "cli",
      messageRef: "message-1",
      interpretation: "schedule",
      idempotencyKey: "request-schedule",
    });

    expect(prompt).toContain("Interpretation mode: schedule");
    expect(prompt).toContain("must become schedule.create");
    expect(prompt).toContain("standard five-field cron");
  });

  it("prevents an already-triggered schedule from recursively creating another schedule", () => {
    const prompt = prompts.maidAssessment({
      workspaceId: "ws",
      requestKey: "scheduled-run",
      origin: "schedule",
      messageRef: "schedule:schedule/ws/daily",
      idempotencyKey: "scheduled-run",
    });

    expect(prompt).toContain("already-triggered schedule");
    expect(prompt).toContain("never schedule.create");
  });

  it("gives planning the task brief and exact output contract", () => {
    const prompt = prompts.planning({
      taskId: "task-1",
      workspaceId: "ws",
      brief: { summary: "Fix the parser race.", projects: ["parser"], origin: "cli" },
      stepKey: "plan",
      attempt: 1,
      idempotencyKey: "plan-1",
    });
    expect(promptOutputKind(prompt)).toBe("ExecutionPlan");
    expect(prompt).toContain("Fix the parser race.");
    expect(prompt).toContain('"verification"');
  });

  it("gives workers the approved plan and pipeline step", () => {
    const prompt = prompts.worker({
      taskId: "task-1",
      workspaceId: "ws",
      brief: { summary: "Fix the parser race.", projects: ["parser"], origin: "cli" },
      stepKey: "implement",
      stepKind: "implement",
      attempt: 1,
      workerProfile: "implementer",
      provider: "codex",
      modelProfile: "standard",
      capabilities: ["repo.read", "repo.write", "shell"],
      projectAccess: [{ projectId: "parser", mode: "write" }],
      executionPlan: {
        summary: "Patch and test the parser.",
        risk: "low",
        projects: [{ projectId: "parser", mode: "write" }],
        steps: [],
        expectedArtifacts: [],
        verification: { commands: [] },
      },
      idempotencyKey: "worker-1",
    });
    expect(promptOutputKind(prompt)).toBe("WorkerResult");
    expect(prompt).toContain("pipeline step implement (implement)");
    expect(prompt).toContain("Patch and test the parser.");
    expect(prompt).toContain('"type":"completed"');
  });

  it("gives review and Manager decision the evidence they judge", () => {
    const verification = {
      status: "failed" as const,
      groups: [],
      missingArtifacts: ["dist/index.js"],
      artifacts: [],
      evidence: [],
      failureSignature: "test#red",
    };
    const review = prompts.review({
      taskId: "task-1",
      workspaceId: "ws",
      brief: { summary: "Fix the parser race.", projects: ["parser"], origin: "cli" },
      stepKey: "review",
      attempt: 1,
      provider: "claude",
      modelProfile: "high",
      capabilities: ["repo.read"],
      projectAccess: [{ projectId: "parser", mode: "read" }],
      verification,
      idempotencyKey: "review-1",
    });
    expect(review).toContain("Fix the parser race.");
    expect(review).toContain("test#red");

    const decision = prompts.managerDecision({
      taskId: "task-1",
      workspaceId: "ws",
      findings: {
        findings: [{ id: "f1", severity: "blocking", summary: "race remains" }],
      },
      verification,
      idempotencyKey: "decision-1",
    });
    expect(decision).toContain("race remains");
    expect(decision).toContain("test#red");
  });
});

function invocation(overrides: Partial<AgentInvocation>): AgentInvocation {
  return {
    runId: "run-1",
    taskId: "task-1",
    actor: { role: "worker", profile: "implementer" },
    provider: "codex",
    modelProfile: "standard",
    scope: { workspaceId: "ws", projectAccess: [], capabilities: [] },
    prompt: "#meidoya-output: WorkerResult\ndo it",
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

describe("createLocalAgentPort", () => {
  it("grants a worker invocation the capabilities its scope requested (within its profile maximum)", async () => {
    const runtime = new CapturingRuntime();
    const port = createLocalAgentPort({ runtimes: { codex: runtime }, modelMapping });

    await port.invoke(
      invocation({
        actor: { role: "worker", profile: "implementer" },
        scope: {
          workspaceId: "ws",
          projectAccess: [],
          capabilities: ["repo.read", "repo.write", "shell"],
        },
      }),
    );

    expect(runtime.received).toHaveLength(1);
    // These three don't touch EXTERNAL_REACH containment, so they pass straight
    // through the profile-maximum intersection.
    expect(runtime.received[0]?.capabilities.slice().sort()).toEqual([
      "repo.read",
      "repo.write",
      "shell",
    ]);
  });

  it("still grants a coordinating role (maid) no capabilities, whatever the scope claims", async () => {
    const runtime = new CapturingRuntime();
    const port = createLocalAgentPort({ runtimes: { codex: runtime }, modelMapping });

    await port.invoke(
      invocation({
        actor: { role: "maid" },
        scope: {
          workspaceId: "ws",
          projectAccess: [],
          capabilities: ["repo.read", "repo.write", "shell", "network", "external-side-effect"],
        },
      }),
    );

    expect(runtime.received).toHaveLength(1);
    expect(runtime.received[0]?.capabilities).toEqual([]);
    expect(runtime.received[0]?.scope.capabilities).toEqual([]);
    expect(runtime.received[0]?.scope.networkPolicy).toBe("none");
    expect(runtime.received[0]?.scope.sideEffectPolicy).toBe("deny");
  });

  it("intersects the request against the profile maximum instead of unioning it", async () => {
    const runtime = new CapturingRuntime();
    const port = createLocalAgentPort({ runtimes: { codex: runtime }, modelMapping });

    // "reviewer" may only ever hold repo.read; asking for more must not escalate it.
    await port.invoke(
      invocation({
        actor: { role: "worker", profile: "reviewer" },
        scope: {
          workspaceId: "ws",
          projectAccess: [],
          capabilities: ["repo.read", "repo.write", "shell", "network", "external-side-effect"],
        },
      }),
    );

    expect(runtime.received).toHaveLength(1);
    expect(runtime.received[0]?.capabilities).toEqual(["repo.read"]);
  });

  it("turns network/side-effect policy on only when the corresponding capability was actually granted", async () => {
    const runtime = new CapturingRuntime();
    const port = createLocalAgentPort({ runtimes: { codex: runtime }, modelMapping });

    await port.invoke(
      invocation({
        actor: { role: "worker", profile: "implementer" },
        scope: {
          workspaceId: "ws",
          projectAccess: [],
          capabilities: ["network", "external-side-effect"],
        },
      }),
    );

    expect(runtime.received).toHaveLength(1);
    const scope = runtime.received[0]?.scope;
    expect(scope?.capabilities.slice().sort()).toEqual(["external-side-effect", "network"]);
    expect(scope?.networkPolicy).toBe("restricted");
    expect(scope?.sideEffectPolicy).toBe("allow");
  });
});

describe("createDaemonAgentPort", () => {
  it("builds a REAL agent port as soon as a runtime and a model mapping exist", async () => {
    const runtime = new CapturingRuntime();
    const warnings: string[] = [];
    const port = createDaemonAgentPort({
      runtimes: { codex: runtime },
      modelMapping,
      warn: (message) => warnings.push(message),
    });

    // Guard for the "engine with no caller" defect: `createLocalAgentPort` had
    // no production caller at all, so the capability threading below could
    // never run in the shipped daemon.
    const result = await port.invoke(invocation({ actor: { role: "maid" } }));
    expect(result.status).toBe("succeeded");
    expect(runtime.received).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("announces the degraded daemon instead of silently failing every task later", async () => {
    const warnings: string[] = [];
    const port = createDaemonAgentPort({ modelMapping, warn: (m) => warnings.push(m) });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/DEGRADED: no agent runtime is configured/);
    expect(await port.invoke(invocation({}))).toMatchObject({
      status: "failed",
      errorClass: /^agent_runtime_unavailable:/,
      retryable: false,
    });
  });

  it("is degraded, loudly, when models: is missing even though a runtime exists", () => {
    const warnings: string[] = [];
    createDaemonAgentPort({
      runtimes: { codex: new CapturingRuntime() },
      warn: (m) => warnings.push(m),
    });
    expect(warnings[0]).toMatch(/DEGRADED: no `models:` mapping/);
  });

  it("prefers an injected port and stays quiet", () => {
    const warnings: string[] = [];
    const injected = { invoke: async () => ({ status: "cancelled" }) } as never;
    expect(createDaemonAgentPort({ agents: injected, warn: (m) => warnings.push(m) })).toBe(
      injected,
    );
    expect(warnings).toEqual([]);
  });
});
