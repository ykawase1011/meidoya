import type {
  ChatTransport,
  EmojiRef,
  MessageRef,
  RenderedMessage,
  ThreadRef,
  TransportKind,
} from "@meidoya/chat-core";
import { ChatTransportError } from "./errors.js";
import type { ChatPlatformClient, PlatformEmoji, PlatformMessageBody } from "./platform-client.js";

export type TransportAdapters = {
  emoji: (emoji: EmojiRef) => PlatformEmoji;
  render: (message: RenderedMessage) => PlatformMessageBody;
};

/**
 * The only implementation of `ChatTransport` in this package: a dumb executor
 * of outbox intents. It exposes no "notify"/"announce" entry point, so there is
 * no code path that posts a message on the transport's own initiative
 * (Phase 4 DoD: quiet UX).
 */
export class PortChatTransport implements ChatTransport {
  constructor(
    readonly kind: TransportKind,
    private readonly client: ChatPlatformClient,
    private readonly adapters: TransportAdapters
  ) {}

  async addReaction(ref: MessageRef, emoji: EmojiRef): Promise<void> {
    this.assertKind(ref.transport);
    await this.client.addReaction(
      { channelRef: ref.channelRef, messageRef: ref.messageRef },
      this.adapters.emoji(emoji)
    );
  }

  async removeReaction(ref: MessageRef, emoji: EmojiRef): Promise<void> {
    this.assertKind(ref.transport);
    await this.client.removeReaction(
      { channelRef: ref.channelRef, messageRef: ref.messageRef },
      this.adapters.emoji(emoji)
    );
  }

  async postThreadMessage(ref: ThreadRef, message: RenderedMessage): Promise<MessageRef> {
    this.assertKind(ref.transport);
    const handle = await this.client.sendMessage({
      channelRef: ref.channelRef,
      ...(ref.threadRef === undefined ? {} : { threadRef: ref.threadRef }),
      body: this.adapters.render(message),
    });
    const threadRef = ref.threadRef ?? handle.threadRef;
    return {
      transport: this.kind,
      channelRef: ref.channelRef,
      messageRef: handle.messageRef,
      ...(threadRef === undefined ? {} : { threadRef }),
    };
  }

  async updateMessage(ref: MessageRef, message: RenderedMessage): Promise<void> {
    this.assertKind(ref.transport);
    await this.client.editMessage(
      { channelRef: ref.channelRef, messageRef: ref.messageRef },
      this.adapters.render(message)
    );
  }

  /** A ref from another platform must never be executed against this client. */
  private assertKind(kind: TransportKind): void {
    if (kind !== this.kind) {
      // Explicitly terminal: a row addressed to the wrong platform is a routing
      // mistake, and no number of retries turns it into the right platform.
      throw new ChatTransportError(`ref targets "${kind}" but transport is "${this.kind}"`, {
        retryable: false,
      });
    }
  }
}
