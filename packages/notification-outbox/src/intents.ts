import type { EmojiRef, RenderedMessage } from "@meidoya/chat-core";
import type { OutboxAction, TaskId } from "@meidoya/domain";
import type { OutboxIntentInput } from "./repository.js";

/**
 * Structural shape of an interaction-policy intent. Typed structurally so the
 * outbox does not depend on the policy package (and cannot create a cycle).
 */
export type PolicyIntentLike = {
  action: OutboxAction;
  idempotencyKey: string;
  eventId: string;
  workspaceId: string;
  conversationId?: string;
  taskId?: TaskId;
  emoji?: EmojiRef;
  message?: RenderedMessage;
  targetIdempotencyKey?: string;
};

export function toOutboxIntentInput(intent: PolicyIntentLike): OutboxIntentInput {
  const payload: Record<string, unknown> = {};
  if (intent.emoji) payload["emoji"] = intent.emoji;
  if (intent.message) payload["message"] = intent.message;
  if (intent.targetIdempotencyKey) {
    payload["targetIdempotencyKey"] = intent.targetIdempotencyKey;
  }
  return {
    action: intent.action,
    idempotencyKey: intent.idempotencyKey,
    eventId: intent.eventId,
    workspaceId: intent.workspaceId,
    ...(intent.conversationId === undefined ? {} : { conversationId: intent.conversationId }),
    ...(intent.taskId === undefined ? {} : { taskId: intent.taskId }),
    payload,
  };
}
