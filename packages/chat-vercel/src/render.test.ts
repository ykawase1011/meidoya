import { describe, expect, it } from "vitest";
import {
  DISCORD_CONTENT_LIMIT,
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
  it("truncates normal message content to the platform limit", () => {
    const body = toDiscordMessage({ text: "z".repeat(DISCORD_CONTENT_LIMIT + 500) });
    expect((body["content"] as string).length).toBe(DISCORD_CONTENT_LIMIT);
    expect((body["content"] as string).endsWith("…")).toBe(true);
    expect(body["embeds"]).toBeUndefined();
  });

  it("renders links as copyable normal text", () => {
    const body = toDiscordMessage({
      text: "Result",
      links: [{ label: "artifact", url: "https://example.invalid/a" }],
    });
    expect(body["content"]).toBe("Result\n\nartifact: https://example.invalid/a");
  });

  it("always suppresses mentions", () => {
    expect(toDiscordMessage({ text: "@everyone ship it" })["allowed_mentions"]).toEqual({
      parse: [],
    });
  });

  it("posts the already-rendered semantic fallback as normal text", () => {
    const body = toDiscordMessage({
      text: "✅ 進行中のタスク\n\n2件です。\n\n確認待ち\n- ✋ 計画承認待ち — deploy",
      title: "進行中のタスク",
      summary: "2件です。",
      tone: "success",
      sections: [{ title: "確認待ち", bullets: ["✋ 計画承認待ち — deploy"] }],
    });
    expect(body["content"]).toBe(
      "✅ 進行中のタスク\n\n2件です。\n\n確認待ち\n- ✋ 計画承認待ち — deploy",
    );
    expect(body["embeds"]).toBeUndefined();
  });
});
