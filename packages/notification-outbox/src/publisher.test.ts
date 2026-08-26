import { FakeChatTransport, InMemoryConversationDirectory } from "@meidoya/chat-core";
import { type MeidoyaDatabase, migrate, migrations, openDatabase } from "@meidoya/store-sqlite";
import { describe, expect, it } from "vitest";
import {
  type OutboxWriteRunner,
  createDirectoryResolver,
  publishOnce,
  runPublisherLoop,
} from "./publisher.js";
import {
  type OutboxDeadLetter,
  type OutboxIntentInput,
  claimPending,
  getByIdempotencyKey,
  insertIntents,
  markFailure,
  markSent,
  reclaimStaleClaims,
  recordDelivery,
} from "./repository.js";

const NOW = 1_700_000_000_000;

function seed(): MeidoyaDatabase {
  const db = openDatabase(":memory:");
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
  return db;
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
    payload: { message: { text: "hello" } },
    ...over,
  };
}

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

describe("structured message persistence", () => {
  it("restores rich fields after the outbox JSON round-trip", async () => {
    const db = seed();
    insertIntents(
      db,
      [
        intent({
          payload: {
            message: {
              text: "fallback",
              title: "進行中のタスク",
              summary: "2件です。",
              tone: "success",
              bullets: ["概要"],
              sections: [{ title: "進行中", bullets: ["⚙️ 実行中 — task-1"] }],
              choices: ["承認します"],
              links: [{ label: "詳細", url: "https://example.test/tasks/1" }],
            },
          },
        }),
      ],
      { now: NOW, newId },
    );
    const transport = new FakeChatTransport();

    await publishOnce(db, transport, resolverFor(), { now: NOW });

    expect(transport.callsOfKind("post-thread-message")[0]?.message).toEqual({
      text: "fallback",
      title: "進行中のタスク",
      summary: "2件です。",
      tone: "success",
      bullets: ["概要"],
      sections: [{ title: "進行中", bullets: ["⚙️ 実行中 — task-1"] }],
      choices: ["承認します"],
      links: [{ label: "詳細", url: "https://example.test/tasks/1" }],
    });
  });
});

describe("claim lease (a crashed dispatch is retried, never stranded)", () => {
  it("reclaims a row a killed process left in 'sending' once the lease expires", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });

    // Process A claims the row, then dies before dispatching.
    expect(claimPending(db, { now: NOW, leaseMs: 30_000 })).toHaveLength(1);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sending");

    // Inside the lease the row is nobody else's business.
    expect(claimPending(db, { now: NOW + 29_000, leaseMs: 30_000 })).toHaveLength(0);

    // Past it, the next pass takes it back and actually delivers it.
    const transport = new FakeChatTransport();
    const result = await publishOnce(db, transport, resolverFor(), {
      now: NOW + 31_000,
      leaseMs: 30_000,
    });
    expect(result.sent).toBe(1);
    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sent");
  });

  it("the startup sweep hands back EXPIRED leases only, never a live claim", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    claimPending(db, { now: NOW, leaseMs: 10 * 60_000 });

    // A second daemon starting during a deploy overlap used to hand every
    // in-flight row of the STILL RUNNING daemon back to the queue, and every
    // one of those messages was then posted twice.
    expect(reclaimStaleClaims(db, { now: NOW })).toBe(0);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sending");

    // Past the lease the row really is stranded, and the sweep takes it back.
    expect(reclaimStaleClaims(db, { now: NOW + 10 * 60_000 + 1 })).toBe(1);
    const swept = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(swept?.status).toBe("pending");
    expect(swept?.leaseExpiresAt).toBeUndefined();

    // And the loop performs that sweep on start, so a restart recovers.
    const db2 = seed();
    insertIntents(db2, [intent()], { now: NOW, newId });
    claimPending(db2, { now: NOW, leaseMs: 1_000 });
    const transport = new FakeChatTransport();
    const abort = new AbortController();
    await runPublisherLoop(db2, transport, resolverFor(), {
      now: NOW + 2_000,
      signal: abort.signal,
      sleep: async () => {
        abort.abort();
      },
      intervalMs: 0,
    });
    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);
  });

  it("a second publisher starting does NOT steal a live claim", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    // Daemon A claims the row and is dispatching it (600s lease, well alive).
    const [held] = claimPending(db, { now: NOW, leaseMs: 600_000 });
    expect(held?.claimToken).toBeDefined();

    // Daemon B boots: sweep, then a full pass. Neither may touch A's row.
    const transport = new FakeChatTransport();
    const abort = new AbortController();
    await runPublisherLoop(db, transport, resolverFor(), {
      now: NOW + 1_000,
      signal: abort.signal,
      sleep: async () => {
        abort.abort();
      },
      intervalMs: 0,
    });

    expect(transport.calls).toHaveLength(0);
    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.status).toBe("sending");
    expect(row?.claimToken).toBe(held?.claimToken);
  });
});

