import { describe, expect, it } from "vitest";
import { askCheckpoint, renderCheckpointPrompt, type LineReader } from "./checkpoint.js";

function scriptedReader(answers: string[]): LineReader & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async question(prompt: string): Promise<string> {
      prompts.push(prompt);
      return answers.shift() ?? "";
    },
    close(): void {
      // nothing to release
    },
  };
}

describe("attached CLI checkpoint prompt", () => {
  it("renders exactly the shape from 07 section 7", () => {
    expect(renderCheckpointPrompt("task_123", "plan-approval")).toBe(
      ["Task task_123 is waiting for plan approval.", "", "[A] Approve", "[E] Add instruction", "[C] Cancel", "> "].join(
        "\n",
      ),
    );
  });

  it("accepts A, E and C", async () => {
    expect(await askCheckpoint(scriptedReader(["A"]), "t", "plan-approval")).toEqual({
      action: "approve",
    });
    expect(await askCheckpoint(scriptedReader(["c"]), "t", "plan-approval")).toEqual({
      action: "cancel",
    });
    expect(await askCheckpoint(scriptedReader(["E", "use pnpm"]), "t", "plan-approval")).toEqual({
      action: "instruct",
      text: "use pnpm",
    });
  });

  it("re-prompts on an unrecognised answer", async () => {
    const reader = scriptedReader(["what?", "A"]);
    expect(await askCheckpoint(reader, "t", "review-approval")).toEqual({ action: "approve" });
    expect(reader.prompts).toHaveLength(2);
  });
});
