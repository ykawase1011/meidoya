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

export type SlackClientOptions = {
  /** Bot token (`xoxb-…`). Never logged, never rendered into a message. */
  botToken: string;
  /** App-level token (`xapp-…`) used only to open a Socket Mode connection. */
  appToken?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  socketFactory?: SocketFactory;
};

type SlackApiResponse = {
  ok?: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  message?: { thread_ts?: string };
  url?: string;
};

/** Slack Web API + Socket Mode behind the `ChatPlatformClient` port. */
export class SlackPlatformClient implements ChatPlatformClient {
  readonly kind = "slack" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly socketFactory: SocketFactory;

  constructor(private readonly options: SlackClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://slack.com/api";
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.socketFactory = options.socketFactory ?? nodeSocketFactory;
  }

  async openThread(request: PlatformThreadRequest): Promise<PlatformThreadHandle> {
    return { channelRef: request.channelRef, threadRef: request.messageRef };
  }

  async sendMessage(message: PlatformOutboundMessage): Promise<PlatformMessageHandle> {
    const res = await this.call("chat.postMessage", {
      channel: message.channelRef,
      ...(message.threadRef === undefined ? {} : { thread_ts: message.threadRef }),
      ...message.body,
    });
    const ts = res.ts;
    if (typeof ts !== "string") {
      throw new ChatTransportError("slack chat.postMessage returned no ts");
    }
    const threadRef = message.threadRef ?? res.message?.thread_ts;
    return { messageRef: ts, ...(threadRef === undefined ? {} : { threadRef }) };
  }

  async editMessage(target: PlatformMessageTarget, body: PlatformMessageBody): Promise<void> {
    await this.call("chat.update", {
      channel: target.channelRef,
      ts: target.messageRef,
      ...body,
    });
  }

  async addReaction(target: PlatformMessageTarget, emoji: PlatformEmoji): Promise<void> {
    await this.call(
      "reactions.add",
      { channel: target.channelRef, timestamp: target.messageRef, name: emoji.value },
      // Re-adding the same reaction is a no-op, not a failure worth retrying.
      ["already_reacted"]
    );
  }

  async removeReaction(target: PlatformMessageTarget, emoji: PlatformEmoji): Promise<void> {
    await this.call(
      "reactions.remove",
      { channel: target.channelRef, timestamp: target.messageRef, name: emoji.value },
      ["no_reaction"]
    );
  }

  async openEventStream(handler: InboundEventHandler): Promise<PlatformEventStream> {
    if (this.options.appToken === undefined) {
      throw new ChatTransportError("slack socket mode requires an app token");
    }
    let closed = false;
    let current: SocketLike | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const scheduleReconnect = (): void => {
      if (closed || retry !== undefined) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      attempt += 1;
      retry = setTimeout(() => {
        retry = undefined;
        void connect().catch(() => scheduleReconnect());
      }, delay);
      retry.unref();
    };

    const connect = async (): Promise<void> => {
      const opened = await this.call("apps.connections.open", {}, [], this.options.appToken);
      if (typeof opened.url !== "string") {
        throw new ChatTransportError("slack apps.connections.open returned no url");
      }
      if (closed) return;
      const socket = this.socketFactory(opened.url);
      current = socket;
      attachSocketMode(socket, handler);
      socket.onOpen(() => {
        if (current === socket) attempt = 0;
      });
      socket.onClose(() => {
        if (current !== socket) return;
        current = undefined;
        scheduleReconnect();
      });
      socket.onError(() => {
        if (current !== socket) return;
        current = undefined;
        socket.close();
        scheduleReconnect();
      });
    };

    await connect();
    return {
      close: async () => {
        closed = true;
        if (retry !== undefined) clearTimeout(retry);
        retry = undefined;
        const socket = current;
        current = undefined;
        socket?.close();
      },
    };
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    tolerate: readonly string[] = [],
    token = this.options.botToken
  ): Promise<SlackApiResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      throw new ChatRateLimitError(
        `slack ${method} rate limited`,
        parseRetryAfterSeconds(response.headers.get("retry-after"))
      );
    }
    if (response.status >= 500) {
      throw new ChatTransportError(`slack ${method} failed with ${response.status}`, {
        retryable: true,
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new ChatTransportError(`slack ${method} failed with ${response.status}`, {
        retryable: !isTerminalHttpStatus(response.status),
        status: response.status,
      });
    }

    const payload = (await response.json()) as SlackApiResponse;
    if (payload.ok === true) return payload;
    const error = payload.error ?? "unknown_error";
    if (tolerate.includes(error)) return payload;
    if (error === "ratelimited") {
      // Slack can also signal throttling inside a 200 body.
      throw new ChatRateLimitError(
        `slack ${method} rate limited`,
        parseRetryAfterSeconds(response.headers.get("retry-after"))
      );
    }
    throw new ChatTransportError(`slack ${method} failed: ${error}`, {
      retryable: !TERMINAL_SLACK_ERRORS.has(error),
    });
  }
}

