import { rmSync } from "node:fs";
import { FakeChatTransport } from "@meidoya/chat-core";
import { publishOnce, getByIdempotencyKey, listAll } from "@meidoya/notification-outbox";
import { migrate, migrations, openDatabase, type MeidoyaDatabase } from "@meidoya/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlPlaneConfig, resolveControlPlaneConfig } from "./config.js";
import { createChatDeliveryWiring, createChatGateway } from "./chat-gateway.js";
import { ControlEventBus } from "./events.js";
import { SqliteTaskRepository, seedFromConfig } from "./repository.js";
import { SerialWriteQueue } from "./write-queue.js";
import { createInteractionPolicyPort } from "./ports.js";
import { makeDataDir, testConfigYaml } from "./testing/harness.js";

const WORKSPACE = "work-grammarxiv";

type Rig = {
  db: MeidoyaDatabase;
  queue: SerialWriteQueue;
  repository: SqliteTaskRepository;
  events: ControlEventBus;
  transport: FakeChatTransport;
  delivery: NonNullable<ReturnType<typeof createChatDeliveryWiring>>;
  /** One port per process, exactly as the daemon builds it. */
  policy: ReturnType<typeof createInteractionPolicyPort>;
  close(): Promise<void>;
};

const dirs: string[] = [];

/**
 * Boots the pieces the daemon composes for chat delivery — chat gateway,
 * conversation registry, delivery wiring, interaction policy, outbox — against
 * a real SQLite file, using the production factories rather than test doubles.
 * `register` mirrors a daemon restart against the same data dir.
 */
function bootstrap(dataDir: string): Rig {
  const config = resolveControlPlaneConfig(parseControlPlaneConfig(testConfigYaml(dataDir)));
  const db = openDatabase(config.sqlitePath);
  migrate(db, migrations);
  seedFromConfig(db, config);

  const queue = new SerialWriteQueue();
  const repository = new SqliteTaskRepository(db, queue);
  const events = new ControlEventBus();
  const transport = new FakeChatTransport();
  const chat = createChatGateway({
    config,
    db,
    runWrite: (fn) => queue.enqueue(fn),
    transportOverride: transport,
  });
  const delivery = createChatDeliveryWiring({ gateway: chat, config, db, events });
  if (delivery === undefined) throw new Error("delivery wiring is not available");

  return {
    db,
    queue,
    repository,
    events,
    transport,
    delivery,
    policy: createInteractionPolicyPort({ events }),
    async close() {
      delivery.stop();
      await queue.close();
      db.close();
    },
  };
}

/** What `ControlPlaneService.createTask` does: create the task, announce it. */
async function acceptRequest(rig: Rig, taskId: string): Promise<void> {
  await rig.repository.createTask({
    taskId,
    workspaceId: WORKSPACE,
    origin: "cli",
    pipeline: "coding",
    title: "Fix the parser",
    intent: { summary: "Fix the parser", projects: ["grammarxiv"], origin: "cli" },
    temporalWorkflowId: `task/${taskId}`,
    now: Date.now(),
  });
  rig.events.publish({ workspaceId: WORKSPACE, taskId, type: "RequestAccepted", at: Date.now() });
  // The subscriber registers asynchronously; let its writes drain.
  await rig.queue.drain();
}

/** What `activities.emitDomainEvent` does: policy -> outbox, in one transaction. */
async function emitDomainEvent(
  rig: Rig,
  input: { taskId: string; eventId: string; type: string; payload: Record<string, unknown> },
): Promise<void> {
  const intents = await rig.policy.emit({
    id: input.eventId,
    taskId: input.taskId,
    workspaceId: WORKSPACE,
    type: input.type as never,
    payload: input.payload,
    createdAt: Date.now(),
  });
  await rig.repository.transaction(async (tx) => {
    await tx.appendTaskEvent({
      taskId: input.taskId,
      eventType: input.type,
      idempotencyKey: `event:${input.eventId}`,
      payload: input.payload,
    });
    for (const intent of intents) await tx.enqueueNotification(intent);
  });
  // Only now, exactly as the activity does: the emit ledger records what is
  // durable, so a failed attempt never turns its own retry into an edit.
  await rig.policy.recordEmitted(intents);
}

function postedTexts(transport: FakeChatTransport): string[] {
  return transport.callsOfKind("post-thread-message").map((c) => c.message.text);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = makeDataDir();
  dirs.push(dir);
  return dir;
}

