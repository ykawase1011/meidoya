import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLI_ACCOUNT_REF,
  executionNodeForWorkspace,
  parseControlPlaneConfig,
  parseDurationMs,
  resolveControlPlaneConfig,
} from "./config.js";

const designDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "design",
);

describe("control plane config", () => {
  it("loads the shipped config.example.yaml", () => {
    const yaml = readFileSync(path.join(designDir, "config.example.yaml"), "utf8");
    const resolved = resolveControlPlaneConfig(parseControlPlaneConfig(yaml), "/home/test");

    expect(resolved.environmentId).toBe("personal");
    expect(resolved.dataDir).toBe("/home/test/.local/share/meidoya");
    expect(resolved.socketPath).toBe("/home/test/.local/share/meidoya/meidoya.sock");
    expect(resolved.temporal.controlTaskQueue).toBe("meidoya/control");
    expect(resolved.workspaces.map((w) => w.workspaceId)).toEqual([
      "head-maid",
      "work-grammarxiv",
      "work-it",
    ]);

    const grammarxiv = resolved.workspaces.find(
      (workspace) => workspace.workspaceId === "work-grammarxiv",
    );
    expect(grammarxiv?.policy.requestPolicy.quickSoftDeadlineMs).toBe(20_000);
    expect(grammarxiv?.policy.limits.maxWallTimeMs).toBe(4 * 60 * 60 * 1000);
    expect(grammarxiv?.policy.humanGates.plan).toBe("always");
    expect(grammarxiv?.projects).toEqual(["grammarxiv"]);
    expect(executionNodeForWorkspace(resolved, "work-grammarxiv")).toBe("mac-main");
    expect(executionNodeForWorkspace(resolved, "work-it")).toBe("mac-main");
    expect(executionNodeForWorkspace(resolved, "head-maid")).toBeUndefined();

    // Every ingress row is constrained, so there is no catch-all workspace.
    for (const binding of resolved.ingressBindings) {
      expect(binding.accountRef !== null || binding.channelRef !== null).toBe(true);
    }
    const cli = resolved.ingressBindings.find((b) => b.source === "cli");
    expect(cli).toMatchObject({
      workspaceId: "head-maid",
      profileRef: "global",
      accountRef: CLI_ACCOUNT_REF,
    });
    expect(resolved.headMaid?.grants["work-it"]).toEqual([
      "status.read",
      "task.delegate",
      "task-summary.read",
    ]);
    expect(resolved.modelPolicy?.roles.maid).toEqual({
      provider: "codex",
      modelProfile: "high",
    });
    expect(resolved.maidAgentProfile).toBe("secretary");
    expect(resolved.modelPolicy?.workerProfiles.implementer?.default).toBe("claude-standard");
  });

  it("parses durations the way the config writes them", () => {
    expect(parseDurationMs("20s")).toBe(20_000);
    expect(parseDurationMs("4h")).toBe(14_400_000);
    expect(parseDurationMs("500ms")).toBe(500);
    expect(() => parseDurationMs("soon")).toThrow(/invalid duration/);
  });

  it("resolves an optional loopback-filtered node TCP listener", () => {
    const yaml = readFileSync(path.join(designDir, "config.example.yaml"), "utf8").replace(
      "    unix_socket: ~/.local/share/meidoya/meidoya.sock",
      [
        "    unix_socket: ~/.local/share/meidoya/meidoya.sock",
        "    node_tcp:",
        "      host: 0.0.0.0",
        "      port: 47777",
        "      allowed_peers: [127.0.0.1, '::1']",
      ].join("\n"),
    );
    const resolved = resolveControlPlaneConfig(parseControlPlaneConfig(yaml), "/home/test");
    expect(resolved.nodeTcp).toEqual({
      host: "0.0.0.0",
      port: 47777,
      allowedPeers: ["127.0.0.1", "::1"],
    });
  });

  it("rejects a config without a schema version", () => {
    expect(() => parseControlPlaneConfig("environment: {}\n")).toThrow(/failed validation/);
  });

  it("requires an enabled Head Maid to name a coordination workspace", () => {
    const yaml = readFileSync(path.join(designDir, "config.example.yaml"), "utf8").replace(
      "kind: coordination",
      "kind: execution",
    );
    expect(() => resolveControlPlaneConfig(parseControlPlaneConfig(yaml))).toThrow(
      /must name a coordination workspace/,
    );
  });

  it("rejects unknown delegation capabilities at config ingest", () => {
    const yaml = readFileSync(path.join(designDir, "config.example.yaml"), "utf8").replace(
      "- task.delegate",
      "- worker.dispatch",
    );
    expect(() => parseControlPlaneConfig(yaml)).toThrow(/failed validation/);
  });

  it("rejects malformed model policy instead of silently using defaults", () => {
    const yaml = readFileSync(path.join(designDir, "config.example.yaml"), "utf8").replace(
      "default: claude-standard",
      "default: unknown-ultra",
    );
    expect(() => resolveControlPlaneConfig(parseControlPlaneConfig(yaml))).toThrow(
      /model_policy.*failed validation/,
    );
  });

  it("rejects a model-policy default outside its allowlist", () => {
    const yaml = readFileSync(path.join(designDir, "config.example.yaml"), "utf8").replace(
      "default: claude-standard\n      allowed:\n        - codex-high\n        - codex-standard\n        - claude-high\n        - claude-standard",
      "default: claude-standard\n      allowed:\n        - codex-high",
    );
    expect(() => resolveControlPlaneConfig(parseControlPlaneConfig(yaml))).toThrow(
      /model_policy.*failed validation/,
    );
  });
});
