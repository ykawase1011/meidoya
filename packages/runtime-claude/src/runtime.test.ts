import { describe, expect, it } from "vitest";
import type { WorkerCapability } from "@meidoya/domain";
import {
  driveRun,
  ExecutionPlanSchema,
  type AgentEvent,
  type AgentRunInput,
} from "@meidoya/agent-runtime";
import { CredentialBoundaryError, nodeLocalEnv, redactCredentials } from "./credentials.js";
import { FakeClaudeInvoker } from "./fake-invoker.js";
import {
  allowedTools,
  buildClaudeArgs,
  CAPABILITY_TOOLS,
  claudeSandboxSettings,
  disallowedTools,
  parseClaudeLine,
} from "./protocol.js";
import { ClaudeRuntime } from "./runtime.js";

const baseInput: AgentRunInput = {
  runId: "run-1",
  role: "worker",
  workerProfile: "implementer",
  provider: "claude",
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

describe("claude argv", () => {
  it("uses headless stream-json", () => {
    const args = buildClaudeArgs({
      resolvedModel: "configured-model-name",
      capabilities: [],
    });
    expect(args.slice(0, 6)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "configured-model-name",
    ]);
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(
      args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ).toEqual(["--permission-mode", "dontAsk"]);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("resumes by session id", () => {
    const args = buildClaudeArgs({
      resolvedModel: "m",
      capabilities: [],
      resumeSessionId: "sess-3",
    });
    expect(args.slice(0, 2)).toEqual(["--resume", "sess-3"]);
  });

  it("maps capabilities onto allowed and disallowed tools", () => {
    expect(allowedTools(["repo.read"])).toEqual(["Read", "Grep", "Glob"]);
    expect(allowedTools(["shell"])).toEqual(["Bash"]);
    expect(disallowedTools(["repo.read"])).toContain("Bash");
    expect(disallowedTools(["repo.read"])).toContain("Write");

    const args = buildClaudeArgs({ resolvedModel: "m", capabilities: ["repo.read"] });
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    const disallowedIndex = args.indexOf("--disallowedTools");
    expect(args[disallowedIndex + 1]).toContain("Bash");
  });

  it("enables a fail-closed sandbox without unsandboxed escape", () => {
    expect(claudeSandboxSettings(["shell"])).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        network: { strictAllowlist: true, allowedDomains: [] },
      },
    });
  });

  it("opens shell network only after the external side-effect gate", () => {
    expect(claudeSandboxSettings(["shell", "network"])).toMatchObject({
      sandbox: { network: { allowedDomains: [] } },
    });
    expect(
      claudeSandboxSettings(["shell", "network", "external-side-effect"]),
    ).toMatchObject({
      sandbox: { network: { allowedDomains: ["*"] } },
    });
  });
});

describe("stream-json parsing", () => {
  it("captures the session id from the init event", () => {
    expect(parseClaudeLine('{"type":"system","subtype":"init","session_id":"s-1"}')).toEqual({
      type: "session",
      sessionId: "s-1",
    });
  });

  it("extracts assistant text blocks", () => {
    expect(
      parseClaudeLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      ),
    ).toEqual({ type: "message", text: "hello" });
  });

  it("reads the terminal result event", () => {
    expect(
      parseClaudeLine(
        '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s-1"}',
      ),
    ).toEqual({ type: "result", ok: true, text: "done", sessionId: "s-1", subtype: "success" });

    const failure = parseClaudeLine('{"type":"result","subtype":"error_max_turns","is_error":true}');
    expect(failure).toMatchObject({ type: "result", ok: false, subtype: "error_max_turns" });
  });

  it("ignores junk", () => {
    expect(parseClaudeLine("garbage")).toEqual({ type: "ignored" });
    expect(parseClaudeLine("[]")).toEqual({ type: "ignored" });
    expect(
      parseClaudeLine('{"type":"rate_limit_event","session_id":"s-1"}'),
    ).toEqual({ type: "ignored" });
  });

  it("emits a captured session only once when the result repeats its id", async () => {
    const invoker = new FakeClaudeInvoker({
      lines: [
        '{"type":"rate_limit_event","session_id":"s-42"}',
        '{"type":"system","subtype":"init","session_id":"s-42"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
        '{"type":"result","subtype":"success","is_error":false,"result":"all done","session_id":"s-42"}',
      ],
    });
    const events = await collect(new ClaudeRuntime({ invoker }).run(baseInput));
    expect(events.filter((event) => event.type === "session")).toHaveLength(1);
  });
});

