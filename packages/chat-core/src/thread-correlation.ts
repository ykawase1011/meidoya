import type { ConversationId, TaskId } from "@meidoya/domain";
import type { ConversationBinding, MessageRef, ThreadRef } from "./types.js";

/** Stable key for a thread: what inbound events and outbound posts correlate on. */
export function threadKey(ref: ThreadRef): string {
  return `${ref.transport}:${ref.channelRef}:${ref.threadRef ?? "-"}`;
}

export function messageThreadRef(ref: MessageRef): ThreadRef {
  return {
    transport: ref.transport,
    channelRef: ref.channelRef,
    // A message without a thread starts one rooted at itself.
    threadRef: ref.threadRef ?? ref.messageRef,
  };
}

export interface ConversationDirectory {
  findByThread(ref: ThreadRef): ConversationBinding | undefined;
  findByConversation(id: ConversationId): ConversationBinding | undefined;
}

/** In-memory directory; the SQLite-backed one implements the same interface. */
export class InMemoryConversationDirectory implements ConversationDirectory {
  private readonly byThread = new Map<string, ConversationBinding>();
  private readonly byConversation = new Map<ConversationId, ConversationBinding>();

  register(binding: ConversationBinding): void {
    this.byThread.set(threadKey(binding.thread), binding);
    this.byConversation.set(binding.conversationId, binding);
  }

  findByThread(ref: ThreadRef): ConversationBinding | undefined {
    return this.byThread.get(threadKey(ref));
  }

  findByConversation(id: ConversationId): ConversationBinding | undefined {
    return this.byConversation.get(id);
  }
}

export type TaskConversationLink = {
  taskId: TaskId;
  conversationId: ConversationId;
};

/** Maps an inbound external thread to the conversation it belongs to. */
export function correlateInboundThread(
  directory: ConversationDirectory,
  ref: ThreadRef
): ConversationBinding | undefined {
  return directory.findByThread(ref);
}

export type CheckpointTarget = {
  thread: ThreadRef;
  /** Message reactions should be attached to, when the conversation has a root. */
  reactionTarget?: MessageRef;
};

/** Resolves where a task's checkpoint reply must be posted. */
export function resolveCheckpointTarget(
  directory: ConversationDirectory,
  link: TaskConversationLink
): CheckpointTarget | undefined {
  const binding = directory.findByConversation(link.conversationId);
  if (!binding) return undefined;
  return {
    thread: binding.thread,
    ...(binding.rootMessage === undefined ? {} : { reactionTarget: binding.rootMessage }),
  };
}
