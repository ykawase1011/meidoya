import { describe, expect, it } from "vitest";
import {
  driveRun,
  ExecutionPlanSchema,
  type AgentEvent,
  type AgentRunInput,
} from "@meidoya/agent-runtime";
import { FakeCodexInvoker } from "./fake-invoker.js";
import { buildCodexArgs, parseCodexLine, sandboxModeFor } from "./protocol.js";
import { CodexRuntime } from "./runtime.js";

const baseInput: AgentRunInput = {
  runId: "run-1",
  role: "worker",
  workerProfile: "implementer",
  provider: "codex",
  modelProfile: "standard",
  resolvedModel: "configured-model-name",
  scope: {
    workspaceId: "ws",
    projectAccess: [{ projectId: "p", mode: "write" }],
    capabilities: ["repo.read", "repo.write"],
    networkPolicy: "deny",
    sideEffectPolicy: "deny",
  },
  capabilities: ["repo.read", "repo.write"],
  prompt: "implement it",
};

/**
 * Credential SHAPES, never values: every sample is an obvious dummy.
 * `needle` is the part that must not survive on any egress.
 */
const RSA_PRIVATE_KEY_BEGIN = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");
const RSA_PRIVATE_KEY_END = "-----END RSA PRIVATE KEY-----";
const PRIVATE_KEY_BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const PRIVATE_KEY_END = "-----END PRIVATE KEY-----";
const JWT_SAMPLE = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiJEVU1NWSJ9",
  "DUMMYsignature0",
].join(".");

const CREDENTIAL_SAMPLES: readonly (readonly [name: string, text: string, needle: string])[] = [
  ["anthropic key", "here is sk-ant-DUMMY-not-real-000000", "sk-ant-DUMMY-not-real-000000"],
  ["aws access key id", "id AKIAIOSFODNN7EXAMPLE end", "AKIAIOSFODNN7EXAMPLE"],
  [
    "aws ini secret",
    "[default]\naws_secret_access_key = wJalrDUMMYnotarealsecret0123456789ab",
    "wJalrDUMMYnotarealsecret0123456789ab",
  ],
  [
    "pem private key",
    `${RSA_PRIVATE_KEY_BEGIN}\nMIIDUMMYnotarealkeyAAAAAAAA\n${RSA_PRIVATE_KEY_END}`,
    "MIIDUMMYnotarealkey",
  ],
  ["github token", "GITHUB_TOKEN=ghp_DUMMYnotarealtoken0123456789", "ghp_DUMMYnotarealtoken0123456789"],
  [
    "github fine-grained pat",
    "github_pat_DUMMYnotarealtoken0123456789abcdef",
    "github_pat_DUMMYnotarealtoken0123456789abcdef",
  ],
  ["slack token", "xoxb-DUMMY-not-real-000000", "xoxb-DUMMY-not-real-000000"],
  ["google api key", "AIzaDUMMYnotarealkey1234567", "AIzaDUMMYnotarealkey1234567"],
  [
    "gcp service account json",
    JSON.stringify({
      type: "service_account",
      private_key: `${PRIVATE_KEY_BEGIN}\nMIIDUMMYnotarealkey\n${PRIVATE_KEY_END}\n`,
    }),
    "MIIDUMMYnotarealkey",
  ],
  ["jwt", JWT_SAMPLE, "DUMMYsignature0"],
  ["bearer token", "Authorization: Bearer DUMMYnotarealbearer0", "DUMMYnotarealbearer0"],
  ["lowercase json key", '{"api_key": "dummy-not-real-value"}', "dummy-not-real-value"],
  ["password assignment", "password: dummy-not-real-pass", "dummy-not-real-pass"],
];

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe("codex argv", () => {
  it("builds an exec invocation with the resolved model and a sandbox mode", () => {
    const args = buildCodexArgs({
      resolvedModel: "configured-model-name",
      capabilities: ["repo.read"],
      workdir: "/w",
    });
    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "configured-model-name",
      "--sandbox",
      "read-only",
      "--cd",
      "/w",
      "-",
    ]);
  });

  it("builds a resume invocation from the captured thread id", () => {
    const args = buildCodexArgs({
      resolvedModel: "m",
      capabilities: [],
      resumeSessionId: "thread-7",
    });
    expect(args).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "m",
      "thread-7",
      "-",
    ]);
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("--cd");
  });

  it("derives the sandbox from granted capabilities", () => {
    expect(sandboxModeFor([])).toBe("read-only");
    expect(sandboxModeFor(["repo.read"])).toBe("read-only");
    expect(sandboxModeFor(["repo.write"])).toBe("workspace-write");
    expect(sandboxModeFor(["shell"])).toBe("workspace-write");
    // `repo.write` + `network` no longer implies full access on its own: it
    // used to, which meant this assertion ENCODED the escalation rather than
    // catching it. The human-approved capability is now required as well.
    expect(sandboxModeFor(["repo.write", "network"])).toBe("workspace-write");
    expect(sandboxModeFor(["repo.write", "network", "external-side-effect"])).toBe(
      "danger-full-access",
    );
  });
});

