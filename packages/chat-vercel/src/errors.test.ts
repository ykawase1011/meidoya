import { describe, expect, it } from "vitest";
import { DiscordPlatformClient } from "./discord/client.js";
import { ChatTransportError, isTerminalHttpStatus } from "./errors.js";
import { SlackPlatformClient } from "./slack/client.js";

const SLACK_TOKEN = "xoxb-dummy-not-a-real-token";
const DISCORD_TOKEN = "discord-dummy-not-a-real-token";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/**
 * These pin the DIRECTION of the default. The outbox dead-letters on
 * `retryable === false`, so whatever an unclassified failure defaults to is
 * what happens to a notification nobody anticipated the failure mode of.
 */
describe("an unclassified transport failure is retryable", () => {
  it("defaults retryable to true, so an unforeseen failure is not a dead letter", () => {
    expect(new ChatTransportError("something nobody enumerated").retryable).toBe(true);
    expect(new ChatTransportError("explicitly hopeless", { retryable: false }).retryable).toBe(
      false,
    );
  });

  it("treats permanence as an allowlist of HTTP statuses, not as everything-not-5xx", () => {
    for (const status of [400, 403, 404, 405, 410, 413, 414, 422, 431]) {
      expect(isTerminalHttpStatus(status)).toBe(true);
    }
    // Repairable or transient: a retry can genuinely succeed.
    for (const status of [401, 408, 409, 425, 500, 502, 503, 504, 418]) {
      expect(isTerminalHttpStatus(status)).toBe(false);
    }
  });

  it("slack: a rotated token is retryable, an impossible target is not", async () => {
    const withError = (error: string) =>
      new SlackPlatformClient({
        botToken: SLACK_TOKEN,
        fetch: async () => jsonResponse({ ok: false, error }),
      })
        .sendMessage({ channelRef: "C1", body: {} })
        .then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as ChatTransportError);

    // The reason the outbox exists: the operator rotates the token and the
    // backlog queued behind the rotation still goes out.
    for (const error of ["invalid_auth", "token_revoked", "not_authed", "account_inactive"]) {
      expect((await withError(error)).retryable).toBe(true);
    }
    // A Slack error string nobody has enumerated (they add them) must not
    // destroy the notification on attempt 1.
    expect((await withError("some_error_slack_added_last_tuesday")).retryable).toBe(true);

    for (const error of ["channel_not_found", "is_archived", "msg_too_long", "invalid_blocks"]) {
      expect((await withError(error)).retryable).toBe(false);
    }
  });

  it("slack: an unlisted HTTP status stays retryable, an allowlisted one does not", async () => {
    const atStatus = (status: number) =>
      new SlackPlatformClient({
        botToken: SLACK_TOKEN,
        fetch: async () => new Response("", { status }),
      })
        .sendMessage({ channelRef: "C1", body: {} })
        .then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as ChatTransportError);

    expect((await atStatus(408)).retryable).toBe(true);
    expect((await atStatus(401)).retryable).toBe(true);
    expect((await atStatus(404)).retryable).toBe(false);
  });

  it("discord: an unlisted HTTP status stays retryable", async () => {
    const atStatus = (status: number) =>
      new DiscordPlatformClient({
        botToken: DISCORD_TOKEN,
        fetch: async () => new Response("", { status }),
      })
        .sendMessage({ channelRef: "C", body: {} })
        .then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as ChatTransportError);

    expect((await atStatus(408)).retryable).toBe(true);
    expect((await atStatus(401)).retryable).toBe(true);
    expect((await atStatus(403)).retryable).toBe(false);
  });
});
