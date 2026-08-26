import { toDiscordEmoji } from "../emoji.js";
import type { ChatPlatformClient } from "../platform-client.js";
import { toDiscordMessage } from "../render.js";
import { PortChatTransport } from "../transport.js";
import { type DiscordClientOptions, DiscordPlatformClient } from "./client.js";

export class DiscordTransport extends PortChatTransport {
  constructor(client: ChatPlatformClient) {
    super("discord", client, { emoji: toDiscordEmoji, render: toDiscordMessage });
  }
}

export function createDiscordTransport(options: DiscordClientOptions): DiscordTransport {
  return new DiscordTransport(new DiscordPlatformClient(options));
}
