import type {
  ArtifactRef,
  DomainEvent,
  ExecutionBudget,
  HumanCheckpoint,
  Task,
  TaskId,
  TaskStatus,
} from "@meidoya/domain";

import type {
  AgentInvocation,
  AgentInvocationPort,
  AgentInvocationResult,
  ArtifactProbePort,
  BudgetCharge,
  BudgetDecision,
  BudgetExtension,
  CheckpointPolicyDecision,
  CheckpointPolicyPort,
  CheckpointPolicyQuery,
  ClockPort,
  CommandExecution,
  CommandRunnerPort,
  CommandSpec,
  ExecutionBudgetPort,
  IdPort,
  InteractionPolicyPort,
  OutboxIntent,
  StepRecord,
  TaskRepositoryPort,
} from "./ports.js";

export class InMemoryTaskRepository implements TaskRepositoryPort {
  tasks = new Map<TaskId, Task>();
  steps: StepRecord[] = [];
  events: { taskId: TaskId; eventType: string; idempotencyKey: string }[] = [];
  checkpoints = new Map<string, HumanCheckpoint>();
  artifacts = new Map<TaskId, ArtifactRef[]>();
  outbox: OutboxIntent[] = [];
  private depth = 0;

  loadTask(taskId: TaskId): Task | undefined {
    return this.tasks.get(taskId);
  }

  updateTaskStatus(args: {
    taskId: TaskId;
    nextStatus: TaskStatus;
    expectedVersion: number;
    pipeline?: Task["pipeline"];
  }): boolean {
    const task = this.tasks.get(args.taskId);
    if (!task) return false;
    if (task.version !== args.expectedVersion) return false;
    const next: Task = { ...task, status: args.nextStatus, version: task.version + 1 };
    if (args.pipeline !== undefined) next.pipeline = args.pipeline;
    this.tasks.set(args.taskId, next);
    return true;
  }