describe("end-to-end notification delivery (07 sections 1 and 5)", () => {
  it("a request opens a conversation and a checkpoint event ARRIVES at the transport", async () => {
    const rig = bootstrap(dataDir());
    await acceptRequest(rig, "task-1");
    await emitDomainEvent(rig, {
      taskId: "task-1",
      eventId: "evt-1",
      type: "WaitingPlanApproval",
      payload: {
        checkpointId: "cp_1",
        checkpointVersion: 1,
        prompt: "Approve the migration plan?",
        choices: [{ id: "approve", label: "Approve" }],
      },
    });

    const result = await publishOnce(rig.db, rig.transport, rig.delivery.resolver, {
      runWrite: (_kind, fn) => rig.queue.enqueue(fn),
    });

    expect(result.failed).toBe(0);
    expect(result.sent).toBeGreaterThan(0);
    expect(postedTexts(rig.transport)).toHaveLength(1);
    expect(postedTexts(rig.transport)[0]).toContain("Approve the migration plan?");
    expect(rig.transport.callsOfKind("add-reaction").map((c) => c.emoji.name)).toEqual(["memo"]);
    expect(listAll(rig.db).every((r) => r.status === "sent")).toBe(true);
    await rig.close();
  });

  it("delivers NOTHING when the conversation was never registered", async () => {
    // The failure this whole path shipped with: an unregistered conversation
    // resolves to no thread, so the row can never be delivered.
    const rig = bootstrap(dataDir());
    rig.delivery.stop();
    await rig.repository.createTask({
      taskId: "task-2",
      workspaceId: WORKSPACE,
      origin: "cli",
      pipeline: "coding",
      title: "Fix the parser",
      intent: { summary: "Fix the parser", projects: ["grammarxiv"], origin: "cli" },
      temporalWorkflowId: "task/task-2",
      now: Date.now(),
    });
    await emitDomainEvent(rig, {
      taskId: "task-2",
      eventId: "evt-2",
      type: "WaitingPlanApproval",
      payload: { checkpointId: "cp_2", checkpointVersion: 1, prompt: "Approve?" },
    });

    const result = await publishOnce(rig.db, rig.transport, rig.delivery.resolver, {});
    expect(result.sent).toBe(0);
    expect(rig.transport.calls).toHaveLength(0);
    await rig.close();
  });

  it("renders the ACTUAL clarification question, never the bare heading", async () => {
    const rig = bootstrap(dataDir());
    await acceptRequest(rig, "task-3");
    await emitDomainEvent(rig, {
      taskId: "task-3",
      eventId: "evt-3",
      type: "WaitingClarification",
      payload: { question: "Which branch should I target?" },
    });
    await publishOnce(rig.db, rig.transport, rig.delivery.resolver, {});

    const [text] = postedTexts(rig.transport);
    expect(text).toContain("Which branch should I target?");
    expect(text).not.toBe("Question");
    await rig.close();
  });

  it("never lets a raw or log field reach the transport", async () => {
    const rig = bootstrap(dataDir());
    await acceptRequest(rig, "task-4");
    await emitDomainEvent(rig, {
      taskId: "task-4",
      eventId: "evt-4",
      type: "TaskCompleted",
      payload: {
        summary: "Fixed the parser",
        rawOutput: "I think maybe I should ...",
        logs: "line1\nline2",
        stdout: "sk-ABCDEFGH12345678abcdef",
      },
    });
    await publishOnce(rig.db, rig.transport, rig.delivery.resolver, {});

    const [text] = postedTexts(rig.transport);
    expect(text).toContain("Fixed the parser");
    expect(text).not.toContain("I think maybe");
    expect(text).not.toContain("line1");
    expect(text).not.toContain("sk-ABCDEFGH");
    await rig.close();
  });

  it("produces zero external messages for a run's worth of internal progress", async () => {
    const rig = bootstrap(dataDir());
    await acceptRequest(rig, "task-5");
    for (const [i, note] of ["step-started", "retry", "verifying", "reviewing"].entries()) {
      await emitDomainEvent(rig, {
        taskId: "task-5",
        eventId: `evt-progress-${i}`,
        type: "TaskProgressed",
        payload: { kind: note },
      });
    }
    await publishOnce(rig.db, rig.transport, rig.delivery.resolver, {});
    expect(rig.transport.calls).toHaveLength(0);
    await rig.close();
  });

  it("keeps one active message per checkpoint version: the repeat EDITS", async () => {
    const rig = bootstrap(dataDir());
    await acceptRequest(rig, "task-6");
    const payload = { checkpointId: "cp_6", checkpointVersion: 1, prompt: "Approve?" };
    await emitDomainEvent(rig, {
      taskId: "task-6",
      eventId: "evt-6a",
      type: "WaitingPlanApproval",
      payload,
    });
    await publishOnce(rig.db, rig.transport, rig.delivery.resolver, {});
    await emitDomainEvent(rig, {
      taskId: "task-6",
      eventId: "evt-6b",
      type: "WaitingPlanApproval",
      payload: { ...payload, prompt: "Approve? (updated)" },
    });
    await publishOnce(rig.db, rig.transport, rig.delivery.resolver, {});

    expect(rig.transport.callsOfKind("post-thread-message")).toHaveLength(1);
    const edits = rig.transport.callsOfKind("update-message");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.message.text).toContain("Approve? (updated)");
    await rig.close();
  });
});

