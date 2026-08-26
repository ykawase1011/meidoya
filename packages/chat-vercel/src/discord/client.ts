import {
  ChatRateLimitError,
  ChatTransportError,
  isTerminalHttpStatus,
  parseRetryAfterSeconds,
} from "../errors.js";
import type {
  ChatPlatformClient,
  FetchLike,
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
  SocketFactory,
  SocketLike,
} from "../platform-client.js";
import { nodeSocketFactory } from "../platform-client.js";

export type DiscordClientOptions = {
  /** Bot token. Never logged, never rendered into a message. */
  botToken: string;
  baseUrl?: string;
  gatewayUrl?: string;
  /** Gateway intents bitfield; defaults to GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT. */
  intents?: number;
  fetch?: FetchLike;
  socketFactory?: SocketFactory;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Set false to skip the REST lookup that maps a thread to its parent channel. */
  resolveThreadParents?: boolean;
};

const DEFAULT_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

type DiscordMessageResponse = {
  id?: string;
  channel_id?: string;
  /** Set when the message lives in a thread channel. */
  thread?: { id?: string };
};

/** Discord REST + gateway behind the `ChatPlatformClient` port. */
export class DiscordPlatformClient implements ChatPlatformClient {
  readonly kind = "discord" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly socketFactory: SocketFactory;
  private readonly parentCache = new Map<string, string | null>();

  constructor(private readonly options: DiscordClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://discord.com/api/v10";
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.socketFactory = options.socketFactory ?? nodeSocketFactory;
  }

  async openThread(request: PlatformThreadRequest): Promise<PlatformThreadHandle> {
    const payload = (await this.request(
      "POST",
      `/channels/${request.channelRef}/messages/${request.messageRef}/threads`,
      { name: request.name.slice(0, 100), auto_archive_duration: 1440 },
    )) as { id?: string } | undefined;
    const threadId = payload?.id;
    if (typeof threadId !== "string") {
      throw new ChatTransportError("discord thread create returned no id");
    }
    await this.request(
      "PUT",
      `/channels/${threadId}/thread-members/${request.memberRef}`,
    );
    this.parentCache.set(threadId, request.channelRef);
    return { channelRef: threadId };
  }

  async sendMessage(message: PlatformOutboundMessage): Promise<PlatformMessageHandle> {
    // A normal Discord reply stays in the channel and names the root message.
    // Real Discord thread conversations use the thread channel as channelRef
    // and leave threadRef absent, so the same request shape handles both.
    const body =
      message.threadRef === undefined
        ? message.body
        : { ...message.body, message_reference: { message_id: message.threadRef } };
    const payload = (await this.request(
      "POST",
      `/channels/${message.channelRef}/messages`,
      body,
    )) as
      | DiscordMessageResponse
      | undefined;
    const id = payload?.id;
    if (typeof id !== "string") {
      throw new ChatTransportError("discord message create returned no id");
    }
    const threadRef = message.threadRef ?? payload?.thread?.id;
    return { messageRef: id, ...(threadRef === undefined ? {} : { threadRef }) };
  }

  async editMessage(target: PlatformMessageTarget, body: PlatformMessageBody): Promise<void> {
    await this.request(
      "PATCH",
      `/channels/${target.channelRef}/messages/${target.messageRef}`,
      body
    );
  }

  async addReaction(target: PlatformMessageTarget, emoji: PlatformEmoji): Promise<void> {
    await this.request(
      "PUT",
      `/channels/${target.channelRef}/messages/${target.messageRef}/reactions/${encodeURIComponent(emoji.value)}/@me`
    );
  }

  async removeReaction(target: PlatformMessageTarget, emoji: PlatformEmoji): Promise<void> {
    await this.request(
      "DELETE",
      `/channels/${target.channelRef}/messages/${target.messageRef}/reactions/${encodeURIComponent(emoji.value)}/@me`
    );
  }

  /**
   * Discord thread messages arrive with `channel_id` = the thread's own id, so
   * the parent channel (what ingress binds on) has to be looked up and cached.
   */
  private async withParentChannel(event: InboundChatEvent): Promise<InboundChatEvent> {
    if (this.options.resolveThreadParents === false) return event;
    const cached = this.parentCache.get(event.channelRef);
    if (cached !== undefined) {
      return cached === null
        ? event
        : { ...event, parentChannelRef: cached, threadRef: event.threadRef ?? event.channelRef };
    }
    let parent: string | null = null;
    try {
      const channel = (await this.request("GET", `/channels/${event.channelRef}`)) as
        | { parent_id?: string | null; type?: number }
        | undefined;
      const isThread = channel?.type === 10 || channel?.type === 11 || channel?.type === 12;
      parent = isThread && typeof channel?.parent_id === "string" ? channel.parent_id : null;
    } catch {
      // Best effort: an unresolved parent simply leaves ingress to fail closed.
      return event;
    }
    this.parentCache.set(event.channelRef, parent);
    return parent === null
      ? event
      : { ...event, parentChannelRef: parent, threadRef: event.threadRef ?? event.channelRef };
  }

