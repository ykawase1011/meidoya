import type { TransportKind } from "@meidoya/chat-core";

/**
 * The narrow port every chat backend sits behind (07 section 6: the Interaction
 * Policy must not depend on SDK types). Slack, Discord and a future Vercel Chat
 * SDK adapter all implement exactly this.
 */
export interface ChatPlatformClient {
  readonly kind: TransportKind;
  sendMessage(message: PlatformOutboundMessage): Promise<PlatformMessageHandle>;
  editMessage(target: PlatformMessageTarget, body: PlatformMessageBody): Promise<void>;
  addReaction(target: PlatformMessageTarget, emoji: PlatformEmoji): Promise<void>;
  removeReaction(target: PlatformMessageTarget, emoji: PlatformEmoji): Promise<void>;
  openEventStream(handler: InboundEventHandler): Promise<PlatformEventStream>;
}

/** Already-rendered platform payload (Slack blocks / Discord embeds). */
export type PlatformMessageBody = Record<string, unknown>;

export type PlatformOutboundMessage = {
  channelRef: string;
  threadRef?: string;
  body: PlatformMessageBody;
};

export type PlatformMessageTarget = {
  channelRef: string;
  messageRef: string;
};

export type PlatformMessageHandle = {
  messageRef: string;
  threadRef?: string;
};

/** Platform-specific emoji encoding produced by the emoji mapper. */
export type PlatformEmoji = {
  /** Slack reaction name, or Discord unicode / `name:id` custom form. */
  value: string;
};

/** Normalised inbound message. Deliberately carries routing facts and text apart. */
export type InboundChatEvent = {
  transport: TransportKind;
  /** Slack team id / Discord guild id. */
  accountRef: string;
  channelRef: string;
  /**
   * Set when `channelRef` is itself a thread (Discord threads are channels).
   * Ingress binding is always resolved against the parent channel.
   */
  parentChannelRef?: string;
  messageRef: string;
  /** Present when the message is a reply inside an existing thread. */
  threadRef?: string;
  authorRef: string;
  text: string;
  /** CLI/http ingress profile, unused by socket transports but part of the tuple. */
  profileRef?: string;
  receivedAt: number;
};

export type InboundEventHandler = (event: InboundChatEvent) => void | Promise<void>;

export interface PlatformEventStream {
  close(): Promise<void>;
}

/** Minimal socket surface so tests can drive Socket Mode / gateway without a network. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** Wraps Node 22's global WebSocket; no `ws` dependency needed. */
export const nodeSocketFactory: SocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: (h) => socket.addEventListener("open", () => h()),
    onMessage: (h) =>
      socket.addEventListener("message", (event) => {
        const data = (event as { data?: unknown }).data;
        h(typeof data === "string" ? data : String(data));
      }),
    onClose: (h) => socket.addEventListener("close", () => h()),
    onError: (h) => socket.addEventListener("error", (event) => h(event)),
  };
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
