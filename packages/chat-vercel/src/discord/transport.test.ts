import type { MessageRef, ThreadRef } from "@meidoya/chat-core";
import { describe, expect, it, vi } from "vitest";
import { UnknownEmojiError } from "../emoji.js";
import { ChatRateLimitError, ChatTransportError } from "../errors.js";
import { FakePlatformClient, FakeSocket } from "../fake-platform-client.js";
import type { FetchLike } from "../platform-client.js";
import {
  DiscordPlatformClient,
  attachGateway,
  toDiscordComponentInteraction,
  toInboundDiscordEvent,
} from "./client.js";
import { DiscordTransport } from "./transport.js";

const DUMMY_BOT_TOKEN = "discord-dummy-not-a-real-token";

const THREAD: ThreadRef = {
  transport: "discord",
  channelRef: "000000000000000000",
  threadRef: "999999999999999999",
};

const ROOT: MessageRef = {
  transport: "discord",
  channelRef: "000000000000000000",
  messageRef: "111111111111111111",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("DiscordTransport", () => {
  it("renders normal text and posts into the thread channel", async () => {
    const client = new FakePlatformClient("discord");
    const transport = new DiscordTransport(client);
    const ref = await transport.postThreadMessage(THREAD, {
      text: "Result: done",
      links: [{ label: "diff", url: "https://example.invalid/diff" }],
    });

    expect(ref.threadRef).toBe("999999999999999999");
    const body = client.callsOfKind("send")[0]?.message.body;
    expect(body?.["content"]).toBe("Result: done\n\ndiff: https://example.invalid/diff");
    expect(body?.["embeds"]).toBeUndefined();
    expect(body?.["allowed_mentions"]).toEqual({ parse: [] });
  });

  it("maps neutral emoji names to unicode and custom emoji", async () => {
    const client = new FakePlatformClient("discord");
    const transport = new DiscordTransport(client);
    await transport.addReaction(ROOT, { name: "eyes" });
    await transport.addReaction(ROOT, { name: "custom:meidoya:123456789" });
    expect(client.callsOfKind("add-reaction").map((c) => c.emoji.value)).toEqual([
      "\u{1F440}",
      "meidoya:123456789",
    ]);
    await expect(transport.addReaction(ROOT, { name: "nope" })).rejects.toBeInstanceOf(
      UnknownEmojiError
    );
  });

  it("refuses refs belonging to another platform", async () => {
    const transport = new DiscordTransport(new FakePlatformClient("discord"));
    await expect(
      transport.postThreadMessage({ ...THREAD, transport: "slack" }, { text: "x" })
    ).rejects.toBeInstanceOf(ChatTransportError);
  });

  it("posts a reply in the parent channel with a message reference", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const client = new DiscordPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      fetch: async (url, init) => {
        paths.push(url);
        bodies.push(JSON.parse(String(init?.body)) as unknown);
        return jsonResponse({ id: "222222222222222222" });
      },
    });
    await new DiscordTransport(client).postThreadMessage(THREAD, { text: "hi" });
    expect(paths).toEqual([
      "https://discord.com/api/v10/channels/000000000000000000/messages",
    ]);
    expect(bodies).toEqual([
      expect.objectContaining({ message_reference: { message_id: "999999999999999999" } }),
    ]);
  });
});

describe("DiscordPlatformClient threads", () => {
  it("creates a real thread from the root message and adds its author", async () => {
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const client = new DiscordPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      fetch: async (url, init) => {
        requests.push({
          url,
          ...(init?.method === undefined ? {} : { method: init.method }),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        });
        return url.endsWith("/threads")
          ? jsonResponse({ id: "999999999999999999" })
          : new Response(null, { status: 204 });
      },
    });

    await expect(
      client.openThread({
        channelRef: "000000000000000000",
        messageRef: "111111111111111111",
        name: "READMEを確認する",
        memberRef: "333333333333333333",
      }),
    ).resolves.toEqual({ channelRef: "999999999999999999" });
    expect(requests).toEqual([
      {
        url: "https://discord.com/api/v10/channels/000000000000000000/messages/111111111111111111/threads",
        method: "POST",
        body: { name: "READMEを確認する", auto_archive_duration: 1440 },
      },
      {
        url: "https://discord.com/api/v10/channels/999999999999999999/thread-members/333333333333333333",
        method: "PUT",
      },
    ]);
  });
});

