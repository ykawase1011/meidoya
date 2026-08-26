import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FilesystemSandbox,
  parseNodeConfig,
  resolveNodeConfig,
} from "@meidoya/execution-native";
import {
  NodeRunner,
  PosixProcessGroupKiller,
  SandboxRunAssignment,
  type AgentRuntimePort,
  type RunContext,
  type RuntimeEvent,
} from "@meidoya/node-runtime";
import type { AgentRunScope, RunRequest } from "@meidoya/node-protocol";
import type { ReviewInput, WorkerStepInput } from "@meidoya/workflows-temporal";
import {
  createNodeActivities,
  createNodeStateProjection,
  loadNodeConfig,
  verificationStartupWarnings,
  type NodeActivityContextPort,
} from "./node.js";
import { FakeNodeRuntime } from "./testing/fake-runtime.js";

let base: string;
let project: string;
let otherProject: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "meidoya-node-activities-")));
  project = path.join(base, "grammarxiv");
  otherProject = path.join(base, "product-a");
  mkdirSync(project);
  mkdirSync(otherProject);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Records every heartbeat and hands out one cancellation signal, as Temporal does. */
class FakeActivityContext implements NodeActivityContextPort {
  readonly beats: unknown[] = [];
  readonly controller = new AbortController();
  /** Counts listener churn on the signal, so a leak is visible. */
  live = 0;

  constructor(private readonly hasContext = true) {
    const signal = this.controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      this.live += 1;
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      this.live -= 1;
      remove(...args);
    };
  }

  heartbeat(details: unknown): void {
    this.beats.push(details);
  }

  cancellationSignal(): AbortSignal | undefined {
    return this.hasContext ? this.controller.signal : undefined;
  }
}

describe("Yashiki health projection", () => {
  it("writes only registration and poller status into systemd's private state directory", () => {
    const stateDirectory = path.join(base, "state");
    const projection = createNodeStateProjection({ STATE_DIRECTORY: stateDirectory });

    projection.controlPlaneAcknowledged(1_725_000_000_000);
    projection.poller("meidoya/node/test", true);

    expect(JSON.parse(readFileSync(path.join(stateDirectory, "registration.json"), "utf8"))).toEqual({
      registered: true,
      protocolVersion: 1,
      lastHeartbeatAt: 1_725_000_000_000,
    });
    expect(JSON.parse(readFileSync(path.join(stateDirectory, "poller.json"), "utf8"))).toEqual({
      polling: true,
      queue: "meidoya/node/test",
    });
  });

  it("is a no-op outside a systemd StateDirectory", () => {
    const projection = createNodeStateProjection({});
    expect(() => projection.controlPlaneAcknowledged(Date.now())).not.toThrow();
  });
});

/** A runtime that never finishes until the run is cancelled. */
class HangingRuntime implements AgentRuntimePort {
  started = 0;

