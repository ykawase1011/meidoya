import os from "node:os";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import type { ReviewFindings, WorkerResult } from "@meidoya/domain";
import type { VerificationResult } from "@meidoya/task-engine";
import type { AgentRunScope, NodeProfile, RunRequest, RunResult } from "@meidoya/node-protocol";
import { NODE_PROTOCOL_VERSION } from "@meidoya/node-protocol";
import {
  createSandboxFromConfig,
  daemonStateDenials,
  parseNodeConfig,
  planGateConfinement,
  resolveNodeConfig,
  validateProjectPaths,
  type FilesystemSandbox,
  type NodeConfig,
  type NodeQualityGate,
  type ResolvedNodeConfig,
} from "@meidoya/execution-native";
import {
  NodeAgent,
  NodeRunner,
  PosixProcessGroupKiller,
  SandboxRunAssignment,
  ScopeViolationError,
  type AgentRuntimePort,
} from "@meidoya/node-runtime";
import type { ReviewInput, VerificationInput, WorkerStepInput } from "@meidoya/workflows-temporal";
import { nodeTaskQueue, nodeWorkerOptions } from "@meidoya/workflows-temporal";
import {
  buildStructuredOutputPrompt,
  ReviewFindingsSchema,
  WorkerResultSchema,
  type StructuredOutputKind,
} from "@meidoya/agent-runtime";
import { parseControlPlaneEndpoint, SocketControlPlaneClient } from "./control-plane-client.js";
import { AgentRuntimeAdapter, createRuntimes, resolveModelName } from "./runtimes.js";
import { buildWorkerRunScope } from "./run-scope.js";
import {
  assertNodeQualityGatesJustified,
  assertNodeQualityGatesResolvable,
  createNodeVerificationActivity,
  credentialKeysIn,
  redirectKeysIn,
  VerificationPolicyError,
} from "./verification.js";

export class ProtocolVersionMismatchError extends Error {
  constructor(advertised: number, expected: number) {
    super(
      `control plane advertises node protocol ${advertised}, this node speaks ${expected}; refusing to start`,
    );
    this.name = "ProtocolVersionMismatchError";
  }
}

/**
 * Loads and VALIDATES this node's config.
 *
 * Validation is not only shape. `quality_gates:` names argv this node will
 * spawn inside a checkout a `repo.write` worker can edit, and `quality_gate_env`
 * names variables those gates will see; both are refused here, at startup,
 * rather than at the first verification — where the refusal arrives as a
 * PolicyViolation on a Temporal activity nobody traces back to a config line.
 */
export function loadNodeConfig(file: string, home: string = os.homedir()): ResolvedNodeConfig {
  const resolved = resolveNodeConfig(parseNodeConfig(readFileSync(file, "utf8")), home);
  const expectedTaskQueue = nodeTaskQueue(resolved.config.node.id);
  if (resolved.config.node.temporal.task_queue !== expectedTaskQueue) {
    throw new Error(
      `node.temporal.task_queue must be ${expectedTaskQueue} for node ${resolved.config.node.id}`,
    );
  }
  assertNodeQualityGatesJustified(resolved.qualityGates);
  // A gate whose binary is not installed is not a policy problem, it is an
  // operator problem — and it used to present as `exit 71` from a retried
  // Temporal activity with no path in the message. F10: refuse at startup,
  // naming the binary. The shipped node.example.yaml named
  // `/usr/local/bin/vitest`, which exists on no stock machine.
  assertNodeQualityGatesResolvable(resolved.qualityGates);
  const credentials = credentialKeysIn(resolved.qualityGateEnv);
  if (credentials.length > 0) {
    throw new VerificationPolicyError(
      `quality_gate_env names credential variables (${credentials.join(", ")}); a quality gate` +
        " executes code from the checkout and holds no capability grant, so credentials never" +
        " enter its environment",
    );
  }
  // The other half of the same boundary. `assertNoInjectedCredentials` refuses
  // `NODE_OPTIONS`, `LD_PRELOAD`, `GIT_SSH_COMMAND` and friends on the
  // Control-Plane-to-node direction because they inject code into, or redirect,
  // the process that holds the credentials. Nothing checked them here, so an
  // operator could allowlist exactly those into the LEAST trusted process on the
  // node — the one that runs the checkout's code. The two directions have no
  // reason to disagree.
  const redirects = redirectKeysIn(resolved.qualityGateEnv);
  if (redirects.length > 0) {
    throw new VerificationPolicyError(
      `quality_gate_env names variables that redirect or inject code into the process that` +
        ` receives them (${redirects.join(", ")}); a quality gate already executes code the` +
        " checkout chooses, and these decide what that code loads, where it connects and which" +
        " certificates it trusts",
    );
  }
  return resolved;
}

