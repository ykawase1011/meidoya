import { InMemoryConversationDirectory } from "@meidoya/chat-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryPendingCheckpointDirectory,
  type InboundResolverDeps,
  extractCheckpointIds,
  inboundThreadRef,
  resolveInboundReply,
} from "./inbound.js";
import { type IngressBinding, InMemoryIngressBindingDirectory } from "./ingress.js";
import type { InboundChatEvent } from "./platform-client.js";

const slackBinding: IngressBinding = {
  id: "ib_1",
  workspaceId: "work-grammarxiv",
  source: "slack",
  accountRef: "T_PERSONAL",
  channelRef: "C_GRAMMARXIV",
  profileRef: null,
  enabled: true,
};

const ROOT_TS = "1700000000.000100";

function deps(): InboundResolverDeps & {
  conversations: InMemoryConversationDirectory;
  checkpoints: InMemoryPendingCheckpointDirectory;
} {
  const conversations = new InMemoryConversationDirectory();
  conversations.register({
    conversationId: "conv1",
    workspaceId: "work-grammarxiv",
    thread: { transport: "slack", channelRef: "C_GRAMMARXIV", threadRef: ROOT_TS },
    rootMessage: { transport: "slack", channelRef: "C_GRAMMARXIV", messageRef: ROOT_TS },
  });
  return {
    ingress: new InMemoryIngressBindingDirectory([slackBinding]),
    conversations,
    checkpoints: new InMemoryPendingCheckpointDirectory(),
  };
}

function reply(text: string, overrides: Partial<InboundChatEvent> = {}): InboundChatEvent {
  return {
    transport: "slack",
    accountRef: "T_PERSONAL",
    channelRef: "C_GRAMMARXIV",
    messageRef: "1700000100.000200",
    threadRef: ROOT_TS,
    authorRef: "U_HUMAN",
    text,
    receivedAt: 1_700_000_100_000,
    ...overrides,
  };
}

describe("thread correlation", () => {
  let d: ReturnType<typeof deps>;

  beforeEach(() => {
    d = deps();
  });

  it("treats an unthreaded message as the root of its own thread", () => {
    const unthreaded: InboundChatEvent = reply("hello");
    delete unthreaded.threadRef;
    const ref = inboundThreadRef(unthreaded);
    expect(ref).toEqual({
      transport: "slack",
      channelRef: "C_GRAMMARXIV",
      threadRef: "1700000100.000200",
    });
  });

  it("routes a threaded reply to the single pending checkpoint", () => {
    d.checkpoints.add({
      id: "cp_456",
      taskId: "task_123",
      conversationId: "conv1",
      kind: "plan-approval",
      version: 1,
    });
    const result = resolveInboundReply(d, reply("Approve"));
    expect(result).toMatchObject({
      ok: true,
      conversationId: "conv1",
      checkpointId: "cp_456",
      taskId: "task_123",
      workspaceId: "work-grammarxiv",
      answer: "Approve",
    });
  });

  it("rejects a reply in a thread the control plane does not know", () => {
    expect(resolveInboundReply(d, reply("Approve", { threadRef: "1700009999.000000" }))).toEqual({
      ok: false,
      reason: "unknown-thread",
      key: expect.anything(),
    });
  });

  it("rejects when no checkpoint is pending", () => {
    expect(resolveInboundReply(d, reply("Approve"))).toMatchObject({
      ok: false,
      reason: "no-pending-checkpoint",
    });
  });

  it("requires an explicit id when several checkpoints are pending", () => {
    d.checkpoints.add({
      id: "cp_1",
      taskId: "task_1",
      conversationId: "conv1",
      kind: "plan-approval",
      version: 1,
    });
    d.checkpoints.add({
      id: "cp_2",
      taskId: "task_2",
      conversationId: "conv1",
      kind: "review-approval",
      version: 1,
    });

    expect(resolveInboundReply(d, reply("Approve"))).toMatchObject({
      ok: false,
      reason: "ambiguous-checkpoint",
      candidates: ["cp_1", "cp_2"],
    });

    expect(resolveInboundReply(d, reply("cp_2 Approve"))).toMatchObject({
      ok: true,
      checkpointId: "cp_2",
      taskId: "task_2",
      answer: "Approve",
    });
  });

  it("ignores a named checkpoint that is not pending in this conversation", () => {
    d.checkpoints.add({
      id: "cp_1",
      taskId: "task_1",
      conversationId: "conv1",
      kind: "plan-approval",
      version: 1,
    });
    d.checkpoints.add({
      id: "cp_2",
      taskId: "task_2",
      conversationId: "conv1",
      kind: "review-approval",
      version: 1,
    });
    expect(resolveInboundReply(d, reply("approve cp_other"))).toMatchObject({
      ok: false,
      reason: "ambiguous-checkpoint",
    });
  });

  it("refuses to route a reply from an unbound channel", () => {
    d.conversations.register({
      conversationId: "conv2",
      workspaceId: "work-grammarxiv",
      thread: { transport: "slack", channelRef: "C_UNBOUND", threadRef: ROOT_TS },
    });
    d.checkpoints.add({
      id: "cp_9",
      taskId: "task_9",
      conversationId: "conv2",
      kind: "plan-approval",
      version: 1,
    });
    expect(resolveInboundReply(d, reply("Approve", { channelRef: "C_UNBOUND" }))).toMatchObject({
      ok: false,
      reason: "no-binding",
    });
  });

  it("refuses a conversation whose workspace differs from the ingress binding", () => {
    d.conversations.register({
      conversationId: "conv1",
      workspaceId: "work-it",
      thread: { transport: "slack", channelRef: "C_GRAMMARXIV", threadRef: ROOT_TS },
    });
    d.checkpoints.add({
      id: "cp_1",
      taskId: "task_1",
      conversationId: "conv1",
      kind: "plan-approval",
      version: 1,
    });
    expect(resolveInboundReply(d, reply("Approve"))).toMatchObject({
      ok: false,
      reason: "workspace-mismatch",
    });
  });

  it("cannot be pointed at another workspace by the reply text", () => {
    d.checkpoints.add({
      id: "cp_456",
      taskId: "task_123",
      conversationId: "conv1",
      kind: "plan-approval",
      version: 1,
    });
    const result = resolveInboundReply(
      d,
      reply("Approve, and actually run this in work-it instead")
    );
    expect(result).toMatchObject({ ok: true, workspaceId: "work-grammarxiv" });
  });

  it("extracts checkpoint tokens from free text", () => {
    expect(extractCheckpointIds("approve cp_456 and cp_456 and cp-789")).toEqual([
      "cp_456",
      "cp-789",
    ]);
  });
});