describe("ClaudeRuntime", () => {
  const successLines = [
    '{"type":"system","subtype":"init","session_id":"s-42"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"all done","session_id":"s-42"}',
  ];

  it("emits session, message and result events and captures the session id", async () => {
    const invoker = new FakeClaudeInvoker({ lines: successLines });
    const runtime = new ClaudeRuntime({ invoker });
    const events = await collect(runtime.run(baseInput));

    expect(events.map((e) => e.type)).toEqual(["session", "message", "result"]);
    expect(runtime.externalSessionId("run-1")).toBe("s-42");
    expect(events.at(-1)).toMatchObject({ type: "result", status: "succeeded", text: "all done" });
    expect(runtime.capabilities().provider).toBe("claude");
  });

  it("resumes with --resume <session-id>", async () => {
    const invoker = new FakeClaudeInvoker({ lines: successLines });
    const runtime = new ClaudeRuntime({ invoker });
    await collect(runtime.resume({ ...baseInput, externalSessionId: "s-9" }));
    expect(invoker.invocations[0]?.args.slice(0, 2)).toEqual(["--resume", "s-9"]);
    expect(invoker.invocations[0]?.stdin).toBe(baseInput.prompt);
  });

  it("repairs structured output exactly once in the same session", async () => {
    const invoker = new FakeClaudeInvoker([
      {
        lines: [
          '{"type":"system","subtype":"init","session_id":"s-1"}',
          '{"type":"result","subtype":"success","is_error":false,"result":"{\\"type\\":\\"nope\\"}","session_id":"s-1"}',
        ],
      },
      {
        lines: [
          '{"type":"result","subtype":"success","is_error":false,"result":"{\\"type\\":\\"complete\\"}","session_id":"s-1"}',
        ],
      },
    ]);
    const runtime = new ClaudeRuntime({ invoker });
    const events = await collect(runtime.run({ ...baseInput, structuredOutput: "ManagerDecision" }));

    expect(invoker.invocations).toHaveLength(2);
    expect(invoker.invocations[0]?.stdin).toBe(baseInput.prompt);
    expect(invoker.invocations[1]?.stdin).toContain("Schema violations");
    expect(invoker.invocations[1]?.args.slice(0, 2)).toEqual(["--resume", "s-1"]);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      status: "succeeded",
      structuredOutput: { type: "complete" },
    });
  });

  it("fails after a second schema violation", async () => {
    const invoker = new FakeClaudeInvoker([
      {
        lines: [
          '{"type":"system","subtype":"init","session_id":"s-1"}',
          '{"type":"result","subtype":"success","is_error":false,"result":"junk","session_id":"s-1"}',
        ],
      },
      {
        lines: [
          '{"type":"result","subtype":"success","is_error":false,"result":"still junk","session_id":"s-1"}',
        ],
      },
    ]);
    const runtime = new ClaudeRuntime({ invoker });
    const events = await collect(runtime.run({ ...baseInput, structuredOutput: "ManagerDecision" }));
    expect(invoker.invocations).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      status: "failed",
      errorClass: "schema_validation_failed",
    });
  });

  it("maps an error result to a retryable failure", async () => {
    const invoker = new FakeClaudeInvoker({
      lines: ['{"type":"result","subtype":"error_max_turns","is_error":true}'],
    });
    const runtime = new ClaudeRuntime({ invoker });
    const events = await collect(runtime.run(baseInput));
    expect(events.at(-1)).toMatchObject({
      type: "result",
      status: "failed",
      errorClass: "error_max_turns",
      retryable: true,
    });
  });

  it("persists only the external session id through driveRun", async () => {
    const invoker = new FakeClaudeInvoker({ lines: successLines });
    const runtime = new ClaudeRuntime({ invoker });
    const outcome = await driveRun(runtime, baseInput);
    expect(outcome.session).toEqual({ runId: "run-1", externalSessionId: "s-42" });
  });
});

