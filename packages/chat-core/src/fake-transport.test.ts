import { describe, expect, it } from "vitest";
import { FakeChatTransport } from "./fake-transport.js";
import {
  InMemoryConversationDirectory,
  correlateInboundThread,
  messageThreadRef,
  resolveCheckpointTarget,
  threadKey,
} from "./thread-correlation.js";
import type { MessageRef, ThreadRef } from "./types.js";

const thread: ThreadRef = { transport: "fake", channelRef: "C1", threadRef: "T1" };
const root: MessageRef = {
  transport: "fake",
  channelRef: "C1",
  messageRef: "T1",
  threadRef: "T1",
};

describe("FakeChatTransport", () => {
  it("records every call and returns a fresh message ref per post", async () => {
    const t = new FakeChatTransport();
    const a = await t.postThreadMessage(thread, { text: "one" });
    const b = await t.postThreadMessage(thread, { text: "two" });
    await t.addReaction(root, { name: "eyes" });
    await t.removeReaction(root, { name: "eyes" });
    await t.updateMessage(a, { text: "one-edited" });

    expect(a.messageRef).not.toBe(b.messageRef);
    expect(t.calls.map((c) => c.kind)).toEqual([
      "post-thread-message",
      "post-thread-message",
      "add-reaction",
      "remove-reaction",
      "update-message",
    ]);
    expect(t.callsOfKind("post-thread-message")).toHaveLength(2);
  });

  it("fails once when failNext is set", async () => {
    const t = new FakeChatTransport();
    t.failNext = true;
    await expect(t.postThreadMessage(thread, { text: "x" })).rejects.toThrow();
    await expect(t.postThreadMessage(thread, { text: "x" })).resolves.toBeDefined();
  });
});

describe("thread correlation", () => {
  it("maps an inbound thread ref back to its conversation", () => {
    const dir = new InMemoryConversationDirectory();
    dir.register({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      thread,
      rootMessage: root,
    });

    expect(correlateInboundThread(dir, thread)?.conversationId).toBe("conv_1");
    expect(
      correlateInboundThread(dir, { transport: "fake", channelRef: "C9" })
    ).toBeUndefined();
  });

  it("resolves the checkpoint reply target for a task", () => {
    const dir = new InMemoryConversationDirectory();
    dir.register({ conversationId: "conv_1", workspaceId: "ws_1", thread, rootMessage: root });

    const target = resolveCheckpointTarget(dir, { taskId: "task_1", conversationId: "conv_1" });
    expect(target?.thread).toEqual(thread);
    expect(target?.reactionTarget).toEqual(root);
    expect(
      resolveCheckpointTarget(dir, { taskId: "task_1", conversationId: "missing" })
    ).toBeUndefined();
  });

  it("treats an unthreaded message as the root of its own thread", () => {
    const ref: MessageRef = { transport: "fake", channelRef: "C1", messageRef: "M9" };
    expect(messageThreadRef(ref).threadRef).toBe("M9");
    expect(threadKey(messageThreadRef(ref))).toBe("fake:C1:M9");
  });
});
