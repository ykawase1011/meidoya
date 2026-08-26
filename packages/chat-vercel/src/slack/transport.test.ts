import type { MessageRef, ThreadRef } from "@meidoya/chat-core";
import { describe, expect, it, vi } from "vitest";
import { ChatRateLimitError, ChatTransportError } from "../errors.js";
import { FakePlatformClient, FakeSocket } from "../fake-platform-client.js";
import type { FetchLike } from "../platform-client.js";
import { SlackPlatformClient, attachSocketMode, toInboundSlackEvent } from "./client.js";
import { SlackTransport } from "./transport.js";

const DUMMY_BOT_TOKEN = "xoxb-dummy-not-a-real-token";
const DUMMY_APP_TOKEN = "xapp-dummy-not-a-real-token";

const THREAD: ThreadRef = {
  transport: "slack",
  channelRef: "C_GRAMMARXIV",
  threadRef: "1700000000.000100",
};

const ROOT: MessageRef = {
  transport: "slack",
  channelRef: "C_GRAMMARXIV",
  messageRef: "1700000000.000100",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("SlackTransport", () => {
  it("posts thread replies with thread_ts and Slack blocks", async () => {
    const client = new FakePlatformClient("slack");
    const transport = new SlackTransport(client);

    const ref = await transport.postThreadMessage(THREAD, { text: "Plan: do the thing" });

    expect(ref).toEqual({
      transport: "slack",
      channelRef: "C_GRAMMARXIV",
      messageRef: "slack-msg-1",
      threadRef: "1700000000.000100",
    });
    const sent = client.callsOfKind("send")[0];
    expect(sent?.message.threadRef).toBe("1700000000.000100");
    expect(sent?.message.body["blocks"]).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Plan: do the thing" } },
    ]);
  });

  it("maps neutral emoji names to Slack reaction names", async () => {
    const client = new FakePlatformClient("slack");
    const transport = new SlackTransport(client);
    await transport.addReaction(ROOT, { name: "eyes" });
    await transport.removeReaction(ROOT, { name: "eyes" });
    expect(client.callsOfKind("add-reaction")[0]?.emoji).toEqual({ value: "eyes" });
    expect(client.callsOfKind("remove-reaction")[0]?.emoji).toEqual({ value: "eyes" });
  });

  it("refuses refs belonging to another platform", async () => {
    const transport = new SlackTransport(new FakePlatformClient("slack"));
    await expect(
      transport.addReaction({ ...ROOT, transport: "discord" }, { name: "eyes" })
    ).rejects.toBeInstanceOf(ChatTransportError);
  });
});

describe("SlackPlatformClient rate limiting", () => {
  it("surfaces a retryable error with Retry-After on HTTP 429", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("", { status: 429, headers: { "retry-after": "30" } });
    const transport = new SlackTransport(
      new SlackPlatformClient({ botToken: DUMMY_BOT_TOKEN, fetch: fetchImpl })
    );

    const error = await transport.addReaction(ROOT, { name: "eyes" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatRateLimitError);
    expect((error as ChatRateLimitError).retryAfterMs).toBe(30_000);
    expect((error as ChatTransportError).retryable).toBe(true);
  });

  it("treats a 200 body with error=ratelimited as rate limiting", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ ok: false, error: "ratelimited" }, { headers: { "retry-after": "2" } });
    const client = new SlackPlatformClient({ botToken: DUMMY_BOT_TOKEN, fetch: fetchImpl });
    const error = await client
      .sendMessage({ channelRef: "C1", body: { text: "x" } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatRateLimitError);
    expect((error as ChatRateLimitError).retryAfterMs).toBe(2_000);
  });

  it("does not retry internally: exactly one HTTP call per operation", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response("", { status: 429, headers: { "retry-after": "1" } });
    };
    const client = new SlackPlatformClient({ botToken: DUMMY_BOT_TOKEN, fetch: fetchImpl });
    await client.addReaction({ channelRef: "C1", messageRef: "1" }, { value: "eyes" }).catch(() => {});
    expect(calls).toBe(1);
  });

  it("tolerates already_reacted and marks unknown errors non-retryable", async () => {
    const client = new SlackPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      fetch: async () => jsonResponse({ ok: false, error: "already_reacted" }),
    });
    await expect(
      client.addReaction({ channelRef: "C1", messageRef: "1" }, { value: "eyes" })
    ).resolves.toBeUndefined();

    const strict = new SlackPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      fetch: async () => jsonResponse({ ok: false, error: "channel_not_found" }),
    });
    const error = await strict
      .sendMessage({ channelRef: "C1", body: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatTransportError);
    expect((error as ChatTransportError).retryable).toBe(false);
  });

  it("returns the posted ts", async () => {
    const client = new SlackPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      fetch: async () => jsonResponse({ ok: true, ts: "1700000100.000200" }),
    });
    await expect(
      client.sendMessage({ channelRef: "C1", threadRef: "1700000000.000100", body: {} })
    ).resolves.toEqual({ messageRef: "1700000100.000200", threadRef: "1700000000.000100" });
  });
});