describe("no duplicate sends", () => {
  /** A transport whose post hangs until the test releases it. */
  function gatedTransport() {
    let release!: (ref: { transport: "fake"; channelRef: string; messageRef: string }) => void;
    const gate = new Promise<{ transport: "fake"; channelRef: string; messageRef: string }>(
      (resolve) => {
        release = resolve;
      }
    );
    const posts: number[] = [];
    return {
      posts,
      release: () => release({ transport: "fake", channelRef: "C1", messageRef: "M1" }),
      transport: {
        addReaction: async () => undefined,
        removeReaction: async () => undefined,
        postThreadMessage: async () => {
          posts.push(Date.now());
          return gate;
        },
        updateMessage: async () => undefined,
      },
    };
  }

  it("a dispatch that outlives its lease is NOT posted a second time", async () => {
    // The exact shape of the conflation bug: available_at meant "lease expiry"
    // while sending and "retry at" while pending, and one query read both. With
    // leaseMs = 1000 a pass at now + 2000 re-claimed the row that pass one was
    // still inside postThreadMessage for, and the human saw the message twice.
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const gated = gatedTransport();

    const slow = publishOnce(db, gated.transport, resolverFor(), { now: NOW, leaseMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gated.posts).toHaveLength(1);

    // Two seconds later the lease has expired on paper — but the dispatch that
    // holds it is alive, and this process knows it.
    const overlapping = await publishOnce(db, gated.transport, resolverFor(), {
      now: NOW + 2_000,
      leaseMs: 1_000,
    });
    expect(overlapping).toEqual({ claimed: 0, sent: 0, failed: 0, deduplicated: 0, deadLettered: 0 });
    expect(gated.posts).toHaveLength(1);

    gated.release();
    const first = await slow;
    expect(first.sent).toBe(1);
    expect(gated.posts).toHaveLength(1);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sent");
  });

  it("posts once when the post succeeds but recordDelivery throws", async () => {
    // Shutdown shape: the transport took the message, then the host's write
    // queue rejected with "write queue is closed". The generic catch used to
    // treat that as a dispatch failure and reschedule the row -> second post.
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const transport = new FakeChatTransport();
    const closedQueue: OutboxWriteRunner = async (kind, fn) => {
      if (kind === "record-delivery") throw new Error("write queue is closed");
      return fn();
    };

    const first = await publishOnce(db, transport, resolverFor(), {
      now: NOW,
      leaseMs: 1_000,
      runWrite: closedQueue,
    });
    expect(first.sent).toBe(1);
    expect(first.failed).toBe(0);
    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);

    // The row was never rescheduled as a failure...
    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.status).toBe("sending");
    expect(row?.attempt).toBe(0);

    // ...and when it is eventually reclaimed it is recognised as delivered.
    const retry = await publishOnce(db, transport, resolverFor(), {
      now: NOW + 2_000,
      leaseMs: 1_000,
    });
    expect(retry.deduplicated).toBe(1);
    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sent");
  });

  it("does NOT post twice when the post succeeds but markSent throws", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const transport = new FakeChatTransport();

    // The delivery receipt lands; the status write does not.
    const failingMarkSent: OutboxWriteRunner = async (kind, fn) => {
      if (kind === "mark-sent") throw new Error("disk full");
      return fn();
    };
    const first = await publishOnce(db, transport, resolverFor(), {
      now: NOW,
      runWrite: failingMarkSent,
    });
    // The message exists, so this is NOT a failed row: a bookkeeping error
    // after a successful dispatch must never be reported (or handled) as a
    // dispatch failure, because that is what rescheduled it into a second post.
    expect(first.sent).toBe(1);
    expect(first.failed).toBe(0);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.attempt).toBe(0);
    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);

    // Whatever the retry path does, the human must not see the message twice.
    const retry = await publishOnce(db, transport, resolverFor(), { now: NOW + 60_000 });
    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);
    expect(retry.deduplicated).toBe(1);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sent");
  });

  it("a reclaimed row that was already delivered is not re-dispatched", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const transport = new FakeChatTransport();
    const dropStatusWrites: OutboxWriteRunner = async (kind, fn) => {
      if (kind === "mark-sent" || kind === "mark-failure") return undefined as never;
      return fn();
    };
    await publishOnce(db, transport, resolverFor(), { now: NOW, runWrite: dropStatusWrites });
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sending");

    await publishOnce(db, transport, resolverFor(), { now: NOW + 120_000 });
    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sent");
  });
});