  async *execute(_request: RunRequest, ctx: RunContext): AsyncIterable<RuntimeEvent> {
    this.started += 1;
    yield { type: "phase", phase: "running" };
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) resolve();
      else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // `RuntimeEvent` deliberately has no "cancelled" done status: the runner
    // tracks cancellation out of band on the active run. A torn-down runtime
    // reports failure and names the cause.
    yield { type: "done", status: "failed", errorClass: "cancelled" };
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

function harness(
  overrides: {
    runtime?: AgentRuntimePort;
    projects?: Record<string, Record<string, string>>;
    grantedWorkspaces?: Set<string>;
    grantedCapabilities?: string[];
    activity?: NodeActivityContextPort;
    truncatedWorkspaces?: Record<string, readonly string[]>;
    nodeQualityGates?: { name: string; argv: readonly string[]; allowUnsafe?: boolean }[];
  } = {},
) {
  const sandbox = new FilesystemSandbox({ allowedRoots: [base], cwd: base });
  const projects = overrides.projects ?? { "work-grammarxiv": { grammarxiv: project } };
  const scopes = new Map<string, AgentRunScope>();
  const runtime = overrides.runtime ?? new FakeNodeRuntime();
  const runner = new NodeRunner({
    runtime,
    assignment: new SandboxRunAssignment(sandbox, { projects }, scopes),
    events: { emit: () => undefined },
    activityHeartbeat: { heartbeat: () => undefined },
    killer: new PosixProcessGroupKiller(),
    maxConcurrency: 2,
  });
  const activity = overrides.activity ?? new FakeActivityContext();
  const activities = createNodeActivities({
    nodeId: "mac-main",
    sandbox,
    profile: "lima-trusted",
    projects,
    ...(overrides.truncatedWorkspaces === undefined
      ? {}
      : { truncatedWorkspaces: overrides.truncatedWorkspaces }),
    grantedWorkspaces: overrides.grantedWorkspaces ?? new Set(["work-grammarxiv"]),
    grantedCapabilities: overrides.grantedCapabilities ?? ["repo.read", "repo.write", "shell"],
    networkPolicy: "none",
    // Verification is deny-by-default: a node with no `quality_gates:` runs
    // nothing at all, so a harness that wants a gate to reach `spawn` has to
    // configure it, exactly as an operator would.
    nodeQualityGates: overrides.nodeQualityGates ?? [
      { name: "test", argv: [process.execPath, "--version"] },
    ],
    runner,
    scopes,
    env: {},
    activity,
    heartbeatIntervalMs: 10,
  });
  return { activities, runner, runtime, activity, scopes, sandbox };
}

function workerStep(overrides: Partial<WorkerStepInput> = {}): WorkerStepInput {
  return {
    taskId: "task-1",
    workspaceId: "work-grammarxiv",
    brief: { summary: "implement the requested change", projects: ["grammarxiv"], origin: "cli" },
    stepKey: "step-1",
    stepKind: "implement",
    attempt: 1,
    workerProfile: "implementer",
    provider: "codex",
    modelProfile: "standard",
    capabilities: ["repo.read", "repo.write"],
    projectAccess: [{ projectId: "grammarxiv", mode: "write" }],
    idempotencyKey: "idem-1",
    ...overrides,
  } as WorkerStepInput;
}

function reviewStep(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    taskId: "task-1",
    workspaceId: "work-grammarxiv",
    brief: { summary: "implement the requested change", projects: ["grammarxiv"], origin: "cli" },
    stepKey: "review",
    attempt: 1,
    provider: "claude",
    modelProfile: "high",
    capabilities: ["repo.read"],
    projectAccess: [{ projectId: "grammarxiv", mode: "read" }],
    verification: {
      status: "passed",
      groups: [],
      missingArtifacts: [],
      artifacts: [],
      evidence: [],
    },
    idempotencyKey: "review-1",
    ...overrides,
  };
}

describe("node worker-step activity", () => {
  it("refuses a workspace this node is not bound to", async () => {
    const { activities, runtime } = harness();
    await expect(
      activities.runWorkerStep(workerStep({ workspaceId: "work-it" })),
    ).rejects.toThrow(/not bound to node mac-main/);
    // Nothing was even scoped, let alone spawned.
    expect((runtime as FakeNodeRuntime).requests).toHaveLength(0);
  });

  it("runs in the bound project and drops capabilities this node does not grant", async () => {
    const { activities, runtime, scopes } = harness({ grantedCapabilities: ["repo.read"] });
    await activities.runWorkerStep(
      workerStep({ capabilities: ["repo.read", "repo.write", "shell"] }),
    );
    const fake = runtime as FakeNodeRuntime;
    expect(fake.workdirs).toEqual([project]);
    // `repo.write` was in the control plane's grant and NOT in this node's, so
    // the intersection strips it and the project drops to read mode.
    const request = fake.requests[0] as RunRequest;
    expect([...request.scope.capabilities]).toEqual(["repo.read"]);
    expect(request.scope.projectAccess).toEqual([{ projectId: "grammarxiv", mode: "read" }]);
    expect(request.prompt.split("\n", 1)[0]).toBe("#meidoya-output: WorkerResult");
    expect(request.prompt).toContain("implement the requested change");
    expect(request.prompt).toContain("pipeline step step-1 (implement)");
    expect(scopes.size).toBe(0);
  });

  it("never lands in the sandbox root when the run carries no project access", async () => {
    const { activities, runtime } = harness();
    await activities.runWorkerStep(workerStep({ projectAccess: [] }));
    const fake = runtime as FakeNodeRuntime;
    // The fallback is this node's own binding, read-only — never `sandbox.cwd`,
    // which is the whole allowed root and would hand a run with NO project
    // access every checkout on the node.
    expect(fake.workdirs).toEqual([project]);
    expect(fake.workdirs).not.toContain(base);
    expect((fake.requests[0] as RunRequest).scope.projectAccess).toEqual([
      { projectId: "grammarxiv", mode: "read" },
    ]);
  });

  it("still stays inside a project when this node binds several", async () => {
    const { activities, runtime } = harness({
      projects: { "work-grammarxiv": { grammarxiv: project, "product-a": otherProject } },
    });
    await activities.runWorkerStep(workerStep({ projectAccess: [] }));
    const fake = runtime as FakeNodeRuntime;
    expect([project, otherProject]).toContain(fake.workdirs[0]);
    expect(fake.workdirs).not.toContain(base);
    // Read-only on both: a run that named no project never gains write access.
    expect((fake.requests[0] as RunRequest).scope.projectAccess.map((a) => a.mode)).toEqual([
      "read",
      "read",
    ]);
  });

  it("refuses a run with no project access when this node binds nothing for it", async () => {
    const { activities } = harness({ projects: { "work-grammarxiv": {} } });
    await expect(activities.runWorkerStep(workerStep({ projectAccess: [] }))).rejects.toThrow();
  });

  it("heartbeats while the step runs and cancels it when the activity is cancelled", async () => {
    const activity = new FakeActivityContext();
    const runtime = new HangingRuntime();
    const { activities } = harness({ runtime, activity });

    const running = activities.runWorkerStep(workerStep());
    // Polled, not slept: the heartbeat interval is 10ms here, and a fixed
    // 60ms wall-clock wait is a coin flip on a loaded machine rather than a
    // statement about the ticker.
    expect(await waitUntil(() => activity.beats.length > 1)).toBe(true);

    activity.controller.abort();
    await expect(running).resolves.toMatchObject({ type: "failed", errorClass: "cancelled" });
    // The abort listener is removed with the run: a node-lifetime signal must
    // not accumulate one closure per activity.
    expect(activity.live).toBe(0);
  });
});

