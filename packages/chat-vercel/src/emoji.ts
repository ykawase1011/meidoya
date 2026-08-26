import type { EmojiRef } from "@meidoya/chat-core";
import type { PlatformEmoji } from "./platform-client.js";

/**
 * Platform-neutral emoji names (07 section 2) mapped per platform. Slack takes
 * shortcodes, Discord takes unicode or `name:id` for custom emoji.
 */
const UNICODE_BY_NAME: Readonly<Record<string, string>> = {
  eyes: "\u{1F440}",
  question: "❓",
  memo: "\u{1F4DD}",
  mag: "\u{1F50D}",
  no_entry: "⛔",
  warning: "⚠️",
  white_check_mark: "✅",
  x: "❌",
  hourglass: "⏳",
  robot_face: "\u{1F916}",
};

/** Slack shortcode aliases for names whose Slack spelling differs. */
const SLACK_ALIASES: Readonly<Record<string, string>> = {
  check: "white_check_mark",
  magnifier: "mag",
  stop: "no_entry",
};

export class UnknownEmojiError extends Error {
  constructor(name: string, platform: string) {
    super(`no ${platform} mapping for emoji "${name}"`);
    this.name = "UnknownEmojiError";
  }
}

const CUSTOM_PREFIX = "custom:";

export function toSlackEmoji(emoji: EmojiRef): PlatformEmoji {
  const raw = emoji.name.trim();
  if (raw.startsWith(CUSTOM_PREFIX)) return { value: raw.slice(CUSTOM_PREFIX.length) };
  const name = SLACK_ALIASES[raw] ?? raw;
  // Slack accepts any workspace shortcode, so an unknown name is still valid;
  // only the surrounding colons must be stripped.
  return { value: name.replace(/^:|:$/g, "") };
}

/**
 * Discord reactions are URL path segments: unicode literal, or `name:id` for a
 * custom emoji supplied as `custom:name:id`.
 */
export function toDiscordEmoji(emoji: EmojiRef): PlatformEmoji {
  const raw = emoji.name.trim();
  if (raw.startsWith(CUSTOM_PREFIX)) {
    const rest = raw.slice(CUSTOM_PREFIX.length);
    if (!/^[A-Za-z0-9_]+:\d+$/.test(rest)) {
      throw new UnknownEmojiError(raw, "discord");
    }
    return { value: rest };
  }
  const unicode = UNICODE_BY_NAME[SLACK_ALIASES[raw] ?? raw];
  if (unicode === undefined) throw new UnknownEmojiError(raw, "discord");
  return { value: unicode };
}

export function emojiUnicode(name: string): string | undefined {
  return UNICODE_BY_NAME[SLACK_ALIASES[name] ?? name];
}
