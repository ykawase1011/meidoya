import type { ConversationBinding, ConversationDirectory, ThreadRef } from "@meidoya/chat-core";
import { correlateInboundThread } from "@meidoya/chat-core";
import type { CheckpointId, ConversationId, TaskId, WorkspaceId } from "@meidoya/domain";
import {
  type IngressBindingDirectory,
  type IngressKey,
  type IngressRejectionReason,
  ingressKeyOf,
  resolveIngressBinding,
} from "./ingress.js";
import type { InboundChatEvent } from "./platform-client.js";

/** Mirrors `HumanCheckpoint` (06 section 3), narrowed to what routing needs. */
export type PendingCheckpoint = {
  id: CheckpointId;
  taskId: TaskId;
  conversationId: ConversationId;
  kind: string;
  version: number;
};

export interface PendingCheckpointDirectory {
  listPending(conversationId: ConversationId): readonly PendingCheckpoint[];
}

export class InMemoryPendingCheckpointDirectory implements PendingCheckpointDirectory {
  private readonly byConversation = new Map<ConversationId, PendingCheckpoint[]>();

  add(checkpoint: PendingCheckpoint): void {
    const rows = this.byConversation.get(checkpoint.conversationId) ?? [];
    rows.push(checkpoint);
    this.byConversation.set(checkpoint.conversationId, rows);
  }

  resolve(conversationId: ConversationId, checkpointId: CheckpointId): void {
    const rows = this.byConversation.get(conversationId) ?? [];
    this.byConversation.set(
      conversationId,
      rows.filter((c) => c.id !== checkpointId)
    );
  }

  listPending(conversationId: ConversationId): readonly PendingCheckpoint[] {
    return this.byConversation.get(conversationId) ?? [];
  }
}

export type InboundRejectionReason =
  | IngressRejectionReason
  | "unknown-thread"
  | "workspace-mismatch"
  | "no-pending-checkpoint"
  | "ambiguous-checkpoint";

export type InboundAnswer = {
  ok: true;
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
  checkpointId: CheckpointId;
  taskId: TaskId;
  /** Reply text with the disambiguating checkpoint token removed. */
  answer: string;
  thread: ThreadRef;
};

export type InboundRejection = {
  ok: false;
  reason: InboundRejectionReason;
  /** Populated for `ambiguous-checkpoint`, so the reply can list the choices. */
  candidates?: readonly CheckpointId[];
  key?: IngressKey;
};

export type InboundResolution = InboundAnswer | InboundRejection;

/**
 * Canonical thread key for an inbound message: the parent channel plus the
 * thread root, so Slack `thread_ts` and Discord thread channels line up with
 * what `postThreadMessage` targeted.
 */
export function inboundThreadRef(event: InboundChatEvent): ThreadRef {
  if (event.transport === "discord" && event.parentChannelRef !== undefined) {
    return {
      transport: "discord",
      // Discord threads are channels. The parent is used only for ingress
      // binding; delivery and correlation both use the actual thread channel.
      channelRef: event.channelRef,
    };
  }
  const threadRef = event.threadRef ?? event.messageRef;
  return {
    transport: event.transport,
    channelRef: event.parentChannelRef ?? event.channelRef,
    threadRef,
  };
}

const CHECKPOINT_TOKEN = /\bcp[_-][A-Za-z0-9]+\b/g;

/** Checkpoint ids named in a reply, e.g. "approve cp_456" (06 section 3). */
export function extractCheckpointIds(text: string): readonly string[] {
  return [...new Set(text.match(CHECKPOINT_TOKEN) ?? [])];
}

function stripCheckpointIds(text: string): string {
  return text.replace(CHECKPOINT_TOKEN, "").replace(/\s{2,}/g, " ").trim();
}

export type InboundResolverDeps = {
  ingress: IngressBindingDirectory;
  conversations: ConversationDirectory;
  checkpoints: PendingCheckpointDirectory;
};

/**
 * Inbound routing in fail-closed order:
 *   1. ingress binding fixes the workspace from routing facts only,
 *   2. the thread maps to a conversation,
 *   3. the conversation's workspace must equal the bound workspace,
 *   4. exactly one pending checkpoint, or an explicit id among the pending set.
 * The message text influences step 4 only, and only by selecting from the
 * already-pending checkpoints of the already-fixed conversation.
 */
export function resolveInboundReply(
  deps: InboundResolverDeps,
  event: InboundChatEvent
): InboundResolution {
  const key = ingressKeyOf(event);
  if (key === undefined) return { ok: false, reason: "unsupported-source" };

  const ingress = resolveIngressBinding(deps.ingress, key);
  if (!ingress.ok) return { ok: false, reason: ingress.reason, key };

  const thread = inboundThreadRef(event);
  const conversation: ConversationBinding | undefined = correlateInboundThread(
    deps.conversations,
    thread
  );
  if (!conversation) return { ok: false, reason: "unknown-thread", key };
  if (conversation.workspaceId !== ingress.workspaceId) {
    return { ok: false, reason: "workspace-mismatch", key };
  }

  const pending = deps.checkpoints.listPending(conversation.conversationId);
  if (pending.length === 0) return { ok: false, reason: "no-pending-checkpoint", key };

  let selected = pending[0];
  if (pending.length > 1) {
    const named = extractCheckpointIds(event.text);
    const matched = pending.filter((c) => named.includes(c.id));
    if (matched.length !== 1) {
      return {
        ok: false,
        reason: "ambiguous-checkpoint",
        candidates: pending.map((c) => c.id),
        key,
      };
    }
    selected = matched[0];
  }
  if (selected === undefined) return { ok: false, reason: "no-pending-checkpoint", key };

  return {
    ok: true,
    workspaceId: ingress.workspaceId,
    conversationId: conversation.conversationId,
    checkpointId: selected.id,
    taskId: selected.taskId,
    answer: stripCheckpointIds(event.text),
    thread,
  };
}