/**
 * The sandbox and the validated project bindings a node serves from, derived
 * from its config exactly as `startNode` does.
 *
 * Extracted so something other than a fully started daemon — notably the test
 * that boots the SHIPPED docs/design/node.example.yaml and runs a real quality
 * gate through `createNodeVerificationActivity` — gets the same sandbox and the
 * same truncation bookkeeping as production, instead of a hand-built copy that
 * can drift from it.
 */
export function nodeFilesystemBindings(resolved: ResolvedNodeConfig): {
  sandbox: FilesystemSandbox;
  /** workspaceId -> projectId -> canonical path. */
  projects: Record<string, Record<string, string>>;
  rejected: string[];
  truncated: Record<string, string[]>;
} {
  const sandbox = createSandboxFromConfig(resolved);
  const { valid: projects, rejected, truncated } = validateProjectPaths(resolved, sandbox);
  return { sandbox, projects, rejected, truncated };
}

/** `unix://~/path` or a bare path, as written in node.example.yaml. */
export function controlPlaneSocketPath(config: NodeConfig, home: string = os.homedir()): string {
  if (config.node.control_plane.startsWith("tcp://")) {
    throw new Error("TCP control plane endpoints do not have a Unix socket path");
  }
  const raw = config.node.control_plane.replace(/^unix:\/\//, "");
  return raw.startsWith("~/") ? `${home}/${raw.slice(2)}` : raw;
}

export function resolvedControlPlaneEndpoint(config: NodeConfig, home: string = os.homedir()) {
  if (config.node.control_plane.startsWith("tcp://")) {
    return parseControlPlaneEndpoint(config.node.control_plane);
  }
  return parseControlPlaneEndpoint(controlPlaneSocketPath(config, home));
}

/**
 * What a verification activity must carry for a node to be able to serve it.
 *
 * `qualityGates` and `projectId` are additions the Control Plane's workflow has
 * to send (`VerificationInput` in `@meidoya/workflows-temporal`): the node has
 * no copy of a workspace's operator configuration and no way to guess which
 * checkout a plan meant. They are typed loosely here so this node keeps
 * compiling against a `VerificationInput` that has not grown the fields yet;
 * `parseActivityQualityGates` is what actually validates them, and it refuses
 * an input that omits them rather than falling back to a built-in catalog.
 */
export type NodeVerificationInput = VerificationInput & {
  qualityGates?: unknown;
  projectId?: string;
};

/**
 * The two things a Temporal activity context gives a long-running node
 * activity: a way to say "still working" and a way to hear "stop".
 *
 * Injectable so the enforcement around it is testable without a Temporal
 * worker, and so a call made outside an activity context is a no-op rather than
 * a throw.
 */
export type NodeActivityContextPort = {
  heartbeat(details: unknown): void;
  /** The activity's cancellation signal, or undefined outside an activity. */
  cancellationSignal(): AbortSignal | undefined;
};

/**
 * Real Temporal activity context.
 *
 * Nothing on this node used to heartbeat at all, while `runWorkerStep` and
 * `runVerification` both declare a `heartbeatTimeout` measured in minutes: any
 * agent run or quality gate longer than that was killed mid-flight and retried
 * until the attempt budget ran out. `Context.current()` throws outside an
 * activity (tests, the demo's direct calls), so both accessors degrade to a
 * no-op instead of turning a real run into an error.
 */
export function temporalActivityContext(): NodeActivityContextPort {
  return {
    heartbeat(details: unknown): void {
      try {
        Context.current().heartbeat(details);
      } catch {
        // Not inside an activity: nothing is waiting for this beat.
      }
    },
    cancellationSignal(): AbortSignal | undefined {
      try {
        return Context.current().cancellationSignal;
      } catch {
        return undefined;
      }
    },
  };
}

export type NodeActivitiesOptions = {
  nodeId: string;
  sandbox: FilesystemSandbox;
  /**
   * `node.profile` from node.yaml. Not optional: it is what decides whether a
   * quality gate can be confined at all, and a default here would mean a
   * caller's omission runs the checkout's code with nothing around it.
   */
  profile: NodeProfile;
  /** The node operator's home; gates are confined away from its credentials. */
  home?: string;
  /** workspaceId -> projectId -> path, already validated against the sandbox. */
  projects: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** workspaceId -> project ids dropped at validation; makes inference refuse. */
  truncatedWorkspaces?: Readonly<Record<string, readonly string[]>>;
  grantedWorkspaces: ReadonlySet<string>;
  grantedCapabilities: readonly string[];
  networkPolicy: string;
  /** This node's own quality-gate allowlist (`quality_gates:` in node.yaml). */
  nodeQualityGates?: readonly NodeQualityGate[];
  /** Extra env names gates may see (`quality_gate_env:`); never a credential. */
  qualityGateEnv?: readonly string[];
  /** `host:port` endpoints gates may reach (`quality_gate_network:`). */
  qualityGateNetwork?: readonly string[];
  /**
   * The daemon's data dir and control socket, denied to every quality gate.
   * `startNode` derives them from `node.control_plane` — the socket this node
   * itself connects to, which is the only thing it knows about the daemon's
   * on-disk layout, and enough: its directory is the `data_dir` that holds the
   * per-binding bearer credentials.
   */
  gateDeniedPaths?: readonly string[];
  runner: NodeRunner;
  /** Authoritative scopes by runId, read back by `SandboxRunAssignment`. */
  scopes: Map<string, AgentRunScope>;
  env: NodeJS.ProcessEnv;
  /** Node-lifetime abort: stopping the node kills every gate. */
  verificationSignal?: AbortSignal;
  activity?: NodeActivityContextPort;
  heartbeatIntervalMs?: number;
};

export type NodeActivities = {
  runWorkerStep(input: WorkerStepInput): Promise<WorkerResult>;
  runReview(input: ReviewInput): Promise<ReviewFindings>;
  runVerification(input: NodeVerificationInput): Promise<VerificationResult>;
};

/**
 * The activities an execution node serves, with every check the node owns.
 *
 * Extracted from `startNode` so the enforcement — the workspace binding, the
 * capability intersection, the node's own quality-gate justification, activity
 * cancellation and heartbeating — is exercised directly by tests instead of
 * only through a live Temporal worker and a control-plane socket.
 */
export function createNodeActivities(options: NodeActivitiesOptions): NodeActivities {
  const activity = options.activity ?? temporalActivityContext();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;

  const runScopedAgent = async (
    input: Pick<
      WorkerStepInput | ReviewInput,
      | "taskId"
      | "workspaceId"
      | "stepKey"
      | "attempt"
      | "provider"
      | "modelProfile"
      | "capabilities"
      | "projectAccess"
    >,
    workerProfile: WorkerStepInput["workerProfile"],
    structuredOutput: StructuredOutputKind,
    prompt: string,
  ): Promise<RunResult> => {
    if (!options.grantedWorkspaces.has(input.workspaceId)) {
      throw new ScopeViolationError(
        `workspace ${input.workspaceId} is not bound to node ${options.nodeId}`,
      );
    }
    const workspaceProjects = ownProperty(options.projects, input.workspaceId) ?? {};
    // Scope is the INTERSECTION of the Control Plane's grant for this run (what
    // a human approved at the side-effect gate) and this node's own local
    // policy. Neither side is trusted alone: 10 section 6 for the node's
    // self-report, 10 section 7 for the run scope's origin.
    const scope = buildWorkerRunScope(
      {
        workspaceId: input.workspaceId,
        capabilities: input.capabilities ?? [],
        projectAccess: input.projectAccess ?? [],
      },
      {
        capabilities: options.grantedCapabilities,
        projectIds: Object.keys(workspaceProjects),
        networkPolicy: options.networkPolicy,
      },
    );

    const runId = `${input.taskId}:${input.stepKey}:${input.attempt}`;
    const request: RunRequest = {
      runId,
      taskId: input.taskId,
      stepId: input.stepKey,
      role: "worker",
      workerProfile,
      provider: input.provider,
      modelProfile: input.modelProfile,
      resolvedModel: resolveModelName(input.provider, input.modelProfile, options.env),
      scope,
      prompt,
      structuredOutputSchemaRef: structuredOutput,
    };

    options.scopes.set(runId, scope);
    // An agent run is minutes of silence between runtime events and the
    // activity's heartbeatTimeout is two minutes. The runner beats on every
    // phase/session event; this ticker covers the gaps between them.
    activity.heartbeat({ runId, phase: "starting", attempt: input.attempt });
    const ticker = setInterval(
      () => activity.heartbeat({ runId, phase: "running", attempt: input.attempt }),
      heartbeatIntervalMs,
    );
    ticker.unref?.();
    // Cancelling the activity must reach the agent's process group rather than
    // wait for the activity's start-to-close timeout to expire.
    const cancellation = activity.cancellationSignal();
    const cancel = (): void => {
      options.runner.cancel(runId);
    };
    if (cancellation?.aborted === true) cancel();
    else cancellation?.addEventListener("abort", cancel, { once: true });
    try {
      return await options.runner.run(request, input.attempt);
    } finally {
      clearInterval(ticker);
      // Removed, not left behind: a node-lifetime signal would otherwise retain
      // one closure per run, each pinning that run's scope.
      cancellation?.removeEventListener("abort", cancel);
      options.scopes.delete(runId);
    }
  };

  const runWorkerStep = async (input: WorkerStepInput): Promise<WorkerResult> => {
    const result = await runScopedAgent(
      input,
      input.workerProfile,
      "WorkerResult",
      buildStructuredOutputPrompt(
        "WorkerResult",
        [
          `Task brief: ${JSON.stringify(input.brief)}`,
          `Execute pipeline step ${input.stepKey} (${input.stepKind}) of task ${input.taskId} as ${input.workerProfile}.`,
          `Attempt ${input.attempt}.`,
          ...(input.executionPlan === undefined
            ? []
            : [`Approved execution plan: ${JSON.stringify(input.executionPlan)}`]),
        ].join("\n"),
      ),
    );
    if (result.status === "succeeded") {
      return WorkerResultSchema.parse(result.structuredOutput) as WorkerResult;
    }
    if (result.status === "cancelled") {
      return { type: "failed", errorClass: "cancelled", retryable: false };
    }
    return {
      type: "failed",
      errorClass: result.errorClass ?? "run_failed",
      retryable: result.retryable ?? true,
    };
  };

  const runReview = async (input: ReviewInput): Promise<ReviewFindings> => {
    const result = await runScopedAgent(
      input,
      "reviewer",
      "ReviewFindings",
      buildStructuredOutputPrompt(
        "ReviewFindings",
        [
          `Review the work produced for task ${input.taskId}, step ${input.stepKey}.`,
          `Task brief: ${JSON.stringify(input.brief)}`,
          ...(input.executionPlan === undefined
            ? []
            : [`Approved execution plan: ${JSON.stringify(input.executionPlan)}`]),
          ...(input.verification === undefined
            ? []
            : [`Verification result: ${JSON.stringify(input.verification)}`]),
        ].join("\n"),
      ),
    );
    if (result.status !== "succeeded") {
      throw new Error(
        result.status === "cancelled"
          ? "review cancelled"
          : `review failed: ${result.errorClass ?? "run_failed"}`,
      );
    }
    return ReviewFindingsSchema.parse(result.structuredOutput) as ReviewFindings;
  };

  /**
   * Verification runs HERE, in the node's sandbox — not on the daemon host.
   * The workspace binding, the operator's quality-gate catalog, this node's own
   * justification of the argv and the project-narrowed cwd are all enforced by
   * `createNodeVerificationActivity`.
   */
  const runVerification = createNodeVerificationActivity({
    sandbox: options.sandbox,
    profile: options.profile,
    ...(options.home === undefined ? {} : { home: options.home }),
    projects: options.projects,
    ...(options.truncatedWorkspaces === undefined
      ? {}
      : { truncatedWorkspaces: options.truncatedWorkspaces }),
    grantedWorkspaces: options.grantedWorkspaces,
    nodeId: options.nodeId,
    ...(options.verificationSignal === undefined
      ? {}
      : { signal: options.verificationSignal }),
    nodeQualityGates: options.nodeQualityGates ?? [],
    ...(options.qualityGateEnv === undefined ? {} : { envAllowlist: options.qualityGateEnv }),
    ...(options.qualityGateNetwork === undefined
      ? {}
      : { networkAllowlist: options.qualityGateNetwork }),
    ...(options.gateDeniedPaths === undefined ? {} : { deniedPaths: options.gateDeniedPaths }),
    cancellationSignal: () => activity.cancellationSignal(),
    heartbeat: (details) => activity.heartbeat(details),
    heartbeatIntervalMs,
  });

  return {
    runWorkerStep,
    runReview,
    runVerification: (input: NodeVerificationInput) => runVerification(input),
  };
}

/** Own-property lookup: `__proto__` as a workspace id must miss, not inherit. */
function ownProperty<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * What an operator must be told, at startup, about verification on this node.
 *
 * Extracted from `startNode` so the WORDING has a test. The message this
 * replaces described behaviour that round 7 removed: it said a node with no
 * `quality_gates:` "can only justify a verification argv structurally (no
 * shells, no repo-defined scripts)", i.e. that gates still run under a
 * denylist. They do not — every verification is refused — so an operator who
 * read it believed their pipeline was verifying while nothing on this node
 * could ever spawn a gate. A warning that describes deleted behaviour is worse
 * than no warning: it is read once, believed, and never checked again.
 */
