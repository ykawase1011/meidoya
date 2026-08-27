import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Client } from "@temporalio/client";
import type { NativeConnection, Worker } from "@temporalio/worker";
import type { WorkspaceId, WorkspacePolicy } from "@meidoya/domain";
import type { AgentInvocationPort, ExecutionBudgetPort } from "@meidoya/task-engine";
import { resolveGates } from "@meidoya/checkpoint-policy";
import type { ChatTransport } from "@meidoya/chat-core";
import { migrate, migrations, openDatabase, type MeidoyaDatabase } from "@meidoya/store-sqlite";
import { createDirectoryResolver, runPublisherLoop } from "@meidoya/notification-outbox";
import {
  CONTROL_TASK_QUEUE,
  createActivities,
  type Activities,
  type GatePolicyOutput,
} from "@meidoya/workflows-temporal";
import { DelegationRegistry } from "@meidoya/workspace-scope";
import {
  executionNodeForWorkspace,
  type ResolvedControlPlaneConfig,
  type ResolvedWorkspace,
} from "./config.js";
import {
  ControlPlaneService,
  createMethodHandlers,
  type CheckpointReconcileResult,
} from "./api.js";
import { ControlPlaneServer } from "./server.js";
import { ControlEventBus } from "./events.js";
import { SerialWriteQueue } from "./write-queue.js";
import { SqliteTaskRepository, seedFromConfig } from "./repository.js";
import {
  ScopeRegistry,
  createSqliteBindingEpochStore,
  loadOrCreateScopeSecret,
} from "./scope.js";
import { ClientCredentialStore, NodeCredentialStore } from "./client-credentials.js";
import { createChatDeliveryWiring, createChatGateway } from "./chat-gateway.js";
import { createChatIngress } from "./chat-ingress.js";
import { createDelegationPort } from "./delegation.js";
import { StatusProjector } from "./status.js";
import { recordStepProgress } from "./steps.js";
import {
  createArtifactProbe,
  createCheckpointPolicyPort,
  createExecutionBudgetPort,
  createInteractionPolicyPort,
  createSqliteBudgetStateStore,
  systemClock,
  uuidIds,
  VerificationUnavailableError,
  type WorkspaceGatePolicy,
} from "./ports.js";
import {
  createDaemonAgentPort,
  createParsers,
  createPromptBuilder,
} from "./agents.js";
import type { ControlPlaneRuntimeRegistry } from "./runtimes.js";
import { createModelRouting } from "./routing.js";
import {
  TemporalWorkflowGateway,
  connectTemporal,
  createControlWorker,
  type TemporalConnections,
  type WorkflowGateway,
} from "./temporal.js";

export type DaemonOptions = {
  config: ResolvedControlPlaneConfig;
  /** Injected by tests and the local demo (time-skipping Temporal environment). */
  temporal?: { client: Client; connection?: NativeConnection };
  agents?: AgentInvocationPort;
  /**
   * A vendor agent runtime for coordinating roles (Head Maid / Maid / Manager),
   * which run on the control-plane host. Supplying it is what makes the daemon
   * build a REAL agent port (`createLocalAgentPort`); without it — and without
   * `agents` — the daemon says so loudly at startup and every coordinating run
   * fails closed.
   */
  agentRuntimes?: ControlPlaneRuntimeRegistry;
  chatTransport?: ChatTransport;
  statusIntervalMs?: number;
  outboxIntervalMs?: number;
  /** How often committed-but-undelivered checkpoint answers are re-sent. */
  checkpointReconcileIntervalMs?: number;
  /** 0 disables the workflow cache; the harness uses it, see below. */
  maxCachedWorkflows?: number;
  /**
   * Called if the notification publisher loop ever stops on its own. Defaults
   * to a fatal line on stderr; tests use it to assert the failure is surfaced.
   */
  onPublisherExit?: (error: unknown, message: string) => void;
  /**
   * Called instead of stderr when the daemon starts with no agent runtime.
   * Tests use it to assert the degraded state is announced, not silent.
   */
  onDegraded?: (message: string) => void;
};