/**
 * Slack body errors a retry can never turn into a success, as an ALLOWLIST.
 *
 * This used to be the inverse — a four-entry list of RETRYABLE errors, with
 * everything else terminal — which made every Slack error string nobody had
 * enumerated (including every one Slack adds in future) a permanent loss of the
 * notification on its first attempt. The list below is the closed set: the
 * target does not exist, is not writable, or the payload is one Slack refuses.
 *
 * Credential errors (`invalid_auth`, `token_revoked`, `account_inactive`,
 * `not_authed`) are deliberately ABSENT: they are repaired by rotating a token,
 * and the backlog queued behind a rotation must survive it.
 */
const TERMINAL_SLACK_ERRORS: ReadonlySet<string> = new Set([
  // Target does not exist / cannot be written.
  "channel_not_found",
  "message_not_found",
  "thread_not_found",
  "user_not_found",
  "users_not_found",
  "is_archived",
  "not_in_channel",
  "cant_update_message",
  "cant_delete_message",
  "restricted_action",
  "restricted_action_read_only_channel",
  "restricted_action_thread_only_channel",
  "restricted_action_non_threadable_channel",
  "ekm_access_denied",
  "no_permission",
  "missing_scope",
  // Payload Slack will never accept.
  "msg_too_long",
  "no_text",
  "too_many_attachments",
  "invalid_blocks",
  "invalid_blocks_format",
  "invalid_attachments",
  "invalid_arguments",
  "invalid_arg_name",
  "invalid_array_arg",
  "invalid_charset",
  "invalid_form_data",
  "invalid_post_type",
  "missing_post_type",
  "json_not_object",
  "invalid_json",
]);

type SocketModeEnvelope = {
  envelope_id?: string;
  type?: string;
  payload?: {
    team_id?: string;
    event?: {
      type?: string;
      subtype?: string;
      bot_id?: string;
      channel?: string;
      user?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
    };
  };
};

/** Exported for tests: turns raw Socket Mode frames into inbound events + acks. */
export function attachSocketMode(socket: SocketLike, handler: InboundEventHandler): void {
  socket.onMessage((data) => {
    let envelope: SocketModeEnvelope;
    try {
      envelope = JSON.parse(data) as SocketModeEnvelope;
    } catch {
      return;
    }
    const event = toInboundSlackEvent(envelope);
    const acknowledge = (): void => {
      if (envelope.envelope_id !== undefined) {
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }
    };
    if (event === undefined) {
      acknowledge();
      return;
    }
    // Socket Mode retries an envelope until it is acknowledged. Ack only
    // after the daemon has durably accepted the task/checkpoint answer; a
    // rejected handler deliberately leaves the envelope retryable.
    void Promise.resolve(handler(event)).then(acknowledge, () => undefined);
  });
  socket.onError(() => {
    /* SlackPlatformClient owns reconnect; framing remains transport-only. */
  });
}

export function toInboundSlackEvent(envelope: SocketModeEnvelope): InboundChatEvent | undefined {
  if (envelope.type !== "events_api") return undefined;
  const event = envelope.payload?.event;
  if (!event || event.type !== "message") return undefined;
  // Ignore edits/joins and anything the bot itself posted, so the transport can
  // never react to its own output.
  if (event.subtype !== undefined || event.bot_id !== undefined) return undefined;
  const { channel, ts, user, text } = event;
  if (
    typeof channel !== "string" ||
    typeof ts !== "string" ||
    typeof user !== "string" ||
    typeof text !== "string"
  ) {
    return undefined;
  }
  const accountRef = envelope.payload?.team_id;
  if (typeof accountRef !== "string") return undefined;
  return {
    transport: "slack",
    accountRef,
    channelRef: channel,
    messageRef: ts,
    ...(event.thread_ts === undefined ? {} : { threadRef: event.thread_ts }),
    authorRef: user,
    text,
    receivedAt: Math.round(Number.parseFloat(ts) * 1_000) || 0,
  };
}
