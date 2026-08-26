/**
 * ==========================================================================
 * VERCEL CHAT SDK SEAM
 * ==========================================================================
 * 07 section 6 names the Vercel Chat SDK (https://chat-sdk.dev/) as the initial
 * adapter, while requiring that the Interaction Policy never depends on SDK
 * types. That is why every backend in this package implements
 * `ChatPlatformClient` instead of being consumed directly.
 *
 * To drop the SDK in later:
 *   1. add the dependency,
 *   2. write `class VercelChatPlatformClient implements ChatPlatformClient`,
 *      translating the four outbound operations plus one event stream,
 *      mapping SDK throttling errors to `ChatRateLimitError` and everything
 *      else to `ChatTransportError`,
 *   3. hand it to `new PortChatTransport(kind, client, adapters)` — or to
 *      `SlackTransport` / `DiscordTransport`, which are just that constructor
 *      with the platform's emoji and render adapters bound.
 *
 * Nothing above the port (interaction-policy, notification-outbox, task-engine)
 * changes, because none of them import from this package.
 */

import type { TransportKind } from "@meidoya/chat-core";
import { toDiscordEmoji, toSlackEmoji } from "./emoji.js";
import type { ChatPlatformClient } from "./platform-client.js";
import { toDiscordMessage, toSlackMessage } from "./render.js";
import { PortChatTransport, type TransportAdapters } from "./transport.js";

export const PLATFORM_ADAPTERS: Readonly<Partial<Record<TransportKind, TransportAdapters>>> = {
  slack: { emoji: toSlackEmoji, render: toSlackMessage },
  discord: { emoji: toDiscordEmoji, render: toDiscordMessage },
};

/** Wraps any `ChatPlatformClient` — including a future SDK-backed one. */
export function createTransportForClient(
  kind: TransportKind,
  client: ChatPlatformClient,
  adapters: TransportAdapters | undefined = PLATFORM_ADAPTERS[kind]
): PortChatTransport {
  if (adapters === undefined) {
    throw new Error(`no message/emoji adapters registered for transport "${kind}"`);
  }
  return new PortChatTransport(kind, client, adapters);
}