describe("codex stream parsing", () => {
  it("captures the thread id from both stream shapes", () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"t-1"}')).toEqual({
      type: "session",
      sessionId: "t-1",
    });
    expect(parseCodexLine('{"msg":{"type":"session_configured"},"session_id":"s-1"}')).toEqual({
      type: "session",
      sessionId: "s-1",
    });
  });

  it("extracts agent messages", () => {
    expect(
      parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'),
    ).toEqual({ type: "message", text: "done" });
    expect(parseCodexLine('{"msg":{"type":"agent_message","message":"legacy"}}')).toEqual({
      type: "message",
      text: "legacy",
    });
  });

  it("ignores junk lines instead of throwing", () => {
    expect(parseCodexLine("not json")).toEqual({ type: "ignored" });
    expect(parseCodexLine("")).toEqual({ type: "ignored" });
    expect(parseCodexLine("[1,2]")).toEqual({ type: "ignored" });
  });

  it("surfaces errors", () => {
    expect(parseCodexLine('{"type":"error","message":"boom"}')).toEqual({
      type: "error",
      message: "boom",
    });
  });
});

describe("CodexRuntime", () => {
  it("emits session, message and result events", async () => {
    const invoker = new FakeCodexInvoker({
      lines: [
        '{"type":"thread.started","thread_id":"t-42"}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"all done"}}',
        '{"type":"turn.completed"}',
      ],
    });
    const runtime = new CodexRuntime({ invoker });
    const events = await collect(runtime.run(baseInput));

    expect(events.map((e) => e.type)).toEqual(["session", "phase", "message", "result"]);
    expect(runtime.externalSessionId("run-1")).toBe("t-42");
    expect(runtime.capabilities().provider).toBe("codex");
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "result", status: "succeeded", text: "all done" });
  });

  it("passes the captured thread id back on resume", async () => {
    const invoker = new FakeCodexInvoker({ lines: ['{"type":"turn.completed"}'] });
    const runtime = new CodexRuntime({ invoker });
    await collect(runtime.resume({ ...baseInput, externalSessionId: "t-9" }));
    expect(invoker.invocations[0]?.args.slice(0, 7)).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "configured-model-name",
      "t-9",
    ]);
    expect(invoker.invocations[0]?.stdin).toBe(baseInput.prompt);
  });

  it("validates structured output and repairs once in the same thread", async () => {
    const invoker = new FakeCodexInvoker([
      {
        lines: [
          '{"type":"thread.started","thread_id":"t-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"type\\":\\"nope\\"}"}}',
        ],
      },
      {
        lines: [
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"type\\":\\"complete\\"}"}}',
        ],
      },
    ]);
    const runtime = new CodexRuntime({ invoker });
    const events = await collect(
      runtime.run({ ...baseInput, structuredOutput: "ManagerDecision" }),
    );

    expect(invoker.invocations).toHaveLength(2);
    expect(invoker.invocations[0]?.stdin).toBe(baseInput.prompt);
    expect(invoker.invocations[1]?.stdin).toContain("Schema violations");
    expect(invoker.invocations[1]?.args.slice(0, 7)).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "configured-model-name",
      "t-1",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      status: "succeeded",
      structuredOutput: { type: "complete" },
    });
  });

  it("fails after a second schema violation", async () => {
    const invoker = new FakeCodexInvoker([
      {
        lines: [
          '{"type":"thread.started","thread_id":"t-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"junk"}}',
        ],
      },
      {
        lines: [
          '{"type":"item.completed","item":{"type":"agent_message","text":"still junk"}}',
        ],
      },
    ]);
    const runtime = new CodexRuntime({ invoker });
    const events = await collect(
      runtime.run({ ...baseInput, structuredOutput: "ManagerDecision" }),
    );
    expect(invoker.invocations).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      status: "failed",
      errorClass: "schema_validation_failed",
    });
  });

  it("maps a non-zero exit to a retryable failure", async () => {
    const invoker = new FakeCodexInvoker({ lines: [], code: 1, stderr: "bad things" });
    const runtime = new CodexRuntime({ invoker });
    const events = await collect(runtime.run(baseInput));
    expect(events.at(-1)).toMatchObject({ type: "result", status: "failed", retryable: true });
  });

  it("terminates the run when the drive loop hits a user wait", async () => {
    const invoker = new FakeCodexInvoker({
      lines: ['{"type":"thread.started","thread_id":"t-5"}', '{"type":"turn.completed"}'],
    });
    const runtime = new CodexRuntime({ invoker });
    const outcome = await driveRun(runtime, baseInput);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.session?.externalSessionId).toBe("t-5");

    await runtime.cancel("run-1");
    expect(invoker.cancelled).toEqual(["run-1"]);
    expect(runtime.externalSessionId("run-1")).toBeUndefined();
  });
});