describe("node review activity", () => {
  it("runs a read-only reviewer in the project with full task context", async () => {
    const runtime = new FakeNodeRuntime({
      findings: [{ id: "f1", severity: "major", summary: "race remains" }],
    });
    const { activities } = harness({
      runtime,
      grantedCapabilities: ["repo.read", "repo.write", "shell"],
    });

    await expect(activities.runReview(reviewStep())).resolves.toEqual({
      findings: [{ id: "f1", severity: "major", summary: "race remains" }],
    });
    const request = runtime.requests[0];
    expect(request?.workerProfile).toBe("reviewer");
    expect(request?.provider).toBe("claude");
    expect(request?.structuredOutputSchemaRef).toBe("ReviewFindings");
    expect(request?.scope.capabilities).toEqual(["repo.read"]);
    expect(request?.scope.projectAccess).toEqual([{ projectId: "grammarxiv", mode: "read" }]);
    expect(request?.prompt).toContain("implement the requested change");
    expect(request?.prompt).toContain("Verification result");
  });
});

describe("node verification activity wiring", () => {
  it("refuses when the node holds no project for the workspace", async () => {
    const { activities } = harness({ projects: {} });
    await expect(
      activities.runVerification({
        workspaceId: "work-grammarxiv",
        plan: { commands: [{ name: "test" }] },
        qualityGates: [{ name: "test", argv: [process.execPath, "--version"] }],
      } as never),
    ).rejects.toThrow(/no project bound/);
  });

  it("refuses a __proto__ project id with a policy violation, not a TypeError", async () => {
    const { activities } = harness();
    await expect(
      activities.runVerification({
        workspaceId: "work-grammarxiv",
        plan: { commands: [{ name: "test" }] },
        projectId: "__proto__",
        qualityGates: [{ name: "test", argv: [process.execPath, "--version"] }],
      } as never),
    ).rejects.toMatchObject({ name: "PolicyViolation" });
  });

  it("heartbeats while gates run", async () => {
    const activity = new FakeActivityContext();
    const { activities } = harness({ activity });
    await activities.runVerification({
      workspaceId: "work-grammarxiv",
      plan: { commands: [{ name: "test" }] },
      qualityGates: [{ name: "test", argv: [process.execPath, "--version"] }],
    } as never);
    expect(activity.beats.length).toBeGreaterThan(0);
    expect(activity.live).toBe(0);
  });
});

/**
 * A node.yaml that names an argv this node cannot justify is refused at
 * STARTUP.
 *
 * Left to the first verification, the same refusal arrives as a Temporal
 * PolicyViolation on an activity, two retries later, with nothing pointing at
 * the config line that caused it.
 */