export type StartedDaemon = {
  config: ResolvedControlPlaneConfig;
  db: MeidoyaDatabase;
  repository: SqliteTaskRepository;
  service: ControlPlaneService;
  scopes: ScopeRegistry;
  events: ControlEventBus;
  gateway: WorkflowGateway;
  status: StatusProjector;
  transport: ChatTransport;
  socketPath: string;
  nodeTcpAddress: string | undefined;
  /** The live root-budget ledger; exposed so a restart can be observed. */
  budget: ExecutionBudgetPort;
  stop(): Promise<void>;
};

/**
 * 06 section 4: the budget belongs to the ROOT task. Walking the parent chain
 * is what stops a child task from opening a budget of its own — and it is why
 * `parent_task_id` is not an inert field: whatever this walk lands on is the
 * workspace whose limits apply and whose steps are spent. `task.create` may
 * therefore only accept a parent inside the caller's own workspace (api.ts).
 *
 * Exported so that ownership check can be tested against the very walk that
 * consumes the field, rather than against a re-statement of it.
 */
export function rootTaskIdOfChain(
  load: (taskId: string) => { parentTaskId?: string } | undefined,
  taskId: string,
): string {
  const seen = new Set<string>();
  let current = taskId;
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const task = load(current);
    if (task?.parentTaskId === undefined) return current;
    current = task.parentTaskId;
  }
}

/**
 * The control plane's answer to "who runs this workspace's quality gates?":
 * NOT me.
 *
 * Verification belongs on an execution node, inside its sandbox and narrowed to
 * the target project (10 sections 1-3), and `runTaskWorkflow` dispatches
 * `runVerification` only to `nodeTaskQueue(executionNodeId)`. The control plane
 * has no sandbox and no checkout — a workspace's `projects` here carry a
 * `workspace_ref`, not a path — so there is no directory it could legitimately
 * narrow to and no honest way for it to be an executor at all.
 *
 * There is deliberately no opt-in switch. A `--local-verification-root` flag
 * existed briefly and was removed: with the workflow dispatching to the node
 * queue, no configuration of the control plane could ever make it run, and a
 * configuration flag that leads to code that cannot run is worse than no flag.
 * The operator's move when verification has nowhere to run is to start a node
 * (`meidoya-node`), which is where the sandbox lives.
 *
 * What survives is the loud refusal. If a verification is scheduled onto the
 * control queue anyway, this throws a non-retryable `PolicyViolation` naming
 * the workspace. It used to answer exit 126 `verification-disabled` for every
 * gate instead, which is indistinguishable from a failing test suite: a
 * `coding` task could then never satisfy `verification-policy-satisfied` and
 * hung forever, saying nothing.
 */
export function createVerificationCommands(): (workspaceId: string) => never {
  return (workspaceId: string): never => {
    throw new VerificationUnavailableError(
      `verification for workspace ${workspaceId} reached the control plane, which has no` +
        " filesystem sandbox and never runs quality gates. Verification is dispatched to the" +
        " execution node's task queue (10 sections 1-3): bind an execution node to this" +
        " workspace and start meidoya-node on it.",
    );
  };
}

/**
 * The gate policy one workspace runs under, as the workflow receives it.
 *
 * Extracted from `startDaemon` so the two decisions it encodes are testable
 * without a Temporal worker: the mandatory security FLOOR is applied here, once
 * (no downstream caller has to remember to apply it, and none can forget to),
 * and the quality-gate catalog is reported HONESTLY — see `qualityGates` below.
 */
