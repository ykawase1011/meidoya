import type {
  ChatTransport,
  EmojiRef,
  MessageRef,
  RenderedMessage,
  ThreadRef,
} from "./types.js";

export type FakeTransportCall =
  | { kind: "add-reaction"; ref: MessageRef; emoji: EmojiRef }
  | { kind: "remove-reaction"; ref: MessageRef; emoji: EmojiRef }
  | { kind: "post-thread-message"; ref: ThreadRef; message: RenderedMessage; result: MessageRef }
  | { kind: "update-message"; ref: MessageRef; message: RenderedMessage };

/** In-memory transport for tests and the local demo. Records every call. */
export class FakeChatTransport implements ChatTransport {
  readonly calls: FakeTransportCall[] = [];
  /** When set, the next matching operation throws instead of succeeding. */
  failNext = false;
  private seq = 0;

  async addReaction(ref: MessageRef, emoji: EmojiRef): Promise<void> {
    this.maybeFail();
    this.calls.push({ kind: "add-reaction", ref, emoji });
  }

  async removeReaction(ref: MessageRef, emoji: EmojiRef): Promise<void> {
    this.maybeFail();
    this.calls.push({ kind: "remove-reaction", ref, emoji });
  }

  async postThreadMessage(ref: ThreadRef, message: RenderedMessage): Promise<MessageRef> {
    this.maybeFail();
    this.seq += 1;
    const result: MessageRef = {
      transport: ref.transport,
      channelRef: ref.channelRef,
      messageRef: `fake-msg-${this.seq}`,
      ...(ref.threadRef === undefined ? {} : { threadRef: ref.threadRef }),
    };
    this.calls.push({ kind: "post-thread-message", ref, message, result });
    return result;
  }

  async updateMessage(ref: MessageRef, message: RenderedMessage): Promise<void> {
    this.maybeFail();
    this.calls.push({ kind: "update-message", ref, message });
  }

  callsOfKind<K extends FakeTransportCall["kind"]>(
    kind: K
  ): Array<Extract<FakeTransportCall, { kind: K }>> {
    return this.calls.filter(
      (c): c is Extract<FakeTransportCall, { kind: K }> => c.kind === kind
    );
  }

  reset(): void {
    this.calls.length = 0;
    this.seq = 0;
    this.failNext = false;
  }

  private maybeFail(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("fake transport failure");
    }
  }
}