describe("claim exclusivity", () => {
  it("two publishers claiming the same row: exactly one wins", () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });

    // The race window is between the SELECT that finds the row and the UPDATE
    // that takes it. newToken() runs exactly in that window, so a competing
    // claim committed there is deterministic rather than timing-dependent.
    let raced = false;
    const winners: string[] = [];
    const a = claimPending(db, {
      now: NOW,
      leaseMs: 30_000,
      newToken: () => {
        if (!raced) {
          raced = true;
          for (const r of claimPending(db, { now: NOW, leaseMs: 30_000 })) {
            winners.push(`B:${r.id}`);
          }
        }
        return "token-a";
      },
    });
    for (const r of a) winners.push(`A:${r.id}`);

    const rowId = getByIdempotencyKey(db, "checkpoint:cp_1:1")?.id;
    expect(winners).toEqual([`B:${String(rowId)}`]);
    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.status).toBe("sending");
    expect(row?.claimToken).not.toBe("token-a");
  });

  it("a stale worker cannot mark a row it no longer owns as sent", () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const [stale] = claimPending(db, { now: NOW, leaseMs: 1_000 });
    const [current] = claimPending(db, { now: NOW + 2_000, leaseMs: 30_000 });
    expect(current?.claimToken).not.toBe(stale?.claimToken);

    // The timed-out holder comes back from a very slow transport call.
    expect(markSent(db, stale!.id, NOW + 3_000, { at: NOW + 3_000 }, stale?.claimToken)).toBe(
      false
    );
    expect(markFailure(db, stale!, { now: NOW + 3_000 }).applied).toBe(false);

    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.status).toBe("sending");
    expect(row?.claimToken).toBe(current?.claimToken);

    // The rightful holder still can.
    expect(markSent(db, current!.id, NOW + 4_000, undefined, current?.claimToken)).toBe(true);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sent");
  });
});

describe("poisoned rows dead-letter (an unbounded retry loop is a duplicate-send loop)", () => {
  it("every reclaim counts as an attempt, so maxAttempts is actually reached", () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });

    // A worker that dies mid-dispatch every single time: claim, never finish.
    // The reclaim used to leave `attempt` at 0 forever, so the dead-letter
    // threshold was unreachable and the row was re-dispatched without bound.
    const attempts: number[] = [];
    let now = NOW;
    for (let i = 0; i < 12; i += 1) {
      const claimed = claimPending(db, { now, leaseMs: 1_000, maxAttempts: 5 });
      if (claimed.length === 0) break;
      attempts.push(claimed[0]!.attempt);
      now += 2_000;
    }

    expect(attempts).toEqual([0, 1, 2, 3, 4]);
    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.status).toBe("failed");
    expect(row?.attempt).toBe(5);
    expect(claimPending(db, { now: now + 60_000, maxAttempts: 5 })).toHaveLength(0);
  });

  it("a row that WAS delivered is never dead-lettered by the reclaim path", () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const rowId = getByIdempotencyKey(db, "checkpoint:cp_1:1")!.id;
    let now = NOW;
    for (let i = 0; i < 3; i += 1) {
      claimPending(db, { now, leaseMs: 1_000, maxAttempts: 3 });
      now += 2_000;
    }
    // The receipt says the message exists; the row still owes a status write,
    // and losing it to the dead-letter would hide a delivered notification.
    recordDelivery(db, rowId, { at: NOW });
    const claimed = claimPending(db, { now: now + 2_000, leaseMs: 1_000, maxAttempts: 3 });
    expect(claimed).toHaveLength(1);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sending");
  });
});