export function verificationStartupWarnings(
  resolved: ResolvedNodeConfig,
  sandboxCwd: string,
): readonly string[] {
  const warnings: string[] = [];
  if (resolved.qualityGates.length === 0) {
    warnings.push(
      "no `quality_gates:` configured; this node will REFUSE EVERY verification with a" +
        " PolicyViolation and no gate will run. Verification is deny-by-default: list the gates" +
        " this node is allowed to spawn (name + absolute argv) under `quality_gates:` in" +
        " node.yaml. See docs/design/node.example.yaml.",
    );
  }
  // Same class of surprise, one layer down: a node whose profile cannot confine
  // a gate child refuses verification per activity (`planGateConfinement`).
  // Said once at startup, next to the config it is about, rather than only as a
  // Temporal failure on the first task that reaches a verification step.
  try {
    planGateConfinement({
      profile: resolved.config.node.profile,
      writableRoots: [sandboxCwd],
      home: resolved.home,
    });
  } catch (error) {
    warnings.push(`verification is unavailable on this node: ${(error as Error).message}`);
  }
  return warnings;
}

export type NodeDaemonOptions = {
  resolved: ResolvedNodeConfig;
  /** Injected by tests; otherwise built from `runtimes:` in the node config. */
  runtime?: AgentRuntimePort;
  temporalConnection?: NativeConnection;
  /** Injected by tests; otherwise the real Temporal activity context. */
  activity?: NodeActivityContextPort;
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
};

