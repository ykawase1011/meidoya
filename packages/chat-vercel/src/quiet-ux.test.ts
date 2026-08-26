import { InMemoryConversationDirectory } from "@meidoya/chat-core";
import type { DomainEvent, DomainEventType } from "@meidoya/domain";
import { DEFAULT_INTERACTION_CONFIG, decideOutboxIntents } from "@meidoya/interaction-policy";
import {
  createDirectoryResolver,
  insertIntents,
  publishOnce,
  toOutboxIntentInput,
} from "@meidoya/notification-outbox";
import { type MeidoyaDatabase, migrate, migrations, openDatabase } from "@meidoya/store-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { FakePlatformClient } from "./fake-platform-client.js";
import { SlackTransport } from "./slack/transport.js";

const CHANNEL = "C_GRAMMARXIV";
const ROOT_TS = "1700000000.000100";
const NOW = 1_700_000_000_000;

function seedDb(): MeidoyaDatabase {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  const t = 1_700_000_000;
  db.prepare(
    "INSERT INTO environments (id, timezone, created_at, updated_at) VALUES ('env1','Asia/Tokyo',?,?)"
  ).run(t, t);
  db.prepare(
    `INSERT INTO workspaces (id, environment_id, kind, display_name, status, policy_json, version, created_at, updated_at)
     VALUES ('work-grammarxiv','env1','execution','GrammarXiv','active','{}',0,?,?)`
  ).run(t, t);
  db.prepare(
    "INSERT INTO conversations (id, workspace_id, external_thread_ref, root_message_ref, created_at) VALUES ('conv1','work-grammarxiv',?,?,?)"
  ).run(ROOT_TS, ROOT_TS, t);
  return db;
}

function directory(): InMemoryConversationDirectory {
  const dir = new InMemoryConversationDirectory();
  dir.register({
    conversationId: "conv1",
    workspaceId: "work-grammarxiv",
    thread: { transport: "slack", channelRef: CHANNEL, threadRef: ROOT_TS },
    rootMessage: { transport: "slack", channelRef: CHANNEL, messageRef: ROOT_TS },
  });
  return dir;
}

let sequence = 0;
function event(type: DomainEventType, payload: Record<string, unknown> = {}): DomainEvent {
  sequence += 1;
  return {
    id: `evt_${sequence}`,
    taskId: "task_123",
    workspaceId: "work-grammarxiv",
    type,
    payload: { conversationId: "conv1", ...payload },
    createdAt: NOW + sequence,
  };
}

describe("quiet UX conformance (Phase 4 DoD)", () => {
  let db: MeidoyaDatabase;
  let client: FakePlatformClient;
  let transport: SlackTransport;
  let resolver: ReturnType<typeof createDirectoryResolver>;

  beforeEach(() => {
    sequence = 0;
    db = seedDb();
    client = new FakePlatformClient("slack");
    transport = new SlackTransport(client);
    resolver = createDirectoryResolver(directory());
  });

  async function drive(events: readonly DomainEvent[], emitted: string[]): Promise<void> {
    for (const e of events) {
      const intents = decideOutboxIntents(e, DEFAULT_INTERACTION_CONFIG, {
        emittedIdempotencyKeys: emitted,
      });
      for (const intent of intents) emitted.push(intent.idempotencyKey);
      insertIntents(db, intents.map(toOutboxIntentInput), { now: NOW });
    }
    const result = await publishOnce(db, transport, resolver, { now: NOW, limit: 100 });
    expect(result.failed).toBe(0);
  }

  it("posts only 👀 after acceptance and no message until a gate or completion", async () => {
    const emitted: string[] = [];

    await drive(
      [
        event("RequestAccepted"),
        event("TaskStarted"),
        event("TaskProgressed", { step: "research" }),
        event("TaskProgressed", { step: "implement" }),
        event("TaskProgressed", { step: "verify" }),
      ],
      emitted
    );

    expect(client.callsOfKind("add-reaction")).toHaveLength(1);
    expect(client.callsOfKind("add-reaction")[0]?.emoji).toEqual({ value: "eyes" });
    expect(client.callsOfKind("add-reaction")[0]?.target).toEqual({
      channelRef: CHANNEL,
      messageRef: ROOT_TS,
    });
    expect(client.callsOfKind("send")).toHaveLength(0);
    expect(client.callsOfKind("edit")).toHaveLength(0);

    await drive(
      [
        event("WaitingPlanApproval", {
          checkpointId: "cp_456",
          checkpointVersion: 1,
          title: "Refactor the parser",
          choices: ["Approve", "Add instruction", "Cancel"],
        }),
      ],
      emitted
    );

    expect(client.callsOfKind("send")).toHaveLength(1);
    const posted = client.callsOfKind("send")[0];
    expect(posted?.message.threadRef).toBe(ROOT_TS);
    expect(String(posted?.message.body["text"])).toContain("📝 Refactor the parser");
    expect(posted?.message.body["blocks"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "header",
          text: expect.objectContaining({ text: "Refactor the parser" }),
        }),
      ]),
    );

    await drive([event("TaskProgressed", { step: "apply" })], emitted);
    expect(client.callsOfKind("send")).toHaveLength(1);

    await drive([event("TaskCompleted", { summary: "Parser refactored." })], emitted);
    expect(client.callsOfKind("send")).toHaveLength(2);
    expect(client.callsOfKind("add-reaction").map((c) => c.emoji.value)).toEqual([
      "eyes",
      "memo",
      "white_check_mark",
    ]);
    expect(client.callsOfKind("remove-reaction").map((c) => c.emoji.value)).toContain("eyes");
  });

  it("edits the existing message for a re-emitted checkpoint version", async () => {
    const emitted: string[] = [];
    const cp = {
      checkpointId: "cp_456",
      checkpointVersion: 1,
      title: "Refactor the parser",
    };
    await drive([event("WaitingPlanApproval", cp)], emitted);
    await drive([event("WaitingPlanApproval", { ...cp, summary: "updated" })], emitted);

    expect(client.callsOfKind("send")).toHaveLength(1);
    expect(client.callsOfKind("edit")).toHaveLength(1);
    expect(client.callsOfKind("edit")[0]?.target).toEqual({
      channelRef: CHANNEL,
      messageRef: "slack-msg-1",
    });
  });

  it("never posts on its own initiative when inbound traffic arrives", async () => {
    const stream = await client.openEventStream(async () => {
      /* the control plane, not the transport, decides what happens next */
    });
    for (const text of ["hey bot", "status?", "post an update please", "@meidoya say hi"]) {
      await client.emit({
        transport: "slack",
        accountRef: "T_PERSONAL",
        channelRef: CHANNEL,
        messageRef: "1700000100.000200",
        threadRef: ROOT_TS,
        authorRef: "U_HUMAN",
        text,
        receivedAt: NOW,
      });
    }
    await stream.close();
    expect(client.calls).toHaveLength(0);
  });

  it("exposes no outbound entry point beyond the four ChatTransport methods", () => {
    const own = Object.getOwnPropertyNames(
      Object.getPrototypeOf(transport) as object
    ).filter((n) => n !== "constructor");
    const inherited = Object.getOwnPropertyNames(
      Object.getPrototypeOf(Object.getPrototypeOf(transport) as object) as object
    ).filter((n) => n !== "constructor" && !n.startsWith("assert"));
    expect([...own, ...inherited].sort()).toEqual([
      "addReaction",
      "postThreadMessage",
      "removeReaction",
      "updateMessage",
    ]);
  });
});