describe("the publisher loop survives a transient failure", () => {
  it("a claim error is logged and the NEXT pass still delivers", async () => {
    // One "database is locked" from a WAL snapshot upgrade used to escape
    // publishOnce, escape the while loop, and be swallowed upstream: no
    // notification was ever delivered again, with zero output.
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const transport = new FakeChatTransport();

    let claims = 0;
    const flakyClaim: OutboxWriteRunner = async (kind, fn) => {
      if (kind === "claim") {
        claims += 1;
        if (claims === 1) throw new Error("database is locked");
      }
      return fn();
    };

    const errors: unknown[] = [];
    const delays: number[] = [];
    const abort = new AbortController();
    await runPublisherLoop(db, transport, resolverFor(), {
      now: NOW,
      sweepOnStart: false,
      intervalMs: 10,
      runWrite: flakyClaim,
      onError: (error) => errors.push(error),
      sleep: async (ms) => {
        delays.push(ms);
        if (transport.callsOfKind("post-thread-message").length > 0) abort.abort();
      },
      signal: abort.signal,
    });

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("database is locked");
    // Backed off after the failure rather than hot-looping.
    expect(delays[0]).toBeGreaterThan(10);
    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sent");
  });
});

describe("rate-limit backoff (07 section 5: the outbox owns retry)", () => {
  class RateLimited extends Error {
    readonly retryAfterMs = 45_000;
  }

  it("schedules the retry no earlier than retryAfterMs", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const transport = {
      addReaction: async () => undefined,
      removeReaction: async () => undefined,
      postThreadMessage: async () => {
        throw new RateLimited("rate limited");
      },
      updateMessage: async () => undefined,
    };

    await publishOnce(db, transport, resolverFor(), { now: NOW, baseDelayMs: 1_000 });

    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.status).toBe("pending");
    expect(row?.availableAt).toBe(NOW + 45_000);
    // Still unavailable a second before the platform said so.
    expect(claimPending(db, { now: NOW + 44_999 })).toHaveLength(0);
  });

  it("keeps exponential backoff when it is longer than the hint", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const transport = {
      addReaction: async () => undefined,
      removeReaction: async () => undefined,
      postThreadMessage: async () => {
        throw Object.assign(new Error("slow down"), { retryAfterMs: 100 });
      },
      updateMessage: async () => undefined,
    };
    await publishOnce(db, transport, resolverFor(), { now: NOW, baseDelayMs: 5_000 });
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.availableAt).toBe(NOW + 5_000);
  });
});

describe("a transport verdict of not-retryable is honoured", () => {
  function throwingTransport(error: unknown) {
    return {
      addReaction: async () => undefined,
      removeReaction: async () => undefined,
      postThreadMessage: async (): Promise<never> => {
        throw error;
      },
      updateMessage: async () => undefined,
    };
  }

  it("dead-letters immediately when the transport says retrying cannot help", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    // What SlackPlatformClient raises for `channel_not_found` / a 403.
    const terminal = Object.assign(new Error("channel_not_found"), {
      retryable: false,
      status: 404,
    });

    const result = await publishOnce(db, throwingTransport(terminal), resolverFor(), {
      now: NOW,
      maxAttempts: 5,
    });

    expect(result.failed).toBe(1);
    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.status).toBe("failed");
    // Not merely rescheduled: no later pass may pick it up again.
    expect(claimPending(db, { now: NOW + 365 * 86_400_000, maxAttempts: 5 })).toHaveLength(0);
  });

  it("still retries a retryable failure, and one carrying no verdict at all", async () => {
    for (const error of [
      Object.assign(new Error("slack 503"), { retryable: true, status: 503 }),
      new Error("unresolved thread"),
    ]) {
      const db = seed();
      insertIntents(db, [intent()], { now: NOW, newId });
      await publishOnce(db, throwingTransport(error), resolverFor(), {
        now: NOW,
        baseDelayMs: 1_000,
        maxAttempts: 5,
      });
      expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("pending");
    }
  });

  it("a terminal failure still cannot dead-letter a row this process already delivered", async () => {
    // The dedup branch runs before dispatch, so the receipt still wins.
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const rowId = getByIdempotencyKey(db, "checkpoint:cp_1:1")!.id;
    recordDelivery(db, rowId, { at: NOW });
    const terminal = Object.assign(new Error("invalid_auth"), { retryable: false });

    const result = await publishOnce(db, throwingTransport(terminal), resolverFor(), {
      now: NOW,
    });
    expect(result.deduplicated).toBe(1);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sent");
  });
});