/**
 * `runtime-codex` had NO redaction at all: message text, the error line, stderr
 * and the terminal result all went out verbatim. Redaction now happens in ONE
 * place, `AgentEventFactory.make` — the parser deliberately does not redact,
 * because redacting a vendor line before parsing it destroyed the payload — so
 * every case below is also a chokepoint regression: delete the redaction from
 * `make` and they all go red.
 */
describe("credential redaction (09 section 3 / 10 section 9)", () => {
  it("redacts the message, the stderr log and the terminal result", async () => {
    const secret = "sk-ant-DUMMY-not-real-000000";
    const invoker = new FakeCodexInvoker({
      lines: [
        '{"type":"thread.started","thread_id":"t-1"}',
        `{"type":"item.completed","item":{"type":"agent_message","text":"key ${secret}"}}`,
        '{"type":"turn.completed"}',
      ],
      stderr: `warning: key ${secret}`,
    });
    const events = await collect(new CodexRuntime({ invoker }).run(baseInput));

    const result = events.find((event) => event.type === "result");
    expect(result).toMatchObject({ status: "succeeded", text: "key [redacted]" });
    expect(JSON.stringify(result).includes(secret), "the result event leaked a credential").toBe(false);
    expect(JSON.stringify(events).includes(secret), "an event leaked a credential").toBe(false);
  });

  it("redacts a credential quoted back in a codex error", async () => {
    const secret = "ghp_DUMMYnotarealtoken0123456789";
    const invoker = new FakeCodexInvoker({
      lines: [`{"type":"error","message":"auth failed for ${secret}"}`],
      code: 1,
    });
    const events = await collect(new CodexRuntime({ invoker }).run(baseInput));

    expect(events.at(-1)).toMatchObject({ type: "result", status: "failed", errorClass: "codex_error" });
    expect(JSON.stringify(events).includes(secret), "an error event leaked a credential").toBe(false);
  });

  for (const [name, text, needle] of CREDENTIAL_SAMPLES) {
    it(`redacts a ${name} on every egress`, async () => {
      const encoded = JSON.stringify(text);
      const invoker = new FakeCodexInvoker({
        lines: [
          '{"type":"thread.started","thread_id":"t-1"}',
          `{"type":"item.completed","item":{"type":"agent_message","text":${encoded}}}`,
          '{"type":"turn.completed"}',
        ],
        stderr: text,
      });
      const events = await collect(new CodexRuntime({ invoker }).run(baseInput));
      expect(JSON.stringify(events).includes(needle), `${name} survived redaction`).toBe(false);
    });
  }
});

