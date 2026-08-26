import { rmSync } from "node:fs";
import { FakeChatTransport } from "@meidoya/chat-core";
import { listAll, publishOnce } from "@meidoya/notification-outbox";
import { migrate, migrations, openDatabase, type MeidoyaDatabase } from "@meidoya/store-sqlite";
import type {
  ActivityDependencies,
  Activities,
  CompleteTaskInput,
} from "@meidoya/workflows-temporal";
import { createActivities } from "@meidoya/workflows-temporal";
import { afterEach, describe, expect, it } from "vitest";
import { createChatDeliveryWiring, createChatGateway } from "./chat-gateway.js";
import { parseControlPlaneConfig, resolveControlPlaneConfig } from "./config.js";
import { ControlEventBus } from "./events.js";
import { createInteractionPolicyPort } from "./ports.js";
import { SqliteTaskRepository, seedFromConfig } from "./repository.js";
import { makeDataDir, testConfigYaml } from "./testing/harness.js";
import { SerialWriteQueue } from "./write-queue.js";

/**
 * THE ONE MESSAGE THE QUIET-UX DESIGN EXISTS TO DELIVER (07 section 1, 05
 * section 10).
 *
 * `completeTask` is the only producer of `TaskCompleted`, and its outbox rows
 * are enqueued inside the task engine's terminal transaction, where no caller
 * can thread anything onto them afterwards. So the conversation the request
 * arrived on has exactly one way in: on the event the activity builds. It used
 * to be dropped there — declared on `CompleteTaskInput`, passed by the
 * workflow, never read — and the resolver could not recover it either (the
 * engine's task event is keyed `task:<id>:completed`, not `event:<eventId>`,
 * and the outbox payload's `taskId` is not persisted), so EVERY completion
 * notification failed to resolve a thread and dead-lettered.
 *
 * This runs the real activity over a real SQLite database, the real interaction
 * policy port, the real conversation resolver and the real outbox publisher,
 * and asserts the operator's summary ARRIVES at a transport. Drop
 * `conversationId` from the event payload in `activities.completeTask` and
 * every expectation below goes red.
 */

const WORKSPACE = "work-grammarxiv";
const TASK_ID = "task-complete-1";

