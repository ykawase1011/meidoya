import { describe, expect, it } from "vitest";
import { parseModelPolicy } from "@meidoya/model-router";
import { createModelRouting } from "./routing.js";

describe("control-plane model routing", () => {
  it("uses configured role and worker defaults without widening the allowlist", () => {
    const routing = createModelRouting(
      parseModelPolicy({
        roles: { manager: { provider: "claude", profile: "high" } },
        worker_profiles: {
          implementer: {
            default: "claude-standard",
            allowed: ["claude-standard", "codex-high"],
          },
        },
      }),
    );

    expect(routing.role("ws", "manager")).toEqual({
      provider: "claude",
      modelProfile: "high",
    });
    expect(routing.worker("ws", "implementer")).toEqual({
      runtime: { provider: "claude", modelProfile: "standard" },
      allowedRuntimes: [
        { provider: "claude", modelProfile: "standard" },
        { provider: "codex", modelProfile: "high" },
      ],
    });
  });

  it("falls back to documented Codex defaults when no policy exists", () => {
    const routing = createModelRouting(undefined);
    expect(routing.role("ws", "maid")).toEqual({ provider: "codex", modelProfile: "high" });
    expect(routing.worker("ws", "mechanical-editor").runtime).toEqual({
      provider: "codex",
      modelProfile: "economy",
    });
  });
});