describe("a notification the outbox gives up on is never silent", () => {
  function throwing(error: unknown) {
    return {
      addReaction: async () => undefined,
      removeReaction: async () => undefined,
      postThreadMessage: async (): Promise<never> => {
        throw error;
      },
      updateMessage: async () => undefined,
    };
  }

  it("reports every dispatch dead-letter, terminal and budget-exhausted alike", async () => {
    // A token rotation dead-lettered a whole backlog at attempt 1 and logged
    // nothing: the notifications were gone and nobody could tell.
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const seen: OutboxDeadLetter[] = [];
    const terminal = Object.assign(new Error("channel_not_found"), { retryable: false });

    const result = await publishOnce(db, throwing(terminal), resolverFor(), {
      now: NOW,
      maxAttempts: 5,
      onDeadLetter: (event) => seen.push(event),
    });

    expect(result.deadLettered).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      idempotencyKey: "checkpoint:cp_1:1",
      workspaceId: "ws1",
      action: "post-thread-message",
      origin: "dispatch",
      reason: "terminal",
      attempt: 1,
    });
    expect((seen[0]?.error as Error).message).toBe("channel_not_found");

    // The other give-up path: the attempt budget simply runs out.
    const db2 = seed();
    insertIntents(db2, [intent()], { now: NOW, newId });
    const exhausted: OutboxDeadLetter[] = [];
    let now = NOW;
    for (let i = 0; i < 3; i += 1) {
      await publishOnce(db2, throwing(new Error("network reset")), resolverFor(), {
        now,
        maxAttempts: 3,
        baseDelayMs: 1,
        onDeadLetter: (event) => exhausted.push(event),
      });
      now += 60_000;
    }
    expect(getByIdempotencyKey(db2, "checkpoint:cp_1:1")?.status).toBe("failed");
    expect(exhausted.map((e) => e.reason)).toEqual(["attempts-exhausted"]);
    expect(exhausted[0]?.origin).toBe("dispatch");
  });

  it("does NOT report a mere reschedule as a dead letter", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const seen: OutboxDeadLetter[] = [];
    const result = await publishOnce(db, throwing(new Error("network reset")), resolverFor(), {
      now: NOW,
      maxAttempts: 5,
      onDeadLetter: (event) => seen.push(event),
    });
    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(seen).toEqual([]);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("pending");
  });

  it("reports the reclaim and the sweep dead-letters too", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const seen: OutboxDeadLetter[] = [];
    let now = NOW;
    // A worker that dies mid-dispatch every time: the claim path gives up.
    for (let i = 0; i < 6; i += 1) {
      claimPending(db, {
        now,
        leaseMs: 1_000,
        maxAttempts: 3,
        onDeadLetter: (event) => seen.push(event),
      });
      now += 2_000;
    }
    expect(seen.map((e) => e.origin)).toEqual(["reclaim"]);
    expect(seen[0]).toMatchObject({ reason: "attempts-exhausted", attempt: 3 });

    // And the startup sweep, which bumps the same counter.
    const db2 = seed();
    insertIntents(db2, [intent()], { now: NOW, newId });
    const swept: OutboxDeadLetter[] = [];
    let t = NOW;
    for (let i = 0; i < 6; i += 1) {
      claimPending(db2, { now: t, leaseMs: 1_000, maxAttempts: 99 });
      reclaimStaleClaims(db2, {
        now: t + 2_000,
        maxAttempts: 3,
        onDeadLetter: (event) => swept.push(event),
      });
      t += 10_000;
    }
    expect(swept.map((e) => e.origin)).toEqual(["sweep"]);
    expect(getByIdempotencyKey(db2, "checkpoint:cp_1:1")?.status).toBe("failed");
  });

  it("the default sink writes to console.error rather than dropping the row", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const lines: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => lines.push(args[0]);
    try {
      await publishOnce(
        db,
        throwing(Object.assign(new Error("invalid_blocks"), { retryable: false })),
        resolverFor(),
        { now: NOW }
      );
    } finally {
      console.error = original;
    }
    expect(lines).toHaveLength(1);
    expect(String(lines[0])).toContain("DEAD-LETTER");
    expect(String(lines[0])).toContain("checkpoint:cp_1:1");
  });
});