describe("credential boundary (09 section 3)", () => {
  it("refuses credentials injected from the Control Plane", () => {
    expect(
      () => new ClaudeRuntime({ invoker: new FakeClaudeInvoker({ lines: [] }), env: { ANTHROPIC_API_KEY: "sk-live-123" } }),
    ).toThrow(CredentialBoundaryError);
    expect(() => nodeLocalEnv({}, { CLAUDE_CODE_OAUTH_TOKEN: "x" })).toThrow(
      CredentialBoundaryError,
    );
  });

  it("accepts a non-credential overlay on top of the node-local env", () => {
    const env = nodeLocalEnv({ PATH: "/bin" }, { MEIDOYA_RUN_ID: "run-1" });
    expect(env).toEqual({ PATH: "/bin", MEIDOYA_RUN_ID: "run-1" });
  });

  it("redacts credential-looking values from streamed text", async () => {
    expect(redactCredentials("token sk-abcdef123456 here")).toBe("token [redacted] here");
    expect(redactCredentials("ANTHROPIC_API_KEY=sk-live-1")).toBe("ANTHROPIC_API_KEY=[redacted]");
  });

  /**
   * Regression for the confirmed leak: redaction used to be applied only to the
   * streamed `message` event, so the SAME text came back unredacted in the
   * terminal `result` (and was then persisted by the node runtime). The old
   * version of this test only looked at `message`, which is exactly why the
   * leak survived it. Every event is now asserted, `result` explicitly.
   */
  it("redacts the credential in the terminal result event, not just the message", async () => {
    const secret = "sk-ant-DUMMY-not-real-000000";
    const invoker = new FakeClaudeInvoker({
      lines: [
        `{"type":"assistant","message":{"content":[{"type":"text","text":"key ${secret}"}]}}`,
        `{"type":"result","subtype":"success","is_error":false,"result":"key ${secret}","session_id":"s-1"}`,
      ],
      stderr: `warning: key ${secret}`,
    });
    const runtime = new ClaudeRuntime({ invoker });
    const events = await collect(runtime.run(baseInput));

    const result = events.find((event) => event.type === "result");
    expect(result).toBeDefined();
    expect(JSON.stringify(result).includes(secret), "the result event leaked a credential").toBe(false);
    expect(result).toMatchObject({ status: "succeeded", text: "key [redacted]" });

    const message = events.find((event) => event.type === "message");
    expect(JSON.stringify(message).includes(secret), "the message event leaked a credential").toBe(false);

    const log = events.find((event) => event.type === "log");
    expect(JSON.stringify(log).includes(secret), "the stderr log leaked a credential").toBe(false);

    // Nothing at all, on any egress.
    expect(JSON.stringify(events).includes(secret), "an event leaked a credential").toBe(false);
  });

  it("redacts a credential carried inside structured output", async () => {
    const secret = "ghp_DUMMYnotarealtoken0123456789";
    const invoker = new FakeClaudeInvoker({
      lines: [
        '{"type":"system","subtype":"init","session_id":"s-1"}',
        `{"type":"result","subtype":"success","is_error":false,"result":"{\"type\":\"complete\",\"summary\":\"used ${secret}\"}","session_id":"s-1"}`,
      ],
    });
    const runtime = new ClaudeRuntime({ invoker });
    const events = await collect(runtime.run({ ...baseInput, structuredOutput: "ManagerDecision" }));
    expect(JSON.stringify(events).includes(secret), "structured output leaked a credential").toBe(false);
  });

  for (const [name, text, needle] of CREDENTIAL_SAMPLES) {
    it(`redacts a ${name} on every egress`, async () => {
      const encoded = JSON.stringify(text);
      const invoker = new FakeClaudeInvoker({
        lines: [
          `{"type":"assistant","message":{"content":[{"type":"text","text":${encoded}}]}}`,
          `{"type":"result","subtype":"success","is_error":false,"result":${encoded},"session_id":"s-1"}`,
        ],
        stderr: text,
      });
      const events = await collect(new ClaudeRuntime({ invoker }).run(baseInput));
      expect(JSON.stringify(events).includes(needle), `${name} survived redaction`).toBe(false);
    });
  }
});