describe("conversations survive a daemon restart", () => {
  it("re-registers from SQLite and keeps delivering", async () => {
    const dir = dataDir();
    const first = bootstrap(dir);
    await acceptRequest(first, "task-restart");
    await first.close();

    // Second process, same data dir: nothing registered it in memory.
    const second = bootstrap(dir);
    await emitDomainEvent(second, {
      taskId: "task-restart",
      eventId: "evt-restart",
      type: "TaskCompleted",
      payload: { summary: "Done after restart" },
    });
    const result = await publishOnce(second.db, second.transport, second.delivery.resolver, {});

    expect(result.failed).toBe(0);
    expect(postedTexts(second.transport)[0]).toContain("Done after restart");
    await second.close();
  });
});

describe("outbox writes and unrelated transactions (08 section 8)", () => {
  it("an unrelated transaction rolling back cannot undo a delivered row", async () => {
    const rig = bootstrap(dataDir());
    await acceptRequest(rig, "task-tx");
    await emitDomainEvent(rig, {
      taskId: "task-tx",
      eventId: "evt-tx",
      type: "TaskCompleted",
      payload: { summary: "Delivered" },
    });

    let published: Promise<unknown> | undefined;
    const rollback = rig.repository
      .transaction(async (tx) => {
        await tx.appendTaskEvent({
          taskId: "task-tx",
          eventType: "TaskProgressed",
          idempotencyKey: "event:doomed",
          payload: {},
        });
        // Publish while someone else's BEGIN/COMMIT span is wide open.
        published = publishOnce(rig.db, rig.transport, rig.delivery.resolver, {
          runWrite: (_kind, fn) => rig.queue.enqueue(fn),
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("doomed transaction");
      })
      .catch(() => undefined);

    await rollback;
    await published;
    await rig.queue.drain();

    // The doomed transaction is gone...
    const doomed = rig.db
      .prepare("SELECT COUNT(*) AS n FROM task_events WHERE idempotency_key = 'event:doomed'")
      .get() as { n: number };
    expect(doomed.n).toBe(0);
    // ...and the outbox row it never owned is still marked sent.
    const key = `event:evt-tx:post-thread-message`;
    expect(getByIdempotencyKey(rig.db, key)?.status).toBe("sent");
    expect(postedTexts(rig.transport)[0]).toContain("Delivered");
    await rig.close();
  });
});

describe("a conversation the accepted-request listener never opened", () => {
  it("is reopened by the reconciler, and its notifications then deliver", async () => {
    const dataDir = makeDataDir();
    dirs.push(dataDir);
    const rig = bootstrap(dataDir);

    // Exactly what a crash between "task committed" and "conversation
    // committed" leaves behind: the task row, and nothing else. Registration
    // hangs off an in-process bus and is started with `void`, so nothing
    // retries it — every outbox row of this task would resolve no thread and
    // dead-letter, silently, for the life of the row.
    await rig.repository.createTask({
      taskId: "task-orphan",
      workspaceId: WORKSPACE,
      origin: "cli",
      pipeline: "coding",
      title: "Orphaned request",
      intent: { summary: "Orphaned request", projects: ["grammarxiv"], origin: "cli" },
      temporalWorkflowId: "task/task-orphan",
      now: Date.now(),
    });
    await rig.queue.drain();
    expect(
      (
        rig.db.prepare("SELECT conversation_id FROM tasks WHERE id = ?").get("task-orphan") as {
          conversation_id: string | null;
        }
      ).conversation_id,
    ).toBeNull();

    expect(await rig.delivery.reconcileConversations()).toBe(1);

    await emitDomainEvent(rig, {
      taskId: "task-orphan",
      eventId: "evt-orphan",
      type: "TaskCompleted",
      payload: { summary: "Delivered after repair" },
    });
    await publishOnce(rig.db, rig.transport, rig.delivery.resolver, {
      runWrite: (_kind, fn) => rig.queue.enqueue(fn),
    });
    await rig.queue.drain();
    expect(postedTexts(rig.transport).join("\n")).toContain("Delivered after repair");

    // Idempotent: a second pass has nothing left to repair.
    expect(await rig.delivery.reconcileConversations()).toBe(0);
    await rig.close();
  });
});