describe("the two dead-letter budgets never diverge", () => {
  it("publishOnce forwards maxAttempts to the claim, so the reclaim budget matches", async () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    // Drive the row to attempt 2 while `sending` with an expired lease. The
    // claim's own budget is what must stop it here.
    let now = NOW;
    for (let i = 0; i < 3; i += 1) {
      claimPending(db, { now, leaseMs: 1_000, maxAttempts: 99 });
      now += 2_000;
    }
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.attempt).toBe(2);

    const transport = new FakeChatTransport();
    const result = await publishOnce(db, transport, resolverFor(), {
      now: now + 2_000,
      leaseMs: 1_000,
      maxAttempts: 3,
    });

    // Not claimed, not dispatched, dead-lettered by the claim at attempt 3.
    expect(result.claimed).toBe(0);
    expect(transport.calls).toHaveLength(0);
    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.status).toBe("failed");
    expect(row?.attempt).toBe(3);
  });

  it("the startup sweep respects the budget instead of granting one extra dispatch", async () => {
    // The sweep bumped `attempt` with no budget check, so a stranded row got
    // one dispatch BEYOND maxAttempts on every restart.
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    let now = NOW;
    for (let i = 0; i < 3; i += 1) {
      claimPending(db, { now, leaseMs: 1_000, maxAttempts: 99 });
      now += 2_000;
    }
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.attempt).toBe(2);

    expect(reclaimStaleClaims(db, { now: now + 2_000, maxAttempts: 3 })).toBe(0);
    const row = getByIdempotencyKey(db, "checkpoint:cp_1:1");
    expect(row?.status).toBe("failed");
    expect(row?.attempt).toBe(3);
    expect(claimPending(db, { now: now + 86_400_000, maxAttempts: 3 })).toHaveLength(0);
  });

  it("the sweep still hands back a row with budget left, and never one already delivered", () => {
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    claimPending(db, { now: NOW, leaseMs: 1_000, maxAttempts: 99 });
    expect(reclaimStaleClaims(db, { now: NOW + 2_000, maxAttempts: 3 })).toBe(1);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("pending");

    // A delivered row owes only a status write; giving up on it would hide a
    // notification the human has already seen.
    const db2 = seed();
    insertIntents(db2, [intent()], { now: NOW, newId });
    const rowId = getByIdempotencyKey(db2, "checkpoint:cp_1:1")!.id;
    let now = NOW;
    for (let i = 0; i < 3; i += 1) {
      claimPending(db2, { now, leaseMs: 1_000, maxAttempts: 99 });
      now += 2_000;
    }
    recordDelivery(db2, rowId, { at: NOW });
    expect(reclaimStaleClaims(db2, { now: now + 2_000, maxAttempts: 3 })).toBe(1);
    expect(getByIdempotencyKey(db2, "checkpoint:cp_1:1")?.status).toBe("pending");
  });
});

describe("a resolver failure after a successful post", () => {
  it("does not re-post the message", async () => {
    // `onPosted` used to be awaited INSIDE dispatch, so a resolver that
    // rejected after the transport had taken the message was indistinguishable
    // from "nothing reached the platform": the row was rescheduled and the
    // human saw the same message twice.
    const db = seed();
    insertIntents(db, [intent()], { now: NOW, newId });
    const transport = new FakeChatTransport();
    const base = resolverFor();
    const resolver = {
      ...base,
      onPosted: async () => {
        throw new Error("posted-index write failed");
      },
    };

    const first = await publishOnce(db, transport, resolver, { now: NOW, leaseMs: 1_000 });
    expect(first.sent).toBe(1);
    expect(first.failed).toBe(0);
    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);

    // Whatever the row's bookkeeping state, a later pass must not post again.
    await publishOnce(db, transport, resolver, { now: NOW + 120_000, leaseMs: 1_000 });
    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);
    expect(
      transport.callsOfKind("post-thread-message").map((c) => c.message.text)
    ).toEqual(["hello"]);
    expect(getByIdempotencyKey(db, "checkpoint:cp_1:1")?.status).toBe("sent");
  });
});