describe("DiscordPlatformClient rate limiting", () => {
  it("surfaces retry_after from the 429 body", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ retry_after: 1.5 }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    const client = new DiscordPlatformClient({ botToken: DUMMY_BOT_TOKEN, fetch: fetchImpl });
    const error = await client
      .addReaction({ channelRef: "C", messageRef: "M" }, { value: "\u{1F440}" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatRateLimitError);
    expect((error as ChatRateLimitError).retryAfterMs).toBe(1_500);
  });

  it("prefers the Retry-After header and never retries internally", async () => {
    let calls = 0;
    const client = new DiscordPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 429, headers: { "retry-after": "5" } });
      },
    });
    const error = await client
      .sendMessage({ channelRef: "C", body: {} })
      .catch((e: unknown) => e);
    expect((error as ChatRateLimitError).retryAfterMs).toBe(5_000);
    expect(calls).toBe(1);
  });

  it("marks 5xx retryable and 4xx terminal", async () => {
    const server = new DiscordPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      fetch: async () => new Response("", { status: 502 }),
    });
    const transient = await server.sendMessage({ channelRef: "C", body: {} }).catch((e: unknown) => e);
    expect(transient).toBeInstanceOf(ChatTransportError);
    expect((transient as ChatTransportError).retryable).toBe(true);

    const forbidden = new DiscordPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      fetch: async () => new Response("", { status: 403 }),
    });
    const terminal = await forbidden.sendMessage({ channelRef: "C", body: {} }).catch((e: unknown) => e);
    expect(terminal).toBeInstanceOf(ChatTransportError);
    expect((terminal as ChatTransportError).retryable).toBe(false);
  });
});

