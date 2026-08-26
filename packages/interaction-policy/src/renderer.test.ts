import { describe, expect, it } from "vitest";
import { render, scrub, truncate } from "./renderer.js";

describe("scrub (07 section 9)", () => {
  it("removes API keys and tokens", () => {
    const text = [
      "key sk-ABCDEFGH12345678abcdef",
      "gh token ghp_abcdefghijklmnopqrstuvwxyz0123",
      "slack xoxb-1234567890-abcdef",
      "aws AKIAIOSFODNN7EXAMPLE",
      "Authorization: Bearer abcdef.ghijkl.mnopqr",
      'password: "hunter2hunter2"',
      "api_key=super-secret-value",
    ].join("\n");
    const out = scrub(text);
    expect(out).not.toMatch(/sk-ABCDEFGH/);
    expect(out).not.toMatch(/ghp_/);
    expect(out).not.toMatch(/xoxb-/);
    expect(out).not.toMatch(/AKIA/);
    expect(out).not.toMatch(/hunter2/);
    expect(out).not.toMatch(/super-secret-value/);
    expect(out).not.toMatch(/Bearer abcdef/);
    expect(out).toContain("[redacted]");
  });

  it("removes absolute filesystem paths but keeps URLs intact", () => {
    const out = scrub(
      "edited /Users/alice/Workspace/meidoya/src/app.ts and ~/.config/meidoya/config.yaml and C:\\Users\\alice\\app.ts; see https://example.com/a/b"
    );
    expect(out).not.toContain("/Users/alice");
    expect(out).not.toContain(".config/meidoya");
    expect(out).not.toContain("C:\\Users");
    expect(out).toContain("[path]");
    expect(out).toContain("https://example.com/a/b");
  });

  it("removes internal IDs", () => {
    const out = scrub("task_01H8 finished checkpoint cp_456 in ws_prod (run 3f2504e0-4f89-11d3-9a0c-0305e82c3301)");
    expect(out).not.toContain("task_01H8");
    expect(out).not.toContain("cp_456");
    expect(out).not.toContain("ws_prod");
    expect(out).not.toContain("3f2504e0");
    expect(out).toContain("[id]");
  });
});

describe("truncate", () => {
  it("respects the per-platform character limit", () => {
    expect(truncate("abcdefghij", 5)).toHaveLength(5);
    expect(truncate("abc", 5)).toBe("abc");
  });

  it("render never exceeds maxChars", () => {
    const msg = render(
      { kind: "result", title: "t", summary: "x".repeat(5000) },
      { maxChars: 200 }
    );
    expect(msg.text.length).toBeLessThanOrEqual(200);
  });
});

describe("templates", () => {
  it("uses Japanese semantic headings and scrubs every structured field", () => {
    const plan = render(
      {
        kind: "plan",
        title: "Refactor",
        bullets: ["read /Users/alice/x/y.ts"],
        sections: [{ title: "Files", bullets: ["write ~/.config/meidoya/config.yaml"] }],
        choices: ["A", "C"],
      },
      { maxChars: 500 }
    );
    expect(plan.text.startsWith("📝 Refactor")).toBe(true);
    expect(plan.title).toBe("Refactor");
    expect(plan.tone).toBe("info");
    expect(plan.text).toContain("[path]");
    expect(plan.sections?.[0]?.bullets[0]).toContain("[path]");
    expect(plan.text).toContain("[A]");

    expect(render({ kind: "review" }, { maxChars: 100 }).title).toBe("レビューの確認");
    const result = render({ kind: "result" }, { maxChars: 100 });
    expect(result.title).toBe("完了");
    expect(result.tone).toBe("success");
    expect(result.text).not.toContain("Result");

    const reply = render(
      { kind: "reply", summary: "こんにちは。\n現在進行中のタスクはありません。" },
      { maxChars: 200 },
    );
    expect(reply.title).toBeUndefined();
    expect(reply.text).toBe("こんにちは。\n現在進行中のタスクはありません。");
    expect(reply.tone).toBe("info");
  });

  it("keeps artifact links out of the scrubber's path rules", () => {
    const msg = render(
      { kind: "result", links: [{ label: "diff", url: "https://artifacts/x/y.patch" }] },
      { maxChars: 500 }
    );
    expect(msg.links?.[0]?.url).toBe("https://artifacts/x/y.patch");
  });
});
