import type { ConversationId, WorkspaceId } from "@meidoya/domain";

/** Chat platform identifier. Deliberately a string union, never a vendor SDK type. */
export type TransportKind = "slack" | "discord" | "cli" | "fake";

/** Points at a thread (or channel root) on an external chat platform. */
export type ThreadRef = {
  transport: TransportKind;
  /** Channel / conversation identifier as the platform spells it. */
  channelRef: string;
  /** Root message identifier of the thread, when the platform has threads. */
  threadRef?: string;
};

/** Points at one concrete message on an external chat platform. */
export type MessageRef = {
  transport: TransportKind;
  channelRef: string;
  messageRef: string;
  threadRef?: string;
};

/** Platform-neutral emoji name, e.g. "eyes". Rendering to `👀` is the adapter's job. */
export type EmojiRef = {
  name: string;
};

export type MessageTone = "info" | "success" | "warning" | "danger";

export type RenderedMessageSection = {
  title: string;
  bullets: readonly string[];
};

/** Fully rendered, already scrubbed and truncated message body. */
export type RenderedMessage = {
  /** Plain-text notification/accessibility fallback and legacy payload. */
  text: string;
  /** Structured presentation retained until the platform adapter. */
  title?: string;
  summary?: string;
  tone?: MessageTone;
  bullets?: readonly string[];
  sections?: readonly RenderedMessageSection[];
  choices?: readonly string[];
  /** Optional artifact links; adapters may render them as attachments. */
  links?: ReadonlyArray<{ label: string; url: string }>;
};

/**
 * What a transport guarantees, stated honestly: AT-LEAST-ONCE, never
 * exactly-once.
 *
 * No method here takes an idempotency token, and no chat platform this adapts
 * deduplicates a post on the caller's behalf, so the only record that a post
 * happened is the one the CALLER writes after the call returns. The outbox
 * writes it immediately (`recordDelivery`, then `markSent`), which closes the
 * window to the width of one write — but it cannot close it: a process killed
 * between the platform accepting the post and that write landing has posted a
 * message it holds no receipt for, and the row is reclaimed and dispatched
 * again on restart.
 *
 * Duplicating a notification is the SAFE direction and is deliberately chosen
 * over the alternative (write first, and a failed post is silently marked
 * delivered). Anything that needs true once-only semantics has to carry a
 * transport-level idempotency key, which this interface does not have; do not
 * read the outbox's dedupe machinery as providing one.
 */
export interface ChatTransport {
  addReaction(ref: MessageRef, emoji: EmojiRef): Promise<void>;
  removeReaction(ref: MessageRef, emoji: EmojiRef): Promise<void>;
  postThreadMessage(ref: ThreadRef, message: RenderedMessage): Promise<MessageRef>;
  updateMessage(ref: MessageRef, message: RenderedMessage): Promise<void>;
}

/** Control-plane side of a chat thread. */
export type ConversationBinding = {
  conversationId: ConversationId;
  workspaceId: WorkspaceId;
  thread: ThreadRef;
  /** The inbound message that started the conversation; reactions land here. */
  rootMessage?: MessageRef;
};
