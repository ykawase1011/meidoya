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

const DISCORD_CHECKPOINT_ACTIONS: Readonly<
  Record<string, { customId: string; label: string; style: number } | undefined>
> = {
  approve: { customId: "meidoya:checkpoint:approve", label: "承認", style: 3 },
  approved: { customId: "meidoya:checkpoint:approve", label: "承認", style: 3 },
  "承認": { customId: "meidoya:checkpoint:approve", label: "承認", style: 3 },
  "add instruction": {
    customId: "meidoya:checkpoint:add-instruction",
    label: "回答・指示を入力",
    style: 2,
  },
  "指示を追加": {
    customId: "meidoya:checkpoint:add-instruction",
    label: "回答・指示を入力",
    style: 2,
  },
  "回答・指示を入力": {
    customId: "meidoya:checkpoint:add-instruction",
    label: "回答・指示を入力",
    style: 2,
  },
  cancel: { customId: "meidoya:checkpoint:cancel", label: "キャンセル", style: 4 },
  "キャンセル": { customId: "meidoya:checkpoint:cancel", label: "キャンセル", style: 4 },
};

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
  const links = (message.links ?? []).map((link) => `${link.label}: ${link.url}`);
  const content = truncate([message.text, ...links].filter((part) => part.length > 0).join("\n\n"), DISCORD_CONTENT_LIMIT);
  const buttons = (message.choices ?? []).flatMap((choice) => {
    const action = DISCORD_CHECKPOINT_ACTIONS[choice.trim().toLocaleLowerCase("ja-JP")];
    return action === undefined
      ? []
      : [
          {
            type: 2,
            style: action.style,
            label: action.label,
            custom_id: action.customId,
          },
        ];
  });

  return {
    content,
    allowed_mentions: { parse: [] },
    ...(buttons.length === 0
      ? {}
      : { components: [{ type: 1, components: buttons.slice(0, 5) }] }),
  };
}