  async openEventStream(handler: InboundEventHandler): Promise<PlatformEventStream> {
    const url = this.options.gatewayUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
    let closed = false;
    let current: SocketLike | undefined;
    let stopCurrent: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const scheduleReconnect = (): void => {
      if (closed || retry !== undefined) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      attempt += 1;
      retry = setTimeout(() => {
        retry = undefined;
        connect();
      }, delay);
      retry.unref();
    };

    const connect = (): void => {
      if (closed) return;
      const socket = this.socketFactory(url);
      current = socket;
      const wrapped: InboundEventHandler = async (event) => {
        await handler(await this.withParentChannel(event));
      };
      const stop = attachGateway(socket, wrapped, {
        token: this.options.botToken,
        intents: this.options.intents ?? DEFAULT_INTENTS,
        handleInteraction: async (interaction) => {
          if (interaction.action === "add-instruction") {
            await this.request(
              "POST",
              `/interactions/${interaction.id}/${interaction.token}/callback`,
              {
                type: 9,
                data: {
                  custom_id: `meidoya:checkpoint:instruction:${interaction.messageRef}`,
                  title: "回答・追加指示",
                  components: [
                    {
                      type: 1,
                      components: [
                        {
                          type: 4,
                          custom_id: "meidoya:checkpoint:instruction-text",
                          label: "回答または追加指示",
                          style: 2,
                          min_length: 1,
                          max_length: 1000,
                          required: true,
                        },
                      ],
                    },
                  ],
                },
              },
            );
            return;
          }
          await this.request(
            "POST",
            `/interactions/${interaction.id}/${interaction.token}/callback`,
            { type: 6 },
          );
          await wrapped(interaction.event);
          await this.editMessage(
            { channelRef: interaction.channelRef, messageRef: interaction.messageRef },
            { components: [] },
          );
        },
        ...(this.options.setInterval === undefined
          ? {}
          : { setInterval: this.options.setInterval }),
        ...(this.options.clearInterval === undefined
          ? {}
          : { clearInterval: this.options.clearInterval }),
      });
      stopCurrent = stop;
      socket.onOpen(() => {
        if (current === socket) attempt = 0;
      });
      socket.onClose(() => {
        if (current !== socket) return;
        current = undefined;
        stopCurrent = undefined;
        stop();
        scheduleReconnect();
      });
      socket.onError(() => {
        if (current !== socket) return;
        current = undefined;
        stopCurrent = undefined;
        stop();
        socket.close();
        scheduleReconnect();
      });
    };

    connect();
    return {
      close: async () => {
        closed = true;
        if (retry !== undefined) clearTimeout(retry);
        retry = undefined;
        const socket = current;
        current = undefined;
        stopCurrent?.();
        stopCurrent = undefined;
        socket?.close();
      },
    };
  }

  private async request(
    method: string,
    path: string,
    body?: PlatformMessageBody
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.options.botToken}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 429) {
      throw new ChatRateLimitError(
        `discord ${method} ${path} rate limited`,
        await discordRetryAfterMs(response)
      );
    }
    if (response.status >= 500) {
      throw new ChatTransportError(`discord ${method} ${path} failed with ${response.status}`, {
        retryable: true,
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new ChatTransportError(`discord ${method} ${path} failed with ${response.status}`, {
        retryable: !isTerminalHttpStatus(response.status),
        status: response.status,
      });
    }
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
}

async function discordRetryAfterMs(response: Response): Promise<number> {
  const header = response.headers.get("retry-after");
  if (header !== null) return parseRetryAfterSeconds(header);
  try {
    const body = (await response.json()) as { retry_after?: number };
    if (typeof body.retry_after === "number") return Math.ceil(body.retry_after * 1_000);
  } catch {
    /* body may be empty */
  }
  return 1_000;
}

type GatewayFrame = {
  op?: number;
  t?: string;
  s?: number;
  d?: {
    heartbeat_interval?: number;
    id?: string;
    channel_id?: string;
    guild_id?: string;
    content?: string;
    author?: { id?: string; bot?: boolean };
    member?: { user?: { id?: string } };
    user?: { id?: string };
    message_reference?: { message_id?: string; channel_id?: string };
    message?: { id?: string };
    token?: string;
    data?: {
      custom_id?: string;
      component_type?: number;
      components?: Array<{
        components?: Array<{ custom_id?: string; value?: string }>;
      }>;
    };
    thread?: { id?: string };
    type?: number;
  };
};

export type DiscordComponentInteraction = {
  id: string;
  token: string;
  channelRef: string;
  messageRef: string;
  action: "approve" | "add-instruction" | "instruction-submit" | "cancel";
  event: InboundChatEvent;
};

export type GatewayOptions = {
  token: string;
  intents: number;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  handleInteraction?: (interaction: DiscordComponentInteraction) => void | Promise<void>;
};

/** Exported for tests: identify + heartbeat + MESSAGE_CREATE normalisation. */
export function attachGateway(
  socket: SocketLike,
  handler: InboundEventHandler,
  options: GatewayOptions
): () => void {
  const start = options.setInterval ?? ((h, ms) => setInterval(h, ms));
  const stop = options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let heartbeat: unknown;
  let sequence: number | null = null;

  socket.onMessage((data) => {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(data) as GatewayFrame;
    } catch {
      return;
    }
    if (typeof frame.s === "number") sequence = frame.s;

    if (frame.op === 10) {
      const interval = frame.d?.heartbeat_interval ?? 41_250;
      socket.send(JSON.stringify({ op: 1, d: sequence }));
      heartbeat = start(() => socket.send(JSON.stringify({ op: 1, d: sequence })), interval);
      socket.send(
        JSON.stringify({
          op: 2,
          d: {
            token: options.token,
            intents: options.intents,
            properties: { os: process.platform, browser: "meidoya", device: "meidoya" },
          },
        })
      );
      return;
    }
    if (frame.op === 1) {
      socket.send(JSON.stringify({ op: 1, d: sequence }));
      return;
    }
    if (frame.op === 7 || frame.op === 9) {
      // Gateway asks clients to reconnect (or rejects this session). Closing
      // hands control to DiscordPlatformClient's reconnect supervisor.
      socket.close();
      return;
    }
    if (frame.op === 0 && frame.t === "INTERACTION_CREATE") {
      const interaction = toDiscordComponentInteraction(frame);
      if (interaction !== undefined && options.handleInteraction !== undefined) {
        void Promise.resolve(options.handleInteraction(interaction)).catch(() => undefined);
      }
      return;
    }
    if (frame.op !== 0 || frame.t !== "MESSAGE_CREATE") return;
    const event = toInboundDiscordEvent(frame);
    if (event) void Promise.resolve(handler(event)).catch(() => undefined);
  });

  socket.onClose(() => {
    if (heartbeat !== undefined) stop(heartbeat);
  });

  return () => {
    if (heartbeat !== undefined) stop(heartbeat);
  };
}