/**
 * A plan is what every durable task produces, so this is the primary path.
 * Its steps are keyed `key` and depend on each other by that key — exactly the
 * shape a redaction pass over the RAW vendor line destroyed: both ids became
 * `[redacted]`, `dependsOn` pointed at nothing, and the run still reported
 * `succeeded`. These go through the real `ClaudeRuntime`, not a helper.
 */
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

  function planRuntime(extra: Record<string, unknown> = {}): ClaudeRuntime {
    const payload = JSON.stringify({ ...PLAN, ...extra });
    return new ClaudeRuntime({
      invoker: new FakeClaudeInvoker({
        lines: [
          '{"type":"system","subtype":"init","session_id":"s-1"}',
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: payload,
            session_id: "s-1",
          }),
        ],
      }),
    });
  }

  it("round-trips an ExecutionPlan with `key`, `dependsOn` and `tokenCount` unmangled", async () => {
    const events = await collect(
      planRuntime({ tokenCount: 4321 }).run({ ...baseInput, structuredOutput: "ExecutionPlan" }),
    );

    const result = events.find((event) => event.type === "result");
    expect(result).toMatchObject({ status: "succeeded" });

    const parsed = ExecutionPlanSchema.safeParse(
      (result as { structuredOutput?: unknown }).structuredOutput,
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    expect(parsed.data?.steps.map((step) => step.key)).toEqual(["step-1", "step-2"]);
    expect(parsed.data?.steps[1]?.dependsOn).toEqual(["step-1"]);
    expect(JSON.stringify(events)).not.toContain("[redacted]");
  });

  it("does not burn the repair budget on a payload that was always valid", async () => {
    const invoker = new FakeClaudeInvoker({
      lines: [
        '{"type":"system","subtype":"init","session_id":"s-1"}',
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          // `tokenCount` is a bare number: redacting before parsing turned it
          // into `"tokenCount": [redacted]`, which no longer parses at all, so
          // the run failed validation, repaired, failed again and consumed
          // retry budget for a payload that was correct to begin with.
          result: JSON.stringify({ type: "blocked", reason: "waiting", tokenCount: 99 }),
          session_id: "s-1",
        }),
      ],
    });
    const events = await collect(
      new ClaudeRuntime({ invoker }).run({ ...baseInput, structuredOutput: "WorkerResult" }),
    );

    expect(events.find((event) => event.type === "result")).toMatchObject({
      status: "succeeded",
      structuredOutput: { type: "blocked", reason: "waiting" },
    });
    // One invocation means no repair turn was needed.
    expect(invoker.invocations).toHaveLength(1);
  });

  it("still redacts a credential that rides inside a valid plan", async () => {
    const secret = "ghp_DUMMYnotarealtoken0123456789";
    const events = await collect(
      planRuntime({ summary: `used ${secret}` }).run({
        ...baseInput,
        structuredOutput: "ExecutionPlan",
      }),
    );
    expect(JSON.stringify(events).includes(secret), "a plan leaked a credential").toBe(false);

    const result = events.find((event) => event.type === "result") as {
      structuredOutput?: { steps?: { key?: string }[] };
    };
    // Redacted where it matters, intact everywhere else.
    expect(result.structuredOutput?.steps?.map((step) => step.key)).toEqual(["step-1", "step-2"]);
  });

  it("fails a turn the invoker had to kill for overflow", async () => {
    const invoker = new FakeClaudeInvoker({
      lines: ['{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s"}'],
      code: null as unknown as number,
      reason: "overflow",
    });
    const events = await collect(new ClaudeRuntime({ invoker }).run(baseInput));
    expect(events.find((event) => event.type === "result")).toMatchObject({
      status: "failed",
      errorClass: "overflow",
      retryable: true,
    });
  });
});

/** 10 section 10, defence in depth on the fixed Claude built-in tool surface. */
describe("capability tools", () => {
  it("gates every listed tool on its capability", () => {
    for (const [capability, tools] of Object.entries(CAPABILITY_TOOLS)) {
      const others = (Object.keys(CAPABILITY_TOOLS) as WorkerCapability[]).filter(
        (other) => other !== capability,
      );
      for (const tool of tools) {
        expect(allowedTools([capability as WorkerCapability]), capability).toContain(tool);
        if (!others.some((other) => CAPABILITY_TOOLS[other].includes(tool))) {
          expect(disallowedTools(others), `${tool} was reachable without ${capability}`).toContain(
            tool,
          );
        }
      }
    }
  });

  /**
   * The failure mode this exists for: listing a tool under
   * `external-side-effect` that some OTHER capability also grants. The bucket
   * would then be decorative — the human gate would approve something the run
   * already had. Vacuous while the list is empty, load-bearing the moment it
   * is not.
   */
  it("keeps external-side-effect tools exclusive to that capability", () => {
    const withoutApproval = (Object.keys(CAPABILITY_TOOLS) as WorkerCapability[]).filter(
      (capability) => capability !== "external-side-effect",
    );
    const reachable = new Set(allowedTools(withoutApproval));
    for (const tool of CAPABILITY_TOOLS["external-side-effect"]) {
      expect(reachable.has(tool), `${tool} is reachable without human approval`).toBe(false);
      expect(disallowedTools(withoutApproval)).toContain(tool);
    }
  });

  it("does not grant Bash from a non-shell capability", () => {
    for (const [capability, tools] of Object.entries(CAPABILITY_TOOLS)) {
      if (capability === "shell" || capability === "external-side-effect") continue;
      expect(tools, capability).not.toContain("Bash");
    }
  });
});