type Rig = {
  db: MeidoyaDatabase;
  queue: SerialWriteQueue;
  repository: SqliteTaskRepository;
  transport: FakeChatTransport;
  events: ControlEventBus;
  delivery: NonNullable<ReturnType<typeof createChatDeliveryWiring>>;
  activities: Activities;
  close(): Promise<void>;
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every dependency this scenario never reaches refuses loudly rather than lying. */
function unusedDeps(): Omit<
  ActivityDependencies,
  "repository" | "interactionPolicy" | "clock" | "ids"
> {
  const refuse = (name: string) => (): never => {
    throw new Error(`${name} is not part of this scenario`);
  };
  return {
    agents: { invoke: refuse("agents.invoke") },
    checkpointPolicy: { evaluate: refuse("checkpointPolicy.evaluate") },
    budget: {
      charge: refuse("budget.charge"),
      snapshot: refuse("budget.snapshot"),
      extendOnce: refuse("budget.extendOnce"),
    },
    commands: { run: refuse("commands.run") },
    artifacts: { exists: refuse("artifacts.exists") },
    prompts: {
      planning: refuse("prompts.planning"),
      worker: refuse("prompts.worker"),
      review: refuse("prompts.review"),
      managerDecision: refuse("prompts.managerDecision"),
      maidAssessment: refuse("prompts.maidAssessment"),
    },
    policies: { load: refuse("policies.load") },
    delegations: { create: refuse("delegations.create") },
    scheduledResults: { compare: refuse("scheduledResults.compare") },
    parse: {
      maidDecision: refuse("parse.maidDecision"),
      plan: refuse("parse.plan"),
      workerResult: refuse("parse.workerResult"),
      reviewFindings: refuse("parse.reviewFindings"),
      managerDecision: refuse("parse.managerDecision"),
    },
  };
}

function bootstrap(): Rig {
  const dataDir = makeDataDir();
  dirs.push(dataDir);
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

  const activities = createActivities({
    ...unusedDeps(),
    repository,
    interactionPolicy: createInteractionPolicyPort({ events }),
    clock: { now: () => 1_700_000_000_000 },
    ids: { next: (prefix) => `${prefix}-1` },
  });

  return {
    db,
    queue,
    repository,
    transport,
    events,
    delivery,
    activities,
    async close() {
      delivery.stop();
      await queue.close();
      db.close();
    },
  };
}

/** What `ControlPlaneService.createTask` does: create the task, announce it. */
async function acceptRequest(rig: Rig): Promise<void> {
  await rig.repository.createTask({
    taskId: TASK_ID,
    workspaceId: WORKSPACE,
    origin: "cli",
    pipeline: "coding",
    title: "Fix the parser",
    intent: { summary: "Fix the parser", projects: ["grammarxiv"], origin: "cli" },
    temporalWorkflowId: `task/${TASK_ID}`,
    now: 1_700_000_000_000,
  });
  rig.events.publish({
    workspaceId: WORKSPACE,
    taskId: TASK_ID,
    type: "RequestAccepted",
    at: 1_700_000_000_000,
  });
  // The delivery wiring registers the conversation asynchronously.
  await rig.queue.drain();
  for (const stepKey of ["plan", "implement", "verify", "review"]) {
    await rig.repository.upsertStep({
      taskId: TASK_ID,
      stepKey,
      stepKind: stepKey,
      status: "succeeded",
      visitCount: 1,
      attemptCount: 1,
    });
  }
}

function completionInput(conversationId?: string): CompleteTaskInput {
  return {
    taskId: TASK_ID,
    workspaceId: WORKSPACE,
    pipeline: "coding",
    expectedVersion: 0,
    eventId: "evt-completed-1",
    summary: "Fixed the parser",
    verificationRequired: true,
    verification: {
      status: "passed",
      groups: [],
      missingArtifacts: [],
      artifacts: [],
      evidence: [],
    },
    reviewGateSatisfied: true,
    requiredArtifactPaths: [],
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

describe("a completed task announces its own completion", () => {
  it("delivers the completion summary to the conversation the request arrived on", async () => {
    const rig = bootstrap();
    await acceptRequest(rig);

    const completed = await rig.activities.completeTask(completionInput(`conv-${TASK_ID}`));
    expect(completed.status).toBe("completed");

    // The row the activity produced carries the conversation. This is the field
    // the activity used to ignore; without it the resolver has nothing to work
    // with and the publisher below dead-letters the row.
    const rows = listAll(rig.db);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.conversationId)).toEqual(rows.map(() => `conv-${TASK_ID}`));

    const result = await publishOnce(rig.db, rig.transport, rig.delivery.resolver, {
      runWrite: (_kind, fn) => rig.queue.enqueue(fn),
    });
    expect(result.failed).toBe(0);
    expect(result.sent).toBe(rows.length);

    const posted = rig.transport.callsOfKind("post-thread-message");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.message.text).toContain("✅ タスク「Fix the parser」が完了しました");
    expect(posted[0]?.message.text).toContain("Fixed the parser");
    expect(posted[0]?.message.text).not.toContain(TASK_ID);
    expect(posted[0]?.ref.threadRef).toBe(TASK_ID);
    expect(listAll(rig.db).every((row) => row.status === "sent")).toBe(true);

    await rig.close();
  });

  it("dead-letters nothing: a completion without a conversation still never posts", async () => {
    // The mirror image, so the test above cannot pass by delivering everything
    // to everyone: a completion that genuinely has no conversation resolves to
    // no thread and reaches no transport.
    const rig = bootstrap();
    await acceptRequest(rig);
    rig.delivery.stop();

    const completed = await rig.activities.completeTask(completionInput());
    expect(completed.status).toBe("completed");
    expect(listAll(rig.db).map((row) => row.conversationId)).not.toContain(`conv-${TASK_ID}`);

    await rig.close();
  });
});