export function gatePolicyOutputFor(workspace: ResolvedWorkspace): GatePolicyOutput {
  const resolved = resolveGates({
    environmentDefault: {
      clarification: workspace.policy.humanGates.clarification,
      plan: workspace.policy.humanGates.plan,
      review: workspace.policy.humanGates.review,
      "side-effect": workspace.policy.humanGates.sideEffect,
    },
    ...(Object.keys(workspace.mandatoryGates).length > 0
      ? { mandatorySecurity: workspace.mandatoryGates }
      : {}),
  });
  const m = workspace.mandatoryGates;
  return {
    mandatoryGates: {
      ...(m.clarification === undefined ? {} : { clarification: m.clarification }),
      ...(m.plan === undefined ? {} : { plan: m.plan }),
      ...(m.review === undefined ? {} : { review: m.review }),
      ...(m["side-effect"] === undefined ? {} : { sideEffect: m["side-effect"] }),
    },
    effectiveGates: {
      clarification: resolved.clarification.mode,
      plan: resolved.plan.mode,
      review: resolved.review.mode,
      sideEffect: resolved["side-effect"].mode,
    },
    /**
     * NOT `?? DEFAULT_QUALITY_GATES`. The execution node refuses to run a
     * verification whose catalog is absent (10 sections 1-3), and that refusal
     * is only meaningful if the node can tell "the operator configured `test`"
     * from "nobody configured anything". Substituting the built-in defaults
     * here made the two indistinguishable, so an entirely unconfigured
     * workspace got `npm test` executed in a checkout a `repo.write` worker in
     * the same task can edit. An unconfigured workspace sends NOTHING: the node
     * refuses the run, and plan validation refuses every gate name the plan
     * asks for instead of silently validating against the built-ins.
     */
    ...(workspace.qualityGates === undefined
      ? {}
      : { qualityGates: workspace.qualityGates }),
  };
}

type VerificationActivity = Activities["runVerification"];
type VerificationInput = Parameters<VerificationActivity>[0];
type VerificationOutcome = Awaited<ReturnType<VerificationActivity>>;

/**
 * Wraps `runVerification` so the step record — the completion gate's only
 * evidence (08 section 8) — tells the truth about what happened.
 *
 * The failure path is the load-bearing one. A verification that THREW never
 * ran: the node refused it, the deployment is wrong, the sandbox denied the
 * root. Recording that as `succeeded`, or answering `{status:"passed"}` on the
 * activity's behalf, would let a verification that never executed satisfy both
 * `required-steps-terminal` and `verification-policy-satisfied` — a `coding`
 * task would complete with nothing verified and nothing in the logs saying so.
 * So the step is recorded FAILED and the error is re-raised: the operator sees
 * where the task stopped and why.
 *
 * Extracted from the activity table so this is testable without a Temporal
 * worker, because the branch had no test at all.
 */
export function withVerificationStepRecording(
  run: (input: VerificationInput) => Promise<VerificationOutcome>,
  record: (
    taskId: string,
    stepKey: string,
    outcome: "succeeded" | "failed",
  ) => Promise<void> | void,
  onUnavailable: (message: string) => void = (message) => process.stderr.write(message),
): VerificationActivity {
  return async (input: VerificationInput): Promise<VerificationOutcome> => {
    let result: VerificationOutcome;
    try {
      result = await run(input);
    } catch (error) {
      // A refusal is still evidence: the step is recorded as failed so the
      // operator sees WHERE the task stopped, and the error propagates so
      // they also see WHY. Never swallowed into a "failed gate", and never
      // turned into a pass.
      await record(input.taskId, input.stepKey, "failed");
      if (error instanceof VerificationUnavailableError) {
        onUnavailable(`meidoyad: ${error.message}\n`);
      }
      throw error;
    }
    await record(
      input.taskId,
      input.stepKey,
      result.status === "passed" ? "succeeded" : "failed",
    );
    return result;
  };
}

export type CheckpointSweeper = {
  /** Runs one sweep, serialised behind any sweep already in flight. */
  sweep(): void;
  /** Starts the periodic sweep and runs the startup sweep immediately. */
  start(): void;
  /** Stops the timer and waits for an in-flight sweep to finish. */
  stop(): Promise<void>;
};

/**
 * Re-delivers checkpoint answers that were committed but never signalled.
 *
 * Answering a checkpoint commits the row and then signals the workflow; no
 * transaction spans the two, so a failure in between leaves a task parked
 * forever on an answer that was already accepted. The retry path in
 * `checkpoint.answer` recovers it only if a client retries — and a CLI that
 * exited on the error never will. This sweep is what makes the guarantee not
 * depend on the client.
 *
 * Four properties, each of which was once unasserted:
 *
 *   * it never throws into startup and one transient error never ends the
 *     loop — that is exactly how the notification publisher went silently dead;
 *   * sweeps never overlap and none starts after `stop()`, so shutdown cannot
 *     cut a signal in half or resurrect work after the server closed;
 *   * `stop()` waits for the in-flight sweep;
 *   * the timer is unref'd, so a daemon that is otherwise idle can still exit.
 */