describe("Slack Socket Mode", () => {
  it("acks envelopes after the inbound handler succeeds", async () => {
    const socket = new FakeSocket();
    const seen: string[] = [];
    attachSocketMode(socket, (event) => {
      seen.push(`${event.channelRef}:${event.text}`);
    });

    socket.receive({
      envelope_id: "env-1",
      type: "events_api",
      payload: {
        team_id: "T_PERSONAL",
        event: {
          type: "message",
          channel: "C_GRAMMARXIV",
          user: "U_HUMAN",
          text: "Approve",
          ts: "1700000100.000200",
          thread_ts: "1700000000.000100",
        },
      },
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.sentFrames()).toEqual([{ envelope_id: "env-1" }]);
    expect(seen).toEqual(["C_GRAMMARXIV:Approve"]);
  });

  it("leaves a failed inbound envelope unacked so Slack retries it", async () => {
    const socket = new FakeSocket();
    attachSocketMode(socket, async () => {
      throw new Error("database unavailable");
    });
    socket.receive({
      envelope_id: "env-retry",
      type: "events_api",
      payload: {
        team_id: "T_PERSONAL",
        event: {
          type: "message",
          channel: "C_GRAMMARXIV",
          user: "U_HUMAN",
          text: "Run tests",
          ts: "1700000100.000201",
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.sentFrames()).toEqual([]);
  });

  it("ignores bot messages and subtypes so the transport never echoes itself", () => {
    expect(
      toInboundSlackEvent({
        type: "events_api",
        payload: {
          team_id: "T",
          event: { type: "message", bot_id: "B1", channel: "C", user: "U", text: "x", ts: "1" },
        },
      })
    ).toBeUndefined();
    expect(
      toInboundSlackEvent({
        type: "events_api",
        payload: {
          team_id: "T",
          event: {
            type: "message",
            subtype: "message_changed",
            channel: "C",
            user: "U",
            text: "x",
            ts: "1",
          },
        },
      })
    ).toBeUndefined();
  });

  it("opens the socket with the app token", async () => {
    const socket = new FakeSocket();
    const urls: string[] = [];
    const client = new SlackPlatformClient({
      botToken: DUMMY_BOT_TOKEN,
      appToken: DUMMY_APP_TOKEN,
      fetch: async (url) => {
        urls.push(url);
        return jsonResponse({ ok: true, url: "wss://example.invalid/socket" });
      },
      socketFactory: () => socket,
    });
    const stream = await client.openEventStream(() => {});
    expect(urls).toEqual(["https://slack.com/api/apps.connections.open"]);
    await stream.close();
    expect(socket.closed).toBe(true);
  });

  it("reopens Socket Mode after a disconnect", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeSocket(), new FakeSocket()];
      let opened = 0;
      const client = new SlackPlatformClient({
        botToken: DUMMY_BOT_TOKEN,
        appToken: DUMMY_APP_TOKEN,
        fetch: async () => jsonResponse({ ok: true, url: `wss://example.invalid/${opened}` }),
        socketFactory: () => sockets[opened++] ?? new FakeSocket(),
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

  it("refuses socket mode without an app token", async () => {
    const client = new SlackPlatformClient({ botToken: DUMMY_BOT_TOKEN, fetch: async () => jsonResponse({}) });
    await expect(client.openEventStream(() => {})).rejects.toBeInstanceOf(ChatTransportError);
  });
});
