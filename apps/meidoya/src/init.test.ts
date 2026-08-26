import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCodexModel, initializeLocalConfig, portableId } from "./init.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "meidoya-init-test-"));
  directories.push(directory);
  return directory;
}

describe("local initialization", () => {
  it("generates paired control-plane and node configs", () => {
    const root = temporaryDirectory();
    const projectPath = path.join(root, "My Project");
    mkdirSync(projectPath);
    const result = initializeLocalConfig(
      {
        projectPath,
        configDir: path.join(root, "config"),
        dataDir: path.join(root, "data"),
        nodeId: "Local Mac",
        provider: "codex",
        codexModel: "test-codex-model",
      },
      {},
      root,
    );

    expect(result.workspaceId).toBe("my-project");
    expect(result.nodeId).toBe("local-mac");
    expect(readFileSync(result.configFile, "utf8")).toContain('nodes:\n  "local-mac":');
    expect(readFileSync(result.configFile, "utf8")).toContain("high: \"test-codex-model\"");
    expect(readFileSync(result.configFile, "utf8")).toContain("profile: secretary");
    expect(readFileSync(result.nodeConfigFile, "utf8")).toContain(
      `path: ${JSON.stringify(projectPath)}`,
    );
  });

  it("refuses to overwrite existing config unless forced", () => {
    const root = temporaryDirectory();
    const projectPath = path.join(root, "project");
    const configDir = path.join(root, "config");
    mkdirSync(projectPath);
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, "config.yaml"), "existing");
    expect(() =>
      initializeLocalConfig({ projectPath, configDir, provider: "claude" }, {}, root),
    ).toThrow(/--force/);
  });

  it("discovers the configured Codex model and normalizes ids", () => {
    const root = temporaryDirectory();
    mkdirSync(path.join(root, ".codex"));
    writeFileSync(path.join(root, ".codex", "config.toml"), 'model = "gpt-test"\n');
    chmodSync(path.join(root, ".codex", "config.toml"), 0o600);
    expect(discoverCodexModel({}, root)).toBe("gpt-test");
    expect(portableId("  Hello, World!  ", "fallback")).toBe("hello-world");
    expect(portableId("日本語", "fallback")).toBe("fallback");
    expect(portableId("..", "fallback")).toBe("fallback");
  });
});