export function createCheckpointSweeper(options: {
  reconcile: () => Promise<CheckpointReconcileResult>;
  intervalMs: number;
  log?: (message: string) => void;
}): CheckpointSweeper {
  const log = options.log ?? ((message: string): void => void process.stderr.write(message));
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;

  const sweep = (): void => {
    inFlight = inFlight.then(async () => {
      // A sweep queued before `stop()` must not start after it.
      if (stopped) return;
      try {
        const result = await options.reconcile();
        if (result.delivered > 0 || result.failed > 0) {
          log(
            `meidoyad: checkpoint delivery sweep: ${result.delivered} re-delivered,` +
              ` ${result.failed} still pending of ${result.scanned}` +
              ` (backlog ${result.backlog}, ${result.awaitingCorroboration} awaiting a` +
              ` corroborating verdict)\n`,
          );
        }
      } catch (error: unknown) {
        // Loud but survivable: the next tick tries again.
        log(`meidoyad: checkpoint delivery sweep failed (will retry): ${String(error)}\n`);
      }
    });
  };

  return {
    sweep,
    start(): void {
      timer = setInterval(sweep, options.intervalMs);
      // An idle daemon must still be able to exit; this timer is not work.
      timer.unref?.();
      // Startup sweep: whatever the previous process left undelivered is
      // delivered now, not when someone happens to answer another checkpoint.
      sweep();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      // Let an in-flight sweep finish so a signal is never cut in half.
      await inFlight;
    },
  };
}

/**
 * Composes the Control Plane process (02 section 2): Control Plane API over the
 * unix socket, chat gateway, Temporal control worker, the single SQLite writer,
 * the notification outbox publisher and the STATUS.md projector.
 */