describe("loadNodeConfig validation", () => {
  const EXAMPLE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../docs/design/node.example.yaml",
  );

  function write(body: string): string {
    const file = path.join(base, "node.yaml");
    writeFileSync(file, body);
    return file;
  }

  const template = (): string => readFileSync(EXAMPLE, "utf8");

  /**
   * Edits the shipped example, and FAILS when the text being edited is not
   * there any more.
   *
   * A plain `String.replace` that matches nothing returns the string unchanged,
   * so a test written against an older copy of the example keeps passing while
   * asserting nothing about the case it names. Two tests below were in exactly
   * that state after the example's gates changed: they pinned
   * `/usr/local/bin/vitest`, silently stopped mutating anything, and would have
   * gone on "refusing an unjustifiable gate" without ever building one.
   */
  function edit(body: string, needle: string, replacement: string): string {
    expect(body, `node.example.yaml no longer contains ${JSON.stringify(needle)}`).toContain(needle);
    return body.replace(needle, replacement);
  }

  it("loads the shipped example", () => {
    expect(() => loadNodeConfig(write(template()), base)).not.toThrow();
  });

  it("refuses a task queue that does not belong to the configured node", () => {
    const body = edit(
      template(),
      "    task_queue: meidoya/node/mac-main",
      "    task_queue: meidoya/node/another-node",
    );
    expect(() => loadNodeConfig(write(body), base)).toThrow(/must be meidoya\/node\/mac-main/);
  });

  it("refuses a quality gate that indirects through the checkout", () => {
    const body = edit(
      template(),
      '  - name: test\n    argv: ["/usr/bin/make", "test"]',
      '  - name: test\n    argv: ["pnpm", "-r", "test"]',
    );
    expect(() => loadNodeConfig(write(body), base)).toThrow(/cannot be justified/);
  });

  it("accepts it once the operator states the risk", () => {
    const body = edit(
      template(),
      '  - name: test\n    argv: ["/usr/bin/make", "test"]',
      '  - name: test\n    argv: ["pnpm", "-r", "test"]\n    allow_unsafe: true',
    );
    expect(() => loadNodeConfig(write(body), base)).not.toThrow();
  });

  it("refuses a credential in quality_gate_env", () => {
    const body = edit(template(), "quality_gate_env:\n  - CI", "quality_gate_env:\n  - CI\n  - ANTHROPIC_API_KEY");
    expect(() => loadNodeConfig(write(body), base)).toThrow(/credential variables/);
  });

  /**
   * P6: the OTHER half of the same boundary.
   *
   * `assertNoInjectedCredentials` refuses `NODE_OPTIONS`, `LD_PRELOAD`,
   * `GIT_SSH_COMMAND`, `*_PROXY` and `*_BASE_URL` on the Control-Plane-to-node
   * direction because they inject code into, or redirect, the process that
   * holds the credentials. `quality_gate_env` was checked against
   * `CREDENTIAL_ENV_KEYS` only, so an operator could allowlist exactly those
   * into the LEAST trusted process on the node. None of these is a credential,
   * so the credential check cannot fail in their place: delete the
   * `redirectKeysIn` branch in `loadNodeConfig` and every line here goes green.
   */
  it("refuses a redirect/injection variable in quality_gate_env", () => {
    for (const name of [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "GIT_SSH_COMMAND",
      "HTTPS_PROXY",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      const body = edit(template(), "quality_gate_env:\n  - CI", `quality_gate_env:\n  - CI\n  - ${name}`);
      expect(() => loadNodeConfig(write(body), base), name).toThrow(
        /redirect or inject code into the process/,
      );
    }
    // The variables the key exists FOR are still accepted.
    expect(() => loadNodeConfig(write(template()), base)).not.toThrow();
  });
});

/**
 * F3: the startup warning described behaviour that round 7 REMOVED.
 *
 * It told an operator with no `quality_gates:` that the node "can only justify
 * a verification argv structurally (no shells, no repo-defined scripts)" —
 * i.e. that gates still run, under a denylist. Every verification is refused.
 * An operator who read the old line believed their pipeline was verifying.
 */
describe("verification startup warnings", () => {
  const EXAMPLE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../docs/design/node.example.yaml",
  );
  const resolved = (body: string) => resolveNodeConfig(parseNodeConfig(body), base);
  const example = () => readFileSync(EXAMPLE, "utf8");

  it("says every verification is refused when no gates are configured", () => {
    const body = example().replace(
      /quality_gates:\n(  - name[\s\S]*?)\n\n/,
      "quality_gates: []\n\n",
    );
    const config = resolved(body);
    expect(config.qualityGates).toHaveLength(0);
    const warnings = verificationStartupWarnings(config, base).join("\n");
    expect(warnings).toMatch(/REFUSE EVERY verification/);
    expect(warnings).toMatch(/quality_gates:/);
    // The claim that made the old message a lie: gates justified "structurally"
    // is not a thing this node does any more.
    expect(warnings).not.toMatch(/structurally/);
  });

  it("says nothing about gates when the operator configured them", () => {
    const body = example().replace("profile: mac-restricted", "profile: lima-trusted");
    expect(verificationStartupWarnings(resolved(body), base)).toEqual([]);
  });

  it("warns when the node's profile cannot confine a gate at all", () => {
    const body = example().replace("profile: mac-restricted", "profile: linux-restricted");
    expect(verificationStartupWarnings(resolved(body), base).join("\n")).toMatch(
      /verification is unavailable on this node/,
    );
  });
});
