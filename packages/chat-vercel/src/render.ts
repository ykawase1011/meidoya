import type { RenderedMessage } from "@meidoya/chat-core";
import type { PlatformMessageBody } from "./platform-client.js";

/**
 * These renderers only reshape an already-scrubbed and truncated
 * `RenderedMessage` (07 section 9). There is deliberately no overload taking a
 * raw string, so no caller can smuggle raw LLM output past the policy renderer.
 */

export const SLACK_SECTION_TEXT_LIMIT = 3000;
export const SLACK_TEXT_LIMIT = 40_000;
export const SLACK_BLOCK_LIMIT = 50;

export const DISCORD_CONTENT_LIMIT = 2000;
export const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
export const DISCORD_EMBED_TOTAL_LIMIT = 6000;

const DISCORD_COLORS = {
  info: 0x3b82f6,
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
} as const;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function chunk(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

/** Slack mrkdwn escaping plus neutralising @channel/@here broadcast tokens. */
export function escapeSlackText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(channel|here|everyone)\b/gi, "@​$1");
}

export function toSlackMessage(message: RenderedMessage): PlatformMessageBody {
  const escaped = truncate(escapeSlackText(message.text), SLACK_TEXT_LIMIT);
  const blocks: Array<Record<string, unknown>> = [];
  const structured =
    message.title !== undefined ||
    message.summary !== undefined ||
    message.bullets !== undefined ||
    message.sections !== undefined ||
    message.choices !== undefined;

  if (structured) {
    if (message.title !== undefined) {
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: truncate(message.title, 150), emoji: true },
      });
    }
    if (message.summary !== undefined) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncate(escapeSlackText(message.summary), SLACK_SECTION_TEXT_LIMIT),
        },
      });
    }
    if (message.bullets !== undefined && message.bullets.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncate(
            message.bullets.map((item) => `• ${escapeSlackText(item)}`).join("\n"),
            SLACK_SECTION_TEXT_LIMIT,
          ),
        },
      });
    }
    for (const section of message.sections ?? []) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncate(
            `*${escapeSlackText(section.title)}*\n${section.bullets
              .map((item) => `• ${escapeSlackText(item)}`)
              .join("\n")}`,
            SLACK_SECTION_TEXT_LIMIT,
          ),
        },
      });
    }
    if (message.choices !== undefined && message.choices.length > 0) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: truncate(
              `返信: ${message.choices.map((choice) => `\`${escapeSlackText(choice)}\``).join(" / ")}`,
              SLACK_SECTION_TEXT_LIMIT,
            ),
          },
        ],
      });
    }
  } else {
    blocks.push(
      ...chunk(escaped, SLACK_SECTION_TEXT_LIMIT).map((part) => ({
        type: "section",
        text: { type: "mrkdwn", text: part },
      })),
    );
  }

  const links = message.links ?? [];
  if (links.length > 0) {
    const rendered = links
      .map((l) => `<${l.url}|${escapeSlackText(l.label)}>`)
      .join("  ·  ");
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: truncate(rendered, SLACK_SECTION_TEXT_LIMIT) }],
    });
  }

  return {
    // `text` is the notification fallback; blocks carry the real body.
    text: truncate(escaped, SLACK_SECTION_TEXT_LIMIT),
    blocks: blocks.slice(0, SLACK_BLOCK_LIMIT),
  };
}

export function toDiscordMessage(message: RenderedMessage): PlatformMessageBody {
  const structured =
    message.title !== undefined ||
    message.summary !== undefined ||
    message.bullets !== undefined ||
    message.sections !== undefined ||
    message.choices !== undefined;
  const body = [
    message.summary,
    message.bullets?.map((item) => `• ${item}`).join("\n"),
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
  const description = truncate(
    structured ? body : message.text,
    DISCORD_EMBED_DESCRIPTION_LIMIT,
  );
  const links = message.links ?? [];

  const fields = (message.sections ?? []).map((section) => ({
    name: truncate(section.title, 256),
    value: truncate(section.bullets.map((item) => `• ${item}`).join("\n"), 1024),
    inline: false,
  }));
  if (message.choices !== undefined && message.choices.length > 0) {
    fields.push({
      name: "返信方法",
      value: truncate(message.choices.map((choice) => `\`${choice}\``).join(" / "), 1024),
      inline: false,
    });
  }
  fields.push(...links.map((link) => ({
    name: truncate(link.label, 256),
    value: truncate(link.url, 1024),
    inline: false,
  })));

  const candidates = fields.slice(0, 25);
  let total = description.length + (message.title?.length ?? 0);
  const kept: typeof fields = [];
  for (const field of candidates) {
    const cost = field.name.length + field.value.length;
    if (total + cost > DISCORD_EMBED_TOTAL_LIMIT) break;
    total += cost;
    kept.push(field);
  }

  const embed: Record<string, unknown> = {};
  if (message.title !== undefined) embed["title"] = truncate(message.title, 256);
  if (description.length > 0) embed["description"] = description;
  if (message.tone !== undefined) embed["color"] = DISCORD_COLORS[message.tone];
  if (kept.length > 0) embed["fields"] = kept;

  return {
    // Empty content keeps the whole body inside the embed; mass mentions are
    // suppressed unconditionally so rendered text can never ping a channel.
    content: "",
    embeds: [embed],
    allowed_mentions: { parse: [] },
  };
}
