import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChatTransport, InMemoryConversationDirectory } from "@meidoya/chat-core";
import { type MeidoyaDatabase, migrate, migrations, openDatabase } from "@meidoya/store-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { toOutboxIntentInput } from "./intents.js";
import { createDirectoryResolver, publishOnce } from "./publisher.js";
import {
  type OutboxIntentInput,
  backoffDelayMs,
  claimPending,
  enqueueWithTaskUpdate,
  getByIdempotencyKey,
  insertIntents,
  listAll,
  markFailure,
  markSent,
} from "./repository.js";

const NOW = 1_700_000_000_000;

function seed(path = ":memory:") {
  const db = openDatabase(path);
  migrate(db, migrations);
  const t = 1_700_000_000;
  db.prepare(
    "INSERT INTO environments (id, timezone, created_at, updated_at) VALUES ('env1','Asia/Tokyo',?,?)"
  ).run(t, t);
  db.prepare(
    `INSERT INTO workspaces (id, environment_id, kind, display_name, status, policy_json, version, created_at, updated_at)
     VALUES ('ws1','env1','execution','Test','active','{}',0,?,?)`
  ).run(t, t);
  db.prepare(
    "INSERT INTO conversations (id, workspace_id, external_thread_ref, root_message_ref, created_at) VALUES ('conv1','ws1','T1','T1',?)"
  ).run(t);
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, conversation_id, origin, pipeline, title, intent_json, status, temporal_workflow_id, version, created_at, updated_at)
     VALUES ('task1','ws1','conv1','chat','standard','Test','{}','running','wf-1',0,?,?)`
  ).run(t, t);
  return db;
}

function taskRow(db: MeidoyaDatabase) {
  return db.prepare("SELECT status, version FROM tasks WHERE id = 'task1'").get() as {
    status: string;
    version: number;
  };
}

let ids = 0;
const newId = () => `obx_${++ids}`;

function intent(over: Partial<OutboxIntentInput> = {}): OutboxIntentInput {
  return {
    action: "post-thread-message",
    idempotencyKey: "checkpoint:cp_1:1",
    eventId: "evt-1",
    workspaceId: "ws1",
    conversationId: "conv1",
    taskId: "task1",
    payload: { message: { text: "hello" } },
    ...over,
  };
}

beforeEach(() => {
  ids = 0;
});

describe("enqueueWithTaskUpdate (07 section 5)", () => {
  it("commits the task update and the outbox insert together", () => {
    const db = seed();
    enqueueWithTaskUpdate(db, { taskId: "task1", status: "waiting" }, [intent()], {
      now: NOW,
      newId,
    });

    expect(taskRow(db).status).toBe("waiting");
    expect(listAll(db)).toHaveLength(1);
  });

  it("persists NEITHER when the outbox insert fails", () => {
    const db = seed();
    const before = taskRow(db);

    expect(() =>
      enqueueWithTaskUpdate(
        db,
        { taskId: "task1", status: "waiting" },
        // Invalid workspace FK: forces the insert to throw mid-transaction.
        [intent({ workspaceId: "does-not-exist" })],
        { now: NOW, newId }
      )
    ).toThrow();

    expect(taskRow(db)).toEqual(before);
    expect(listAll(db)).toHaveLength(0);
  });

  it("persists NEITHER when the task update does not apply", () => {
    const db = seed();
    expect(() =>
      enqueueWithTaskUpdate(
        db,
        { taskId: "task1", status: "waiting", expectedVersion: 99 },
        [intent()],
        { now: NOW, newId }
      )
    ).toThrow();
    expect(taskRow(db).status).toBe("running");
    expect(listAll(db)).toHaveLength(0);
  });
});

describe("idempotency (08 section 10)", () => {
  it("a duplicate enqueue is a no-op, not an error", () => {
    const db = seed();
    expect(insertIntents(db, [intent()], { now: NOW, newId })).toBe(1);
    expect(insertIntents(db, [intent()], { now: NOW, newId })).toBe(0);
    expect(listAll(db)).toHaveLength(1);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("pending");
  });
});

describe("publisher loop", () => {
  function resolverFor() {
    const dir = new InMemoryConversationDirectory();
    dir.register({
      conversationId: "conv1",
      workspaceId: "ws1",
      thread: { transport: "fake", channelRef: "C1", threadRef: "T1" },
      rootMessage: { transport: "fake", channelRef: "C1", messageRef: "T1", threadRef: "T1" },
    });
    return createDirectoryResolver(dir);
  }

  it("claims pending rows, dispatches and marks them sent", async () => {
    const db = seed();
    insertIntents(
      db,
      [
        intent({ action: "add-reaction", idempotencyKey: "k1", payload: { emoji: { name: "eyes" } } }),
        intent({ idempotencyKey: "k2" }),
      ],
      { now: NOW, newId }
    );

    const transport = new FakeChatTransport();
    const result = await publishOnce(db, transport, resolverFor(), { now: NOW });

    expect(result).toEqual({ claimed: 2, sent: 2, failed: 0, deduplicated: 0, deadLettered: 0 });
    expect(transport.calls.map((c) => c.kind)).toEqual(["add-reaction", "post-thread-message"]);
    expect(listAll(db).every((r) => r.status === "sent")).toBe(true);
  });

  it("respects available_at", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW + 60_000, newId });
    const transport = new FakeChatTransport();
    expect((await publishOnce(db, transport, resolverFor(), { now: NOW })).claimed).toBe(0);
    expect((await publishOnce(db, transport, resolverFor(), { now: NOW + 60_000 })).claimed).toBe(1);
  });

  it("a transport failure reschedules with backoff and NEVER mutates task state", async () => {
    const db = seed();
    enqueueWithTaskUpdate(db, { taskId: "task1", status: "waiting" }, [intent()], {
      now: NOW,
      newId,
    });
    const after = taskRow(db);

    const transport = new FakeChatTransport();
    transport.failNext = true;
    const result = await publishOnce(db, transport, resolverFor(), {
      now: NOW,
      baseDelayMs: 1_000,
    });

    expect(result).toEqual({ claimed: 1, sent: 0, failed: 1, deduplicated: 0, deadLettered: 0 });
    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.status).toBe("pending");
    expect(row?.attempt).toBe(1);
    expect(row?.availableAt).toBe(NOW + 1_000);
    expect(taskRow(db)).toEqual(after);

    // Retry after the backoff window succeeds.
    const retry = await publishOnce(db, transport, resolverFor(), { now: NOW + 1_000 });
    expect(retry.sent).toBe(1);
    expect(taskRow(db)).toEqual(after);
  });

  it("gives up after maxAttempts", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const transport = new FakeChatTransport();
    let now = NOW;
    for (let i = 0; i < 3; i += 1) {
      transport.failNext = true;
      await publishOnce(db, transport, resolverFor(), { now, maxAttempts: 3 });
      now += 60_000;
    }
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("failed");
  });

  it("update-message edits the message posted under the original key", async () => {
    const db = seed();
    const dir = new InMemoryConversationDirectory();
    dir.register({
      conversationId: "conv1",
      workspaceId: "ws1",
      thread: { transport: "fake", channelRef: "C1", threadRef: "T1" },
    });
    const resolver = createDirectoryResolver(dir);
    const transport = new FakeChatTransport();

    insertIntents(db, [intent()], { now: NOW, newId });
    await publishOnce(db, transport, resolver, { now: NOW });

    insertIntents(
      db,
      [
        toOutboxIntentInput({
          action: "update-message",
          idempotencyKey: "checkpoint:cp_1:1:update:evt-2",
          targetIdempotencyKey: "checkpoint:cp_1:1",
          eventId: "evt-2",
          workspaceId: "ws1",
          conversationId: "conv1",
          message: { text: "hello v2" },
        }),
      ],
      { now: NOW, newId }
    );
    await publishOnce(db, transport, resolver, { now: NOW });

    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);
    const edits = transport.callsOfKind("update-message");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.message.text).toBe("hello v2");
  });

  it("claimPending leases rows: invisible while the lease holds, reclaimed after", () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    expect(claimPending(db, { now: NOW, leaseMs: 30_000 })).toHaveLength(1);
    // A concurrent pass must not steal a claim that is still being dispatched...
    expect(claimPending(db, { now: NOW, leaseMs: 30_000 })).toHaveLength(0);
    // ...but a claim nobody ever finished must NOT vanish from the queue.
    expect(claimPending(db, { now: NOW + 30_001, leaseMs: 30_000 })).toHaveLength(1);
  });
});

describe("available_at is a retry time, never a lease expiry", () => {
  it("claiming leaves the retry schedule alone and leases separately", () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const [claimed] = claimPending(db, { now: NOW + 5_000, leaseMs: 30_000 });

    expect(claimed?.availableAt).toBe(NOW);
    expect(claimed?.leaseExpiresAt).toBe(NOW + 35_000);
    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.availableAt).toBe(NOW);
    expect(row?.leaseExpiresAt).toBe(NOW + 35_000);
  });

  it("a LIVE lease is unclaimable; only an expired one is reclaimed", () => {
    // Regression guard for the lease-expiry predicate in claimPending. Delete
    // the `lease_expires_at <= ?` condition (or widen it back to available_at)
    // and the second expectation here claims a row somebody else is still
    // dispatching — which is the duplicate post.
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const [held] = claimPending(db, { now: NOW, leaseMs: 30_000 });
    expect(held).toBeDefined();

    expect(claimPending(db, { now: NOW + 29_999, leaseMs: 30_000 })).toHaveLength(0);
    const [taken] = claimPending(db, { now: NOW + 30_000, leaseMs: 30_000 });
    expect(taken?.claimToken).not.toBe(held?.claimToken);
  });

  it("a pending row rescheduled by markFailure holds no lease at all", () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const [claimed] = claimPending(db, { now: NOW, leaseMs: 30_000 });
    markFailure(db, claimed!, { now: NOW, baseDelayMs: 1_000 });

    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.status).toBe("pending");
    expect(row?.availableAt).toBe(NOW + 1_000);
    expect(row?.leaseExpiresAt).toBeUndefined();
    expect(row?.claimToken).toBeUndefined();
    // Not due yet, and not "leased" either: simply not this pass's business.
    expect(claimPending(db, { now: NOW + 999 })).toHaveLength(0);
    expect(claimPending(db, { now: NOW + 1_000 })).toHaveLength(1);
  });

  it("a SECOND connection to the same database cannot take a live claim", () => {
    const dir = mkdtempSync(join(tmpdir(), "outbox-claim-"));
    const path = join(dir, "meidoya.db");
    const a = seed(path);
    insertIntents(a, [intent()], { now: NOW, newId });
    const [held] = claimPending(a, { now: NOW, leaseMs: 30_000 });

    const b = openDatabase(path);
    try {
      expect(claimPending(b, { now: NOW + 1_000, leaseMs: 30_000 })).toHaveLength(0);
      // ...and it wins the row once the lease is genuinely gone.
      const [taken] = claimPending(b, { now: NOW + 31_000, leaseMs: 30_000 });
      expect(taken?.claimToken).not.toBe(held?.claimToken);
      // The timed-out holder can no longer close the row it lost.
      expect(markSent(a, held!.id, NOW + 32_000, undefined, held?.claimToken)).toBe(false);
    } finally {
      b.close();
      a.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("backoff", () => {
  it("grows exponentially and is capped", () => {
    expect(backoffDelayMs(1, { baseDelayMs: 1_000 })).toBe(1_000);
    expect(backoffDelayMs(2, { baseDelayMs: 1_000 })).toBe(2_000);
    expect(backoffDelayMs(3, { baseDelayMs: 1_000 })).toBe(4_000);
    expect(backoffDelayMs(30, { baseDelayMs: 1_000, maxDelayMs: 10_000 })).toBe(10_000);
  });
});