export function toDiscordComponentInteraction(
  frame: GatewayFrame,
): DiscordComponentInteraction | undefined {
  const data = frame.d;
  if (
    frame.op !== 0 ||
    frame.t !== "INTERACTION_CREATE" ||
    (data?.type !== 3 && data?.type !== 5)
  ) {
    return undefined;
  }
  const instructionPrefix = "meidoya:checkpoint:instruction:";
  const instructionText = data.data?.components
    ?.flatMap((row) => row.components ?? [])
    .find((component) => component.custom_id === "meidoya:checkpoint:instruction-text")
    ?.value?.trim();
  const action = (() => {
    if (data.type === 5 && data.data?.custom_id?.startsWith(instructionPrefix)) {
      return instructionText === undefined || instructionText.length === 0
        ? undefined
        : ("instruction-submit" as const);
    }
    switch (data.data?.custom_id) {
      case "meidoya:checkpoint:approve":
        return "approve" as const;
      case "meidoya:checkpoint:add-instruction":
        return "add-instruction" as const;
      case "meidoya:checkpoint:cancel":
        return "cancel" as const;
      default:
        return undefined;
    }
  })();
  const authorRef = data.member?.user?.id ?? data.user?.id;
  const messageRef =
    data.type === 5
      ? data.data?.custom_id?.slice(instructionPrefix.length)
      : data.message?.id;
  if (
    action === undefined ||
    typeof data.id !== "string" ||
    typeof data.token !== "string" ||
    typeof data.channel_id !== "string" ||
    typeof data.guild_id !== "string" ||
    typeof authorRef !== "string" ||
    typeof messageRef !== "string"
  ) {
    return undefined;
  }
  return {
    id: data.id,
    token: data.token,
    channelRef: data.channel_id,
    messageRef,
    action,
    event: {
      transport: "discord",
      accountRef: data.guild_id,
      channelRef: data.channel_id,
      messageRef: data.id,
      threadRef: messageRef,
      authorRef,
      text:
        action === "approve"
          ? "承認"
          : action === "cancel"
            ? "キャンセル"
            : instructionText ?? "回答・指示を入力",
      receivedAt: Date.now(),
    },
  };
}

export function toInboundDiscordEvent(frame: GatewayFrame): InboundChatEvent | undefined {
  const d = frame.d;
  if (!d) return undefined;
  // Never react to our own or any other bot's message.
  if (d.author?.bot === true) return undefined;
  const { id, channel_id: channelId, guild_id: guildId, content } = d;
  const authorRef = d.author?.id;
  if (
    typeof id !== "string" ||
    typeof channelId !== "string" ||
    typeof guildId !== "string" ||
    typeof authorRef !== "string" ||
    typeof content !== "string"
  ) {
    return undefined;
  }
  // A reply inside a Discord thread arrives on the thread's own channel id; a
  // plain reply carries message_reference instead.
  const threadRef = d.message_reference?.message_id;
  return {
    transport: "discord",
    accountRef: guildId,
    channelRef: channelId,
    messageRef: id,
    ...(threadRef === undefined ? {} : { threadRef }),
    authorRef,
    text: content,
    receivedAt: Date.now(),
  };
}