describe("update-message across a restart", () => {
  it("edits the original message using the durable delivery receipt", async () => {
    const db = seed();
    const transport = new FakeChatTransport();
    insertIntents(db, [intent()], { now: NOW, newId });
    await publishOnce(db, transport, resolverFor(), { now: NOW });

    insertIntents(
      db,
      [
        intent({
          action: "update-message",
          idempotencyKey: "checkpoint:cp_1:1:update:evt-2",
          eventId: "evt-2",
          payload: {
            message: { text: "hello v2" },
            targetIdempotencyKey: "checkpoint:cp_1:1",
          },
        }),
      ],
      { now: NOW, newId }
    );

    // A fresh resolver: exactly what a restarted daemon has (empty in-memory map).
    await publishOnce(db, transport, resolverFor(), { now: NOW });
    const edits = transport.callsOfKind("update-message");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.message.text).toBe("hello v2");
    expect(transport.callsOfKind("post-thread-message")).toHaveLength(1);
  });
});

describe("update-message across the workspace boundary", () => {
  /** A second tenant with its own conversation, on the same database. */
  function seedSecondWorkspace(db: MeidoyaDatabase): void {
    const t = 1_700_000_000;
    db.prepare(
      `INSERT INTO workspaces (id, environment_id, kind, display_name, status, policy_json, version, created_at, updated_at)
       VALUES ('ws2','env1','execution','Other','active','{}',0,?,?)`
    ).run(t, t);
    db.prepare(
      "INSERT INTO conversations (id, workspace_id, external_thread_ref, root_message_ref, created_at) VALUES ('conv2','ws2','T2','T2',?)"
    ).run(t);
  }

  it("refuses to edit a message another workspace's row posted", async () => {
    const db = seed();
    seedSecondWorkspace(db);
    const transport = new FakeChatTransport();

    // ws1 posts. Its idempotency key is now the durable name of a real message
    // in ws1's channel.
    insertIntents(db, [intent()], { now: NOW, newId });
    await publishOnce(db, transport, resolverFor(), { now: NOW });

    // ws2 enqueues an edit naming ws1's key. `idempotency_key` is globally
    // UNIQUE, so that key names exactly one row across every tenant, and
    // `targetIdempotencyKey` arrives in the PAYLOAD — the one place a value the
    // control plane did not choose can reach. The edit path never consults the
    // conversation resolver, so the daemon's workspace gate over conversations
    // cannot see this at all: an edit addresses a MESSAGE, not a thread.
    insertIntents(
      db,
      [
        intent({
          workspaceId: "ws2",
          conversationId: "conv2",
          action: "update-message",
          idempotencyKey: "ws2:steals:1",
          eventId: "evt-9",
          payload: {
            message: { text: "rewritten by ws2" },
            targetIdempotencyKey: "checkpoint:cp_1:1",
          },
        }),
      ],
      { now: NOW, newId }
    );

    const result = await publishOnce(db, transport, resolverFor(), { now: NOW });
    expect(transport.callsOfKind("update-message")).toEqual([]);
    expect(result.failed).toBe(1);
    expect(getByIdempotencyKey(db, "ws2:steals:1")?.status).not.toBe("sent");

    // ws1's own edit of its own message still lands, so the gate is a boundary
    // and not a wall.
    insertIntents(
      db,
      [
        intent({
          action: "update-message",
          idempotencyKey: "checkpoint:cp_1:1:update:evt-2",
          eventId: "evt-2",
          payload: {
            message: { text: "hello v2" },
            targetIdempotencyKey: "checkpoint:cp_1:1",
          },
        }),
      ],
      { now: NOW, newId }
    );
    await publishOnce(db, transport, resolverFor(), { now: NOW + 1 });
    expect(transport.callsOfKind("update-message").map((c) => c.message.text)).toEqual([
      "hello v2",
    ]);
  });
});
