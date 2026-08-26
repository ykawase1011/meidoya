import type { TransportKind } from "@meidoya/chat-core";
import type {
  ChatPlatformClient,
  InboundChatEvent,
  InboundEventHandler,
  PlatformEmoji,
  PlatformEventStream,
  PlatformMessageBody,
  PlatformMessageHandle,
  PlatformMessageTarget,
  PlatformOutboundMessage,
  PlatformThreadHandle,
  PlatformThreadRequest,
  SocketLike,
} from "./platform-client.js";

export type FakePlatformCall =
  | { kind: "open-thread"; request: PlatformThreadRequest }
  | { kind: "send"; message: PlatformOutboundMessage }
  | { kind: "edit"; target: PlatformMessageTarget; body: PlatformMessageBody }
  | { kind: "add-reaction"; target: PlatformMessageTarget; emoji: PlatformEmoji }
  | { kind: "remove-reaction"; target: PlatformMessageTarget; emoji: PlatformEmoji };

/** Records every platform call. Makes zero network calls and needs no token. */
export class FakePlatformClient implements ChatPlatformClient {
  readonly calls: FakePlatformCall[] = [];
  private handler: InboundEventHandler | undefined;
  private seq = 0;

  constructor(readonly kind: TransportKind = "slack") {}

  async openThread(request: PlatformThreadRequest): Promise<PlatformThreadHandle> {
    this.calls.push({ kind: "open-thread", request });
    return this.kind === "discord"
      ? { channelRef: `${request.messageRef}-thread` }
      : { channelRef: request.channelRef, threadRef: request.messageRef };
  }

  async sendMessage(message: PlatformOutboundMessage): Promise<PlatformMessageHandle> {
    this.calls.push({ kind: "send", message });
    this.seq += 1;
    return {
      messageRef: `${this.kind}-msg-${this.seq}`,
      ...(message.threadRef === undefined ? {} : { threadRef: message.threadRef }),
    };
  }

  async editMessage(target: PlatformMessageTarget, body: PlatformMessageBody): Promise<void> {
    this.calls.push({ kind: "edit", target, body });
  }

  async addReaction(target: PlatformMessageTarget, emoji: PlatformEmoji): Promise<void> {
    this.calls.push({ kind: "add-reaction", target, emoji });
  }

  async removeReaction(target: PlatformMessageTarget, emoji: PlatformEmoji): Promise<void> {
    this.calls.push({ kind: "remove-reaction", target, emoji });
  }

  async openEventStream(handler: InboundEventHandler): Promise<PlatformEventStream> {
    this.handler = handler;
    return {
      close: async () => {
        this.handler = undefined;
      },
    };
  }

  /** Drives an inbound event as if the platform had delivered it. */
  async emit(event: InboundChatEvent): Promise<void> {
    await this.handler?.(event);
  }

  callsOfKind<K extends FakePlatformCall["kind"]>(
    kind: K
  ): Array<Extract<FakePlatformCall, { kind: K }>> {
    return this.calls.filter(
      (c): c is Extract<FakePlatformCall, { kind: K }> => c.kind === kind
    );
  }

  reset(): void {
    this.calls.length = 0;
    this.seq = 0;
  }
}

/** In-memory `SocketLike` for exercising Socket Mode / gateway framing. */
export class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  private messageHandlers: Array<(data: string) => void> = [];
  private openHandlers: Array<() => void> = [];
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<(error: unknown) => void> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  onError(handler: (error: unknown) => void): void {
    this.errorHandlers.push(handler);
  }

  receive(frame: unknown): void {
    const data = typeof frame === "string" ? frame : JSON.stringify(frame);
    for (const h of this.messageHandlers) h(data);
  }

  open(): void {
    for (const h of this.openHandlers) h();
  }

  fail(error: unknown): void {
    for (const h of this.errorHandlers) h(error);
  }

  sentFrames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }
}
