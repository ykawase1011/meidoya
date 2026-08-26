import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentResumeInput,
  AgentRunInput,
  AgentRuntime,
  AgentRuntimeCapabilities,
} from "@meidoya/agent-runtime";
import { AgentEventFactory } from "@meidoya/agent-runtime";
import type { RunRequest } from "@meidoya/node-protocol";

import {
  AgentRuntimeAdapter,
  claudeRuntimeEnvironment,
  constrainByRunPolicy,
  readPrivateCredentialFile,
  requestedCapabilities,
} from "./runtimes.js";

/** Captures exactly what the adapter hands the vendor runtime before it spawns. */
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

function request(scope: Partial<RunRequest["scope"]>): RunRequest {
  return {
    runId: "run-1",
    taskId: "task-1",
    stepId: "implement",
    role: "worker",
    workerProfile: "implementer",
    provider: "codex",
    modelProfile: "standard",
    resolvedModel: "codex-standard",
    prompt: "do it",
    scope: {
      workspaceId: "ws",
      projectAccess: [],
      capabilities: [],
      networkPolicy: "none",
      sideEffectPolicy: "deny",
      ...scope,
    },
  };
}

async function drain(adapter: AgentRuntimeAdapter, req: RunRequest): Promise<void> {
  const controller = new AbortController();
  for await (const _event of adapter.execute(req, {
    cwd: process.cwd(),
    scope: req.scope,
    signal: controller.signal,
  })) {
    void _event;
  }
}

describe("run scope policies constrain the spawned runtime", () => {
  it("gives a run with networkPolicy 'none' no network-backed capability", async () => {
    const runtime = new CapturingRuntime();
    const adapter = new AgentRuntimeAdapter({ codex: runtime });

    // A researcher's profile maximum really does include `network` (fetching a
    // document is not a side effect), so nothing upstream strips it: the run
    // scope's own policy is the only thing that can.
    const req = request({
      capabilities: ["repo.read", "network"],
      networkPolicy: "none",
      sideEffectPolicy: "deny",
    });
    await drain(adapter, { ...req, workerProfile: "researcher" });

    const input = runtime.received[0];
    expect(input?.capabilities).not.toContain("network");
    expect(input?.capabilities).not.toContain("package-install");
    expect(input?.capabilities).not.toContain("browser");
    // The scope the runtime sees agrees with the capabilities it was given.
    expect(input?.scope.capabilities).not.toContain("network");
    // Repository work is untouched: this narrows egress, not the whole run.
    expect(input?.capabilities).toContain("repo.read");
  });

  it("keeps network when the scope's policy actually allows egress", async () => {
    const runtime = new CapturingRuntime();
    const adapter = new AgentRuntimeAdapter({ codex: runtime });

    await drain(
      adapter,
      request({
        capabilities: ["repo.read", "network"],
        networkPolicy: "restricted",
        sideEffectPolicy: "deny",
      }),
    );

    expect(runtime.received[0]?.capabilities).toContain("network");
  });

  it("drops external-side-effect unless the side-effect gate turned the policy to allow", async () => {
    const runtime = new CapturingRuntime();
    const adapter = new AgentRuntimeAdapter({ codex: runtime });

    await drain(
      adapter,
      request({
        capabilities: ["repo.read", "external-side-effect"],
        networkPolicy: "restricted",
        sideEffectPolicy: "gated",
      }),
    );

    expect(runtime.received[0]?.capabilities).not.toContain("external-side-effect");
    expect(runtime.received[0]?.scope.capabilities).not.toContain("external-side-effect");
  });

  it("treats an unknown policy string as no permission at all", () => {
    expect(
      constrainByRunPolicy(["network", "external-side-effect", "repo.read"], {
        networkPolicy: "whatever-the-node-said",
        sideEffectPolicy: "maybe",
      }),
    ).toEqual(["repo.read"]);
  });

  it("only ever narrows: it cannot add a capability", () => {
    expect(
      constrainByRunPolicy(["repo.read"], { networkPolicy: "open", sideEffectPolicy: "allow" }),
    ).toEqual(["repo.read"]);
  });
});

describe("requestedCapabilities", () => {
  it("keeps only capabilities this codebase knows", () => {
    // A scope is wire input: anything not in the known set must never reach
    // `derivePermissions`, whose profile maximums are keyed by that set.
    expect(
      requestedCapabilities({
        capabilities: [
          "repo.read",
          "sudo",
          "external-side-effect",
          "repo.read; rm -rf /",
          "",
        ],
      } as never),
    ).toEqual(["repo.read", "external-side-effect"]);
  });
});

describe("Claude setup-token boundary", () => {
  it("loads a private file only into Claude's subprocess environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "meidoya-claude-token-"));
    const file = join(directory, "setup.token");
    writeFileSync(file, "test-setup-token\n", { mode: 0o600 });
    const nodeEnvironment = {
      HOME: "/home/meidoya",
      MEIDOYA_CLAUDE_TOKEN_FILE: file,
      MEIDOYA_MODEL_CLAUDE_STANDARD: "sonnet",
    };

    const runtimeEnvironment = claudeRuntimeEnvironment(nodeEnvironment);

    expect(runtimeEnvironment["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("test-setup-token");
    expect(runtimeEnvironment["MEIDOYA_CLAUDE_TOKEN_FILE"]).toBeUndefined();
    expect(nodeEnvironment).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("refuses group-readable credentials and symlinks", () => {
    const directory = mkdtempSync(join(tmpdir(), "meidoya-claude-token-policy-"));
    const file = join(directory, "setup.token");
    const link = join(directory, "setup.link");
    writeFileSync(file, "test-setup-token\n", { mode: 0o600 });
    symlinkSync(file, link);

    expect(() => readPrivateCredentialFile(link)).toThrow("not a regular file");
    chmodSync(file, 0o640);
    expect(() => readPrivateCredentialFile(file)).toThrow("group or other users");
  });
});