  appendTaskEvent(args: {
    taskId: TaskId;
    eventType: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): void {
    if (this.events.some((e) => e.idempotencyKey === args.idempotencyKey)) return;
    this.events.push({
      taskId: args.taskId,
      eventType: args.eventType,
      idempotencyKey: args.idempotencyKey,
    });
  }

  upsertStep(step: Omit<StepRecord, "id" | "version"> & { id?: string }): StepRecord {
    const existing = this.steps.find(
      (s) => s.taskId === step.taskId && s.stepKey === step.stepKey,
    );
    if (existing) {
      Object.assign(existing, step, { version: existing.version + 1 });
      return existing;
    }
    const created: StepRecord = {
      ...step,
      id: step.id ?? `${step.taskId}:${step.stepKey}`,
      version: 1,
    };
    this.steps.push(created);
    return created;
  }

  listSteps(taskId: TaskId): StepRecord[] {
    return this.steps.filter((s) => s.taskId === taskId);
  }

  recordCheckpoint(checkpoint: HumanCheckpoint): void {
    this.checkpoints.set(checkpoint.id, checkpoint);
  }

  loadCheckpoint(id: string): HumanCheckpoint | undefined {
    return this.checkpoints.get(id);
  }

  saveArtifacts(taskId: TaskId, artifacts: ArtifactRef[]): void {
    this.artifacts.set(taskId, [...(this.artifacts.get(taskId) ?? []), ...artifacts]);
  }

  listArtifacts(taskId: TaskId): ArtifactRef[] {
    return this.artifacts.get(taskId) ?? [];
  }

  enqueueNotification(intent: OutboxIntent): void {
    if (this.outbox.some((i) => i.idempotencyKey === intent.idempotencyKey)) return;
    this.outbox.push(intent);
  }

  async transaction<T>(fn: (tx: InMemoryTaskRepository) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot();
    this.depth += 1;
    try {
      // The fake has no scope to enforce; it is its own handle.
      return await fn(this);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  private snapshot() {
    return {
      tasks: new Map(this.tasks),
      steps: this.steps.map((s) => ({ ...s })),
      events: [...this.events],
      checkpoints: new Map(this.checkpoints),
      artifacts: new Map<TaskId, ArtifactRef[]>([...this.artifacts].map(([k, v]) => [k, [...v]])),
      outbox: [...this.outbox],
    };
  }

  private restore(snapshot: ReturnType<InMemoryTaskRepository["snapshot"]>): void {
    this.tasks = snapshot.tasks;
    this.steps = snapshot.steps;
    this.events = snapshot.events;
    this.checkpoints = snapshot.checkpoints;
    this.artifacts = snapshot.artifacts;
    this.outbox = snapshot.outbox;
  }
}

export class FakeAgentPort implements AgentInvocationPort {
  calls: AgentInvocation[] = [];
  private readonly queue: AgentInvocationResult[];
  private readonly fallback: AgentInvocationResult;

  constructor(
    results: AgentInvocationResult[] = [],
    fallback: AgentInvocationResult = { status: "succeeded", output: null },
  ) {
    this.queue = [...results];
    this.fallback = fallback;
  }

  invoke(invocation: AgentInvocation): AgentInvocationResult {
    const replay = this.calls.find((c) => c.idempotencyKey === invocation.idempotencyKey);
    if (replay) return this.fallback;
    this.calls.push(invocation);
    return this.queue.shift() ?? this.fallback;
  }
}

export class FakeCheckpointPolicy implements CheckpointPolicyPort {
  queries: CheckpointPolicyQuery[] = [];

  constructor(private readonly decide: (q: CheckpointPolicyQuery) => CheckpointPolicyDecision) {}

  evaluate(query: CheckpointPolicyQuery): CheckpointPolicyDecision {
    this.queries.push(query);
    return this.decide(query);
  }
}

export class FakeExecutionBudget implements ExecutionBudgetPort {
  used = new Map<TaskId, number>();
  charges: BudgetCharge[] = [];
  extended = new Set<TaskId>();

  constructor(private readonly budget: ExecutionBudget) {}

  /** Charges land on the root task, exactly like the production ledger. */
  #root(charge: BudgetCharge): TaskId {
    return charge.rootTaskId ?? charge.taskId;
  }

  charge(charge: BudgetCharge): BudgetDecision {
    this.charges.push(charge);
    const root = this.#root(charge);
    const max = this.budget.maxSteps + (this.extended.has(root) ? this.budget.maxSteps : 0);
    const next = (this.used.get(root) ?? 0) + 1;
    if (next > max) {
      return { allowed: false, limit: "max_steps", stepsUsed: this.used.get(root) ?? 0 };
    }
    this.used.set(root, next);
    return { allowed: true, stepsUsed: next };
  }

  snapshot(taskId: TaskId): { stepsUsed: number } {
    return { stepsUsed: this.used.get(taskId) ?? 0 };
  }

  extendOnce(taskId: TaskId): BudgetExtension {
    if (this.extended.has(taskId)) return { ok: false, reason: "already-extended" };
    this.extended.add(taskId);
    return { ok: true, maxSteps: this.budget.maxSteps * 2 };
  }
}

/** Minimal stand-in for @meidoya/interaction-policy's default event matrix (07 section 2). */
export class FakeInteractionPolicy implements InteractionPolicyPort {
  events: DomainEvent[] = [];
  /** Recorded separately so a test can assert what live subscribers were told. */
  published: DomainEvent[] = [];
  /** The durable ledger: keys a caller confirmed committed, in order. */
  recorded: string[] = [];

  constructor(private readonly silentTypes: string[] = ["TaskStarted", "TaskProgressed"]) {}

  publish(event: DomainEvent): void {
    this.published.push(event);
  }

  recordEmitted(intents: readonly OutboxIntent[]): void {
    for (const intent of intents) this.recorded.push(intent.idempotencyKey);
  }

  emit(event: DomainEvent): OutboxIntent[] {
    this.events.push(event);
    if (this.silentTypes.includes(event.type)) return [];
    const base = {
      workspaceId: event.workspaceId,
      eventId: event.id,
      payload: event.payload,
    };
    return [
      { ...base, action: "post-thread-message" as const, idempotencyKey: `${event.id}:message` },
    ];
  }
}

export class FakeCommandRunner implements CommandRunnerPort {
  calls: CommandSpec[] = [];

  constructor(private readonly outcomes: Record<string, Partial<CommandExecution>> = {}) {}

  run(spec: CommandSpec): CommandExecution {
    this.calls.push(spec);
    const configured = this.outcomes[spec.name] ?? {};
    return {
      exitCode: configured.exitCode ?? 0,
      durationMs: configured.durationMs ?? 1,
      ...(configured.failureSignature !== undefined
        ? { failureSignature: configured.failureSignature }
        : {}),
      ...(configured.evidence !== undefined ? { evidence: configured.evidence } : {}),
      ...(configured.artifacts !== undefined ? { artifacts: configured.artifacts } : {}),
    };
  }
}

export class FakeArtifactProbe implements ArtifactProbePort {
  constructor(private readonly present: Set<string> = new Set()) {}

  add(path: string): void {
    this.present.add(path);
  }

  exists(path: string): boolean {
    return this.present.has(path);
  }
}

export class FixedClock implements ClockPort {
  constructor(private current = 0) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
}

export class SequentialIds implements IdPort {
  private counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }
}
