import { describe, expect, it } from "vitest";
import {
  DISCORD_EMBED_DESCRIPTION_LIMIT,
  SLACK_BLOCK_LIMIT,
  SLACK_SECTION_TEXT_LIMIT,
  escapeSlackText,
  toDiscordMessage,
  toSlackMessage,
} from "./render.js";

describe("slack rendering", () => {
  it("splits long text into section blocks within the per-section limit", () => {
    const body = toSlackMessage({ text: "x".repeat(SLACK_SECTION_TEXT_LIMIT * 2 + 10) });
    const blocks = body["blocks"] as Array<{ text: { text: string } }>;
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_LIMIT);
    }
    expect((body["text"] as string).length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_LIMIT);
  });

  it("caps the block count", () => {
    const body = toSlackMessage({
      text: "y".repeat(SLACK_SECTION_TEXT_LIMIT * (SLACK_BLOCK_LIMIT + 5)),
    });
    expect((body["blocks"] as unknown[]).length).toBeLessThanOrEqual(SLACK_BLOCK_LIMIT);
  });

  it("escapes markup and defuses broadcast mentions", () => {
    expect(escapeSlackText("<script> & @channel")).toBe("&lt;script&gt; &amp; @​channel");
  });

  it("renders links as a context block", () => {
    const body = toSlackMessage({
      text: "Result",
      links: [{ label: "artifact", url: "https://example.invalid/a" }],
    });
    const blocks = body["blocks"] as Array<Record<string, unknown>>;
    expect(blocks[1]).toMatchObject({ type: "context" });
  });

  it("renders semantic results as Block Kit headers and grouped sections", () => {
    const body = toSlackMessage({
      text: "fallback",
      title: "進行中のタスク",
      summary: "2件です。",
      tone: "success",
      sections: [{ title: "実行中", bullets: ["⚙️ 実行中 — parser"] }],
    });
    expect(body["blocks"]).toMatchObject([
      { type: "header", text: { type: "plain_text", text: "進行中のタスク" } },
      { type: "section", text: { type: "mrkdwn", text: "2件です。" } },
      { type: "section", text: { type: "mrkdwn", text: expect.stringContaining("*実行中*") } },
    ]);
  });
});

describe("discord rendering", () => {
  it("truncates the embed description to the platform limit", () => {
    const body = toDiscordMessage({ text: "z".repeat(DISCORD_EMBED_DESCRIPTION_LIMIT + 500) });
    const embed = (body["embeds"] as Array<{ description: string }>)[0];
    expect(embed?.description.length).toBe(DISCORD_EMBED_DESCRIPTION_LIMIT);
    expect(embed?.description.endsWith("…")).toBe(true);
  });

  it("drops link fields that would exceed the embed total budget", () => {
    const links = Array.from({ length: 25 }, (_, i) => ({
      label: `link-${i}`,
      url: `https://example.invalid/${"p".repeat(900)}/${i}`,
    }));
    const body = toDiscordMessage({ text: "a".repeat(4000), links });
    const embed = (body["embeds"] as Array<{ fields?: unknown[] }>)[0];
    expect((embed?.fields ?? []).length).toBeLessThan(links.length);
  });

  it("always suppresses mentions", () => {
    expect(toDiscordMessage({ text: "@everyone ship it" })["allowed_mentions"]).toEqual({
      parse: [],
    });
  });

  it("renders semantic results as titled, coloured embeds with fields", () => {
    const body = toDiscordMessage({
      text: "fallback",
      title: "進行中のタスク",
      summary: "2件です。",
      tone: "success",
      sections: [{ title: "確認待ち", bullets: ["✋ 計画承認待ち — deploy"] }],
    });
    expect(body["embeds"]).toMatchObject([
      {
        title: "進行中のタスク",
        description: "2件です。",
        color: 0x22c55e,
        fields: [{ name: "確認待ち", value: expect.stringContaining("計画承認待ち") }],
      },
    ]);
  });
});