describe("Discord gateway", () => {
  it("heartbeats, identifies, and emits MESSAGE_CREATE", async () => {
    const socket = new FakeSocket();
    const seen: string[] = [];
    const stop = attachGateway(socket, (e) => {
      seen.push(`${e.channelRef}:${e.text}`);
    }, {
      token: DUMMY_BOT_TOKEN,
      intents: 1,
      setInterval: () => "timer",
      clearInterval: () => {},
    });

    socket.receive({ op: 10, d: { heartbeat_interval: 41250 } });
    socket.receive({
      op: 0,
      s: 1,
      t: "MESSAGE_CREATE",
      d: {
        id: "222",
        channel_id: "999999999999999999",
        guild_id: "G_PERSONAL",
        content: "Approve",
        author: { id: "U_HUMAN", bot: false },
      },
    });

    const frames = socket.sentFrames() as Array<{ op?: number; d?: { token?: string } }>;
    expect(frames[0]).toEqual({ op: 1, d: null });
    expect(frames[1]?.op).toBe(2);
    expect(seen).toEqual(["999999999999999999:Approve"]);
    stop();
  });

  it("ignores bot authors", () => {
    expect(
      toInboundDiscordEvent({
        op: 0,
        t: "MESSAGE_CREATE",
        d: {
          id: "1",
          channel_id: "2",
          guild_id: "3",
          content: "x",
          author: { id: "B", bot: true },
        },
      })
    ).toBeUndefined();
  });

  it("normalizes a checkpoint button interaction as a reply to the bot message", () => {
    expect(
      toDiscordComponentInteraction({
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          id: "interaction-1",
          token: "interaction-token",
          type: 3,
          channel_id: "D_WORK",
          guild_id: "G_PERSONAL",
          member: { user: { id: "U_HUMAN" } },
          message: { id: "bot-checkpoint-message" },
          data: { component_type: 2, custom_id: "meidoya:checkpoint:approve" },
        },
      }),
    ).toMatchObject({
      action: "approve",
      event: {
        channelRef: "D_WORK",
        threadRef: "bot-checkpoint-message",
        text: "承認",
      },
    });
  });

  it("acknowledges a checkpoint button, routes it, and removes the buttons", async () => {
    const socket = new FakeSocket();
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const seen: string[] = [];
    const client = new DiscordPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      socketFactory: () => socket,
      fetch: async (url, init) => {
        requests.push({
          url,
          ...(init?.method === undefined ? {} : { method: init.method }),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        });
        return new Response(null, { status: 204 });
      },
      resolveThreadParents: false,
    });
    await client.openEventStream((event) => {
      seen.push(`${event.threadRef}:${event.text}`);
    });
    socket.receive({
      op: 0,
      t: "INTERACTION_CREATE",
      d: {
        id: "interaction-1",
        token: "interaction-token",
        type: 3,
        channel_id: "D_WORK",
        guild_id: "G_PERSONAL",
        member: { user: { id: "U_HUMAN" } },
        message: { id: "bot-checkpoint-message" },
        data: { component_type: 2, custom_id: "meidoya:checkpoint:approve" },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual(["bot-checkpoint-message:承認"]);
    expect(requests).toEqual([
      {
        url: "https://discord.com/api/v10/interactions/interaction-1/interaction-token/callback",
        method: "POST",
        body: { type: 6 },
      },
      {
        url: "https://discord.com/api/v10/channels/D_WORK/messages/bot-checkpoint-message",
        method: "PATCH",
        body: { components: [] },
      },
    ]);
  });

  it("opens a modal and routes the entered instruction to the checkpoint", async () => {
    const socket = new FakeSocket();
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const seen: string[] = [];
    const client = new DiscordPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      socketFactory: () => socket,
      fetch: async (url, init) => {
        requests.push({
          url,
          ...(init?.method === undefined ? {} : { method: init.method }),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        });
        return new Response(null, { status: 204 });
      },
      resolveThreadParents: false,
    });
    await client.openEventStream((event) => {
      seen.push(`${event.threadRef}:${event.text}`);
    });

    socket.receive({
      op: 0,
      t: "INTERACTION_CREATE",
      d: {
        id: "interaction-open-modal",
        token: "modal-open-token",
        type: 3,
        channel_id: "D_WORK",
        guild_id: "G_PERSONAL",
        member: { user: { id: "U_HUMAN" } },
        message: { id: "bot-checkpoint-message" },
        data: { component_type: 2, custom_id: "meidoya:checkpoint:add-instruction" },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const modalBody = requests[0]?.body as { type?: number; data?: { custom_id?: string } };
    expect(modalBody).toMatchObject({
      type: 9,
      data: {
        custom_id: "meidoya:checkpoint:instruction:bot-checkpoint-message",
        title: "回答・追加指示",
      },
    });
    expect(seen).toEqual([]);

    socket.receive({
      op: 0,
      t: "INTERACTION_CREATE",
      d: {
        id: "interaction-submit-modal",
        token: "modal-submit-token",
        type: 5,
        channel_id: "D_WORK",
        guild_id: "G_PERSONAL",
        member: { user: { id: "U_HUMAN" } },
        data: {
          custom_id: "meidoya:checkpoint:instruction:bot-checkpoint-message",
          components: [
            {
              components: [
                {
                  custom_id: "meidoya:checkpoint:instruction-text",
                  value: "本番環境ではなくステージングで実行してください",
                },
              ],
            },
          ],
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual([
      "bot-checkpoint-message:本番環境ではなくステージングで実行してください",
    ]);
    expect(requests.slice(1)).toEqual([
      {
        url: "https://discord.com/api/v10/interactions/interaction-submit-modal/modal-submit-token/callback",
        method: "POST",
        body: { type: 6 },
      },
      {
        url: "https://discord.com/api/v10/channels/D_WORK/messages/bot-checkpoint-message",
        method: "PATCH",
        body: { components: [] },
      },
    ]);
  });

  it("closes when the gateway requests a reconnect", () => {
    const socket = new FakeSocket();
    attachGateway(socket, () => {}, {
      token: DUMMY_BOT_TOKEN,
      intents: 1,
      setInterval: () => "timer",
      clearInterval: () => {},
    });
    socket.receive({ op: 7, d: null });
    expect(socket.closed).toBe(true);
  });

  it("resolves a thread's parent channel for ingress binding", async () => {
    const socket = new FakeSocket();
    const client = new DiscordPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      socketFactory: () => socket,
      fetch: async (url) => {
        expect(url).toBe("https://discord.com/api/v10/channels/999999999999999999");
        return jsonResponse({ type: 11, parent_id: "000000000000000000" });
      },
    });

    const events: Array<{ channelRef: string; parentChannelRef?: string; threadRef?: string }> = [];
    await client.openEventStream((e) => {
      events.push(e);
    });
    socket.receive({ op: 10, d: { heartbeat_interval: 41250 } });
    socket.receive({
      op: 0,
      t: "MESSAGE_CREATE",
      d: {
        id: "222",
        channel_id: "999999999999999999",
        guild_id: "G_PERSONAL",
        content: "Approve",
        author: { id: "U_HUMAN" },
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(events[0]).toMatchObject({
      channelRef: "999999999999999999",
      parentChannelRef: "000000000000000000",
      threadRef: "999999999999999999",
    });
  });

  it("reopens the gateway after a disconnect", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeSocket(), new FakeSocket()];
      let opened = 0;
      const client = new DiscordPlatformClient({
        botToken: DUMMY_BOT_TOKEN,
        socketFactory: () => sockets[opened++] ?? new FakeSocket(),
        setInterval: () => "heartbeat",
        clearInterval: () => {},
      });
      const stream = await client.openEventStream(() => {});
      sockets[0]?.open();
      sockets[0]?.close();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(opened).toBe(2);
      await stream.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