export type StartedNode = {
  nodeId: string;
  taskQueue: string;
  runner: NodeRunner;
  agent: NodeAgent;
  grantedWorkspaces: readonly string[];
  stop(): Promise<void>;
};

export type NodeStateProjection = {
  controlPlaneAcknowledged(at: number): void;
  poller(queue: string, polling: boolean): void;
};

export function createNodeStateProjection(env: NodeJS.ProcessEnv): NodeStateProjection {
  const stateDirectory = env["STATE_DIRECTORY"]?.split(":", 1)[0];
  const write = (name: string, value: unknown): void => {
    if (stateDirectory === undefined || stateDirectory === "") return;
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(stateDirectory, name);
    const temporary = `${target}.new`;
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  };

  return {
    controlPlaneAcknowledged(at) {
      write("registration.json", {
        registered: true,
        protocolVersion: NODE_PROTOCOL_VERSION,
        lastHeartbeatAt: at,
      });
    },
    poller(queue, polling) {
      write("poller.json", { polling, queue });
    },
  };
}

/**
 * Execution Node process (10 sections 1-3): sandboxed filesystem, its own
 * Temporal task queue, Codex/Claude runtimes, and no SQLite access at all.
 */
export async function startNode(options: NodeDaemonOptions): Promise<StartedNode> {
  const { resolved } = options;
  const config = resolved.config;
  const env = options.env ?? process.env;
  const state = createNodeStateProjection(env);
  let stateProjectionReady = false;
  let lastControlPlaneAcknowledgement: number | undefined;
  const controlEndpoint = resolvedControlPlaneEndpoint(config, resolved.home);

  const control = await SocketControlPlaneClient.connect(controlEndpoint);
  const info = await control.systemInfo();
  if (info.nodeProtocolVersion !== NODE_PROTOCOL_VERSION) {
    control.close();
    throw new ProtocolVersionMismatchError(info.nodeProtocolVersion, NODE_PROTOCOL_VERSION);
  }

  const { sandbox, projects, rejected, truncated } = nodeFilesystemBindings(resolved);
  for (const rejection of rejected) {
    process.stderr.write(`meidoya-node: dropped project binding ${rejection}\n`);
  }
  for (const warning of verificationStartupWarnings(resolved, sandbox.cwd)) {
    process.stderr.write(`meidoya-node: ${warning}\n`);
  }

  const activityContext = options.activity ?? temporalActivityContext();
  const scopes = new Map<string, AgentRunScope>();
  const assignment = new SandboxRunAssignment(sandbox, { projects }, scopes);
  const runtime =
    options.runtime ?? new AgentRuntimeAdapter(createRuntimes(config, env), env);

  const runner = new NodeRunner({
    runtime,
    assignment,
    events: { emit: () => undefined },
    // Real heartbeats: the runner beats on every phase/session event and the
    // activity wrapper beats on a timer between them.
    activityHeartbeat: { heartbeat: (details) => activityContext.heartbeat(details) },
    killer: new PosixProcessGroupKiller(),
    maxConcurrency: config.node.max_concurrency,
  });

  const agent = new NodeAgent({
    self: {
      nodeId: config.node.id,
      nodeVersion: options.nodeVersion ?? "0.1.0",
      platform: process.platform === "linux" ? "linux" : "darwin",
      arch: process.arch === "x64" ? "x64" : "arm64",
      profile: config.node.profile,
      capabilities: config.capabilities,
      workspaceBindings: Object.keys(projects).sort(),
      maxConcurrency: config.node.max_concurrency,
    },
    controlPlane: control,
    activeRunCount: () => runner.activeRunCount,
    onControlPlaneAcknowledged: (at) => {
      lastControlPlaneAcknowledgement = at;
      if (stateProjectionReady) state.controlPlaneAcknowledged(at);
    },
  });

  const accepted = await agent.register();
  if (!accepted) {
    control.close();
    throw new Error(
      `control plane refused registration for node ${config.node.id}; check its local node policy`,
    );
  }
  // Reconciliation is authoritative: the node's own claim only ever narrows.
  runner.setMaxConcurrency(agent.effectiveMaxConcurrency);
  agent.start();

  const grantedWorkspaces = new Set(agent.grantedWorkspaces);
  const grantedCapabilities = [...agent.grantedCapabilities];

  // Cancelling the node cancels every gate still running, whichever run it
  // belongs to; each activity builds its own runner over this one signal.
  const verificationAbort = new AbortController();

  const activities = createNodeActivities({
    nodeId: config.node.id,
    sandbox,
    profile: config.node.profile,
    home: resolved.home,
    projects,
    truncatedWorkspaces: truncated,
    grantedWorkspaces,
    grantedCapabilities,
    networkPolicy: config.network.policy,
    nodeQualityGates: resolved.qualityGates,
    qualityGateEnv: resolved.qualityGateEnv,
    qualityGateNetwork: resolved.qualityGateNetwork,
    // The daemon's bearer credentials and its control socket live under this
    // path, and every process on this node runs as the daemon's user.
    gateDeniedPaths:
      controlEndpoint.kind === "unix" ? daemonStateDenials(controlEndpoint.path) : [],
    runner,
    scopes,
    env,
    verificationSignal: verificationAbort.signal,
    activity: activityContext,
  });

  const connection =
    options.temporalConnection ??
    (await NativeConnection.connect({ address: config.node.temporal.address }));

  const worker = await Worker.create(
    nodeWorkerOptions({
      connection,
      namespace: config.node.temporal.namespace,
      executionNodeId: config.node.id,
      activities: {
        runWorkerStep: activities.runWorkerStep,
        runReview: activities.runReview,
        runVerification: activities.runVerification,
      },
      maxConcurrency: agent.effectiveMaxConcurrency,
    }),
  );
  const workerRun = worker.run();
  stateProjectionReady = true;
  if (lastControlPlaneAcknowledgement !== undefined) {
    state.controlPlaneAcknowledged(lastControlPlaneAcknowledgement);
  }
  state.poller(config.node.temporal.task_queue, true);

  return {
    nodeId: config.node.id,
    taskQueue: config.node.temporal.task_queue,
    runner,
    agent,
    grantedWorkspaces: [...grantedWorkspaces],
    async stop(): Promise<void> {
      state.poller(config.node.temporal.task_queue, false);
      agent.stop();
      // Cancelling signals the whole process group of every in-flight run.
      runner.cancelAll();
      // Same for verification commands: no gate outlives the node.
      verificationAbort.abort();
      try {
        worker.shutdown();
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "IllegalStateError" ||
          !error.message.startsWith("Not running. Current state:")
        ) {
          throw error;
        }
      }
      await workerRun.catch(() => undefined);
      if (options.temporalConnection === undefined) {
        await connection.close().catch(() => undefined);
      }
      control.close();
    },
  };
}