/** The Codex mirror of the plan round-trip; see `runtime-claude` for the why. */
describe("structured output survives the redaction boundary", () => {
  const PLAN = {
    summary: "split the migration into steps",
    risk: "low",
    projects: [{ projectId: "p", mode: "write" }],
    steps: [
      {
        key: "step-1",
        kind: "investigate",
        description: "read the schema",
        workerProfile: "researcher",
        dependsOn: [] as string[],
      },
      {
        key: "step-2",
        kind: "implement",
        description: "write the migration",
        workerProfile: "implementer",
        dependsOn: ["step-1"],
      },
    ],
    expectedArtifacts: ["migration.sql"],
    verification: { commands: [{ name: "test" }] },
  };

  it("round-trips an ExecutionPlan with `key`, `dependsOn` and `tokenCount` unmangled", async () => {
    const invoker = new FakeCodexInvoker({
      lines: [
        '{"type":"thread.started","thread_id":"t-1"}',
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: JSON.stringify({ ...PLAN, tokenCount: 4321 }) },
        }),
        '{"type":"turn.completed"}',
      ],
    });
    const events = await collect(
      new CodexRuntime({ invoker }).run({ ...baseInput, structuredOutput: "ExecutionPlan" }),
    );

    const result = events.find((event) => event.type === "result");
    expect(result).toMatchObject({ status: "succeeded" });

    const parsed = ExecutionPlanSchema.safeParse(
      (result as { structuredOutput?: unknown }).structuredOutput,
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    expect(parsed.data?.steps.map((step) => step.key)).toEqual(["step-1", "step-2"]);
    expect(parsed.data?.steps[1]?.dependsOn).toEqual(["step-1"]);
    expect(invoker.invocations).toHaveLength(1);
  });

  it("fails a turn the invoker had to kill for overflow", async () => {
    const invoker = new FakeCodexInvoker({
      lines: ['{"type":"turn.completed"}'],
      code: null as unknown as number,
      reason: "overflow",
    });
    const events = await collect(new CodexRuntime({ invoker }).run(baseInput));
    expect(events.at(-1)).toMatchObject({
      type: "result",
      status: "failed",
      errorClass: "overflow",
    });
  });
});

/**
 * 10 section 10, defence in depth. `containCapabilities` upstream is what
 * normally keeps `network` away from an acting run, and it is verified end to
 * end elsewhere. This is the SECOND, independent check, at the vendor surface:
 * `--sandbox danger-full-access` is the only Codex mode that reaches outside
 * the workspace, so it must require the capability a human approved rather than
 * inferring approval from `repo.write` + `network`.
 */
describe("codex sandbox mode requires the approved capability", () => {
  const acting = ["repo.read", "repo.write", "shell", "network"] as const;

  it("does not grant danger-full-access without external-side-effect", () => {
    expect(sandboxModeFor([...acting])).toBe("workspace-write");
    expect(
      buildCodexArgs({ resolvedModel: "m", capabilities: [...acting] }),
    ).not.toContain("danger-full-access");
  });

  it("grants danger-full-access once the capability is present", () => {
    const approved = [...acting, "external-side-effect"] as const;
    expect(sandboxModeFor([...approved])).toBe("danger-full-access");
    expect(
      buildCodexArgs({ resolvedModel: "m", capabilities: [...approved] }),
    ).toContain("danger-full-access");
  });

  it("does not let external-side-effect alone unlock anything", () => {
    // The capability is an APPROVAL, not a grant: without write it changes
    // nothing, so a smuggled capability cannot escalate a read-only run.
    expect(sandboxModeFor(["repo.read", "external-side-effect"])).toBe("read-only");
    expect(sandboxModeFor(["repo.read", "network", "external-side-effect"])).toBe("read-only");
  });
});