export async function startDaemon(options: DaemonOptions): Promise<StartedDaemon> {
  const config = options.config;
  if (config.temporal.controlTaskQueue !== CONTROL_TASK_QUEUE) {
    throw new Error(
      `control_task_queue must be "${CONTROL_TASK_QUEUE}" (got "${config.temporal.controlTaskQueue}")`,
    );
  }

  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(path.dirname(config.sqlitePath), { recursive: true });

  const db = openDatabase(config.sqlitePath);
  migrate(db, migrations);
  seedFromConfig(db, config);

  const queue = new SerialWriteQueue();
  const repository = new SqliteTaskRepository(db, queue);
  const events = new ControlEventBus();
  const scopes = new ScopeRegistry(config, loadOrCreateScopeSecret(config.dataDir), {
    // Per-profile bearer credentials for local clients, 0600 under the data dir.
    // Provisioned first: the registry fingerprints the credential files, so a
    // rotated secret revokes the sessions minted under the old one.
    credentials: ClientCredentialStore.provision(config.dataDir, config.ingressBindings),
    // Revocation outlives the process only because the epochs are on disk.
    epochs: createSqliteBindingEpochStore(db),
    persist: (write) => {
      // Same guard as every other write: an epoch row must never join (and be
      // rolled back with) another component's open transaction. A failure here
      // means a revocation may not survive a restart, so it is loud.
      repository.runWrite(() => write()).catch((error: unknown) => {
        process.stderr.write(
          `meidoyad: FATAL: could not persist a binding epoch, revocation may not survive a restart: ${String(error)}\n`,
        );
      });
    },
  });

  const workspaceById = new Map<WorkspaceId, ResolvedWorkspace>(
    config.workspaces.map((w) => [w.workspaceId, w]),
  );
  const policyOfWorkspace = (workspaceId: string): WorkspacePolicy | undefined =>
    workspaceById.get(workspaceId)?.policy;
  const gatePolicyOfWorkspace = (workspaceId: string): WorkspaceGatePolicy | undefined => {
    const workspace = workspaceById.get(workspaceId);
    if (workspace === undefined) return undefined;
    return { policy: workspace.policy, mandatoryGates: workspace.mandatoryGates };
  };
  const policyOfTask = (taskId: string): WorkspacePolicy | undefined => {
    const task = repository.loadTaskSync(taskId);
    return task === undefined ? undefined : policyOfWorkspace(task.workspaceId);
  };
  const rootTaskIdOf = (taskId: string): string =>
    rootTaskIdOfChain((id) => repository.loadTaskSync(id), taskId);

  const commandsFor = createVerificationCommands();

  const budget = createExecutionBudgetPort({
    policyOf: policyOfTask,
    rootOf: rootTaskIdOf,
    store: createSqliteBudgetStateStore(db, (args) => repository.appendTaskEvent(args)),
  });

  // Conversation rows and outbox writes go through the same serial write queue
  // as every other mutation (08 section 8), so they can never execute inside —
  // and be rolled back with — another component's open transaction.
  const chat = createChatGateway({
    config,
    db,
    // Guarded: enqueueing from inside an open transaction span would wedge the
    // write queue for the life of the process, so it rejects instead.
    runWrite: (fn) => repository.runWrite(fn),
    ...(options.chatTransport === undefined ? {} : { transportOverride: options.chatTransport }),
  });
  for (const source of new Set(
    config.ingressBindings
      .filter((binding) => binding.enabled && (binding.source === "slack" || binding.source === "discord"))
      .map((binding) => binding.source),
  )) {
    if (!chat.platformClients.has(source)) {
      process.stderr.write(
        `meidoyad: ${source} ingress is configured but has no credentials; set the matching MEIDOYA_*_TOKEN_FILE variables\n`,
      );
    }
  }
  // Nothing else registers conversations, and an outbox row with no registered
  // conversation can never be delivered (07 section 5).
  const delivery = createChatDeliveryWiring({
    gateway: chat,
    config,
    db,
    events,
    onError: (error: unknown) =>
      void process.stderr.write(
        `meidoyad: could not open a task's conversation; its notifications wait for the next reconcile: ${String(error)}\n`,
      ),
  });
  // Registration rides an in-process bus and is started with `void`: a crash or
  // a throw between accepting a request and committing its conversation would
  // otherwise strand that task's notifications for good. Repair what the last
  // process left owing before anything new is accepted.
  const conversationsRepaired = (await delivery?.reconcileConversations()) ?? 0;
  if (conversationsRepaired > 0) {
    process.stderr.write(
      `meidoyad: reopened ${conversationsRepaired} task conversation(s) that had none\n`,
    );
  }

  const readMessage = (ref: string): string | undefined => {
    if (ref.startsWith("schedule:")) {
      const row = db
        .prepare("SELECT task_template_json FROM schedules WHERE id = ?")
        .get(ref.slice("schedule:".length)) as { task_template_json: string } | undefined;
      return row?.task_template_json;
    }
    const key = ref.startsWith("task_event:") ? ref.slice("task_event:".length) : ref;
    const row = db
      .prepare("SELECT payload_json FROM task_events WHERE idempotency_key = ?")
      .get(key) as { payload_json: string } | undefined;
    return row?.payload_json;
  };

  // Coordinating roles run on this host, so this daemon owns their agent port.
  // A daemon that can run none of them says so at startup instead of failing
  // the first task that needs one.
  const coordinationWorkdir = path.join(config.dataDir, "coordination");
  mkdirSync(coordinationWorkdir, { recursive: true });
  const agentPort = createDaemonAgentPort({
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    ...(options.agentRuntimes === undefined ? {} : { runtimes: options.agentRuntimes }),
    ...(config.modelMapping === undefined ? {} : { modelMapping: config.modelMapping }),
    workdir: coordinationWorkdir,
    warn: (message) => {
      if (options.onDegraded === undefined) process.stderr.write(message);
      else options.onDegraded(message);
    },
  });

  const temporal =
    options.temporal ?? (await connectTemporal(config.temporal.address, config.temporal.namespace));
  const gateway = new TemporalWorkflowGateway(
    temporal.client,
    config.environmentId,
    (workspaceId) => {
      const nodeId = executionNodeForWorkspace(config, workspaceId);
      if (nodeId === undefined) {
        throw new Error(
          `workspace ${workspaceId} has no configured execution node matching its preferred or fallback profiles`,
        );
      }
      return nodeId;
    },
  );
  const delegationRegistry = new DelegationRegistry(
    Object.entries(config.headMaid?.enabled === true ? config.headMaid.grants : {}).map(([target, capabilities]) => ({
      source: "global" as const,
      target,
      capabilities,
    })),
  );

  const service = new ControlPlaneService({
    config,
    repository,
    scopes,
    gateway,
    events,
    nodeCredentials: NodeCredentialStore.provision(
      config.dataDir,
      config.nodePolicies.map((policy) => policy.nodeId),
    ),
  });
  const chatIngress = createChatIngress({
    gateway: chat,
    config,
    repository,
    scopes,
    service,
  });

  const baseActivities = createActivities({
    repository,
    agents: agentPort,
    checkpointPolicy: createCheckpointPolicyPort(gatePolicyOfWorkspace),
    budget,
    interactionPolicy: createInteractionPolicyPort({
      events,
      ...(config.interaction === undefined ? {} : { config: config.interaction }),
    }),
    commands: commandsFor,
    artifacts: createArtifactProbe(config.dataDir),
    clock: systemClock,
    ids: uuidIds,
    prompts: createPromptBuilder(
      readMessage,
      (workspaceId) => workspaceById.get(workspaceId)?.projects ?? [],
      config.timezone,
      config.maidAgentProfile,
    ),
    policies: {
      async load(workspaceId) {
        const policy = policyOfWorkspace(workspaceId);
        if (policy === undefined) throw new Error(`unknown workspace ${workspaceId}`);
        return { policy, revision: 1 };
      },
      gatePolicy(workspaceId) {
        const workspace = workspaceById.get(workspaceId);
        if (workspace === undefined) throw new Error(`unknown workspace ${workspaceId}`);
        return gatePolicyOutputFor(workspace);
      },
    },
    workspaceProjects: (workspaceId) => workspaceById.get(workspaceId)?.projects ?? [],
    delegations: createDelegationPort({
      registry: delegationRegistry,
      workspaces: workspaceById,
      repository,
      gateway,
      now: systemClock.now,
    }),
    scheduledResults: {
      async compare({ taskId, workspaceId, resultHash }) {
        const previous = db
          .prepare(
            `SELECT e.payload_json AS payload FROM task_events e
               JOIN tasks t ON t.id = e.task_id
              WHERE t.workspace_id = ? AND e.event_type = 'ScheduledResultHash' AND e.task_id != ?
              ORDER BY e.created_at DESC LIMIT 1`,
          )
          .get(workspaceId, taskId) as { payload: string } | undefined;
        await repository.appendTaskEvent({
          taskId,
          eventType: "ScheduledResultHash",
          idempotencyKey: `result-hash:${taskId}:${resultHash}`,
          payload: { resultHash },
        });
        if (previous === undefined) return { changed: true };
        const parsed = JSON.parse(previous.payload) as { resultHash?: string };
        return { changed: parsed.resultHash !== resultHash };
      },
    },
    administration: {
      execute: (input) =>
        service.executeAdministrativeCommand({
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          command: input.command,
          ...(input.conversationId === undefined
            ? {}
            : { conversationId: input.conversationId }),
        }),
      context: (input) => service.maidWorkspaceContext(input),
      materializeScheduledRequest: (input) => service.materializeScheduledRequest(input),
    },
    parse: createParsers(),
    routing: createModelRouting(config.modelPolicy),
  });

  // Step records are the completion gate's evidence, and only the control plane
  // may write them (08 section 8), so they are recorded around the activities.
  const activities: Activities = {
    ...baseActivities,
    async planTask(input) {
      const result = await baseActivities.planTask(input);
      if (result.status === "planned") {
        await recordStepProgress(repository, input.taskId, input.stepKey, "succeeded");
      }
      return result;
    },
    runVerification: withVerificationStepRecording(
      (input) => baseActivities.runVerification(input),
      (taskId, stepKey, outcome) => recordStepProgress(repository, taskId, stepKey, outcome),
    ),
    async runReview(input) {
      const result = await baseActivities.runReview(input);
      const blocking = result.findings.some((finding) => finding.severity === "blocking");
      await recordStepProgress(
        repository,
        input.taskId,
        input.stepKey,
        blocking ? "failed" : "succeeded",
      );
      return result;
    },
  };

  const worker: Worker = await createControlWorker({
    client: temporal.client,
    ...(temporal.connection === undefined ? {} : { connection: temporal.connection }),
    namespace: config.temporal.namespace,
    environmentId: config.environmentId,
    activities,
    ...(options.maxCachedWorkflows === undefined
      ? {}
      : { maxCachedWorkflows: options.maxCachedWorkflows }),
  });
  const workerRun = worker.run();

  const server = new ControlPlaneServer({
    socketPath: config.socketPath,
    service,
    scopes,
    handlers: createMethodHandlers(service),
    events,
  });
  await server.start();
  const nodeServer =
    config.nodeTcp === undefined
      ? undefined
      : new ControlPlaneServer({
          listen: {
            kind: "tcp",
            host: config.nodeTcp.host,
            port: config.nodeTcp.port,
            allowedPeers: config.nodeTcp.allowedPeers,
          },
          service,
          scopes,
          handlers: createMethodHandlers(service),
          events,
        });
  await nodeServer?.start();
  await chatIngress?.start();

  const outboxAbort = new AbortController();
  let outboxStopping = false;
  /**
   * The publisher loop ending means no notification is ever delivered again for
   * the life of this process. Swallowing that made the failure silent *and*
   * invisible: nothing logged, nothing observable, deliveries simply stopped.
   * Any exit that was not asked for is fatal and says so.
   */
  const reportOutboxExit = (error: unknown): void => {
    if (outboxStopping) return;
    const detail = error === undefined ? "loop returned" : String(error);
    const message = `meidoyad: FATAL: the notification publisher stopped (${detail}); no further notifications will be delivered by this process\n`;
    if (options.onPublisherExit === undefined) process.stderr.write(message);
    else options.onPublisherExit(error, message);
  };
  const outboxLoop = runPublisherLoop(
    db,
    chat.defaultTransport,
    delivery?.resolver ?? createDirectoryResolver(chat.directory),
    {
      signal: outboxAbort.signal,
      intervalMs: options.outboxIntervalMs ?? 1_000,
      runWrite: (_kind, fn) => repository.runWrite(fn),
    },
  ).then(
    () => reportOutboxExit(undefined),
    (error: unknown) => reportOutboxExit(error),
  );

  const status = new StatusProjector({
    db,
    config,
    service,
    ...(options.statusIntervalMs === undefined ? {} : { intervalMs: options.statusIntervalMs }),
  });
  status.start();

  const sweeper = createCheckpointSweeper({
    reconcile: async () => {
      const checkpoints = await service.reconcileCheckpointDeliveries();
      const requests = await service.reconcileReceivedRequests();
      if (requests.submitted > 0 || requests.failed > 0) {
        process.stderr.write(
          `meidoyad: received request recovery: ${requests.submitted} submitted,` +
            ` ${requests.failed} failed of ${requests.scanned}\n`,
        );
      }
      return checkpoints;
    },
    intervalMs: options.checkpointReconcileIntervalMs ?? 30_000,
  });
  sweeper.start();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Stop socket ingress first and drain its current event before the service
    // starts refusing work, so an event already acknowledged by Slack/Discord
    // is either committed or reports its real failure instead of being dropped.
    await chatIngress?.stop();
    service.startDraining();
    delivery?.stop();
    await nodeServer?.close();
    await server.close();
    status.stop();
    // Stops the timer AND waits for the in-flight sweep: a signal is never cut
    // in half, and no sweep queued before this point starts after it.
    await sweeper.stop();
    outboxStopping = true;
    outboxAbort.abort();
    await outboxLoop;
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
    await queue.close();
    if (options.temporal === undefined) {
      const owned = temporal as TemporalConnections;
      await owned.connection.close().catch(() => undefined);
      await owned.clientConnection.close().catch(() => undefined);
    }
    db.close();
  };

  return {
    config,
    db,
    repository,
    service,
    scopes,
    events,
    gateway,
    status,
    transport: chat.defaultTransport,
    socketPath: config.socketPath,
    nodeTcpAddress:
      config.nodeTcp === undefined ? undefined : `${config.nodeTcp.host}:${String(config.nodeTcp.port)}`,
    budget,
    stop,
  };
}
