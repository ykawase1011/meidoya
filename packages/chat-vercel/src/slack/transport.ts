import { toSlackEmoji } from "../emoji.js";
import type { ChatPlatformClient } from "../platform-client.js";
import { toSlackMessage } from "../render.js";
import { PortChatTransport } from "../transport.js";
import { type SlackClientOptions, SlackPlatformClient } from "./client.js";

export class SlackTransport extends PortChatTransport {
  constructor(client: ChatPlatformClient) {
    super("slack", client, { emoji: toSlackEmoji, render: toSlackMessage });
  }
}

export function createSlackTransport(options: SlackClientOptions): SlackTransport {
  return new SlackTransport(new SlackPlatformClient(options));
}
