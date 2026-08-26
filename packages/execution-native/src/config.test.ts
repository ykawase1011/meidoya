import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NodeConfigError,
  createSandboxFromConfig,
  parseNodeConfig,
  resolveNodeConfig,
  validateProjectPaths,
} from "./config.js";
import { isDomainAllowed, planLinuxHardening } from "./linux-profile.js";

const EXAMPLE = `
schema_version: 1
node:
  id: mac-main
  profile: mac-restricted
  control_plane: unix://~/.local/share/meidoya/meidoya.sock
  temporal:
    address: 127.0.0.1:7233
    namespace: default
    task_queue: meidoya/node/mac-main
  max_concurrency: 4
workspaces:
  work-it:
    projects:
      product-a:
        path: ~/Workspace/Repositories/product-a
      elsewhere:
        path: ~/elsewhere/product-x
filesystem:
  allowed_roots:
    - ~/Workspace/Repositories
  allow_home_fallback: false
runtimes:
  codex:
    enabled: true
    mode: sdk
    auth: chatgpt-subscription
capabilities:
  - repo.read
  - repo.write
network:
  policy: restricted
  allowed_domains:
    - github.com
`;

let home: string;

beforeEach(() => {
  home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "meidoya-config-")),
  );
  fs.mkdirSync(path.join(home, "Workspace", "Repositories", "product-a"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(home, "elsewhere", "product-x"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("node config", () => {
  it("parses a node.example.yaml-shaped config", () => {
    const config = parseNodeConfig(EXAMPLE);
    expect(config.node.id).toBe("mac-main");
    expect(config.node.profile).toBe("mac-restricted");
    expect(config.filesystem.allow_home_fallback).toBe(false);
    expect(config.capabilities).toEqual(["repo.read", "repo.write"]);
  });

  it("parses the checked-in docs/design/node.example.yaml", () => {
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../docs/design/node.example.yaml",
    );
    const config = parseNodeConfig(fs.readFileSync(file, "utf8"));
    expect(config.node.id).toBe("mac-main");
    expect(config.filesystem.allowed_roots).toContain(
      "~/.local/share/meidoya/worktrees",
    );
  });

  it("rejects allow_home_fallback: true", () => {
    expect(() =>
      parseNodeConfig(EXAMPLE.replace("allow_home_fallback: false", "allow_home_fallback: true")),
    ).toThrow(NodeConfigError);
  });

  it("rejects unknown top-level keys and bad YAML", () => {
    expect(() => parseNodeConfig(`${EXAMPLE}\nsurprise: true\n`)).toThrow(
      NodeConfigError,
    );
    expect(() => parseNodeConfig("::: not yaml :::\n\t- x")).toThrow(
      NodeConfigError,
    );
  });

  it("expands ~ against the configured home and lists workspace bindings", () => {
    const resolved = resolveNodeConfig(parseNodeConfig(EXAMPLE), home);
    expect(resolved.allowedRoots).toEqual([
      path.join(home, "Workspace", "Repositories"),
    ]);
    expect(resolved.workspaceBindings).toEqual(["work-it"]);
  });

  it("drops project paths that fall outside the allowed roots", () => {
    const resolved = resolveNodeConfig(parseNodeConfig(EXAMPLE), home);
    const sandbox = createSandboxFromConfig(resolved);
    const { valid, rejected } = validateProjectPaths(resolved, sandbox);
    expect(Object.keys(valid["work-it"] ?? {})).toEqual(["product-a"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("work-it/elsewhere");
  });

  it("names the workspaces whose binding set was truncated", () => {
    const resolved = resolveNodeConfig(parseNodeConfig(EXAMPLE), home);
    const sandbox = createSandboxFromConfig(resolved);
    const { truncated } = validateProjectPaths(resolved, sandbox);
    // Silence here is the bug: `work-it` configured two projects and only one
    // survived, so anything that infers "the only project" from the survivor
    // would verify (or run) in the wrong checkout.
    expect(truncated["work-it"]).toEqual(["elsewhere"]);
  });

  it("builds lookup maps without a prototype", () => {
    const resolved = resolveNodeConfig(parseNodeConfig(EXAMPLE), home);
    const sandbox = createSandboxFromConfig(resolved);
    const { valid } = validateProjectPaths(resolved, sandbox);
    // `__proto__` as a workspace or project id must MISS, not return
    // Object.prototype and slip past an `=== undefined` guard.
    expect(Object.getPrototypeOf(resolved.workspaceProjects)).toBeNull();
    expect(Object.getPrototypeOf(resolved.workspaceProjects["work-it"])).toBeNull();
    expect(Object.getPrototypeOf(valid)).toBeNull();
    expect(Object.getPrototypeOf(valid["work-it"])).toBeNull();
    expect(resolved.workspaceProjects["__proto__"]).toBeUndefined();
    expect(valid["__proto__"]).toBeUndefined();
  });

  it("carries the node's own quality-gate allowlist, defaulting to none", () => {
    expect(resolveNodeConfig(parseNodeConfig(EXAMPLE), home).qualityGates).toEqual([]);
    const withGates = resolveNodeConfig(
      parseNodeConfig(
        `${EXAMPLE}
quality_gates:
  - name: test
    argv: ["pnpm", "-r", "test"]
`,
      ),
      home,
    );
    // `allow_unsafe` defaults to false: a configured entry is still subject to
    // meidoya-node's structural floor (`assertNodeQualityGatesJustified`).
    expect(withGates.qualityGates).toEqual([
      { name: "test", argv: ["pnpm", "-r", "test"], allowUnsafe: false },
    ]);
    // An entry that cannot be spawned is a config error, not a runtime surprise.
    expect(() =>
      parseNodeConfig(`${EXAMPLE}\nquality_gates:\n  - name: test\n    argv: []\n`),
    ).toThrow(NodeConfigError);
  });
});

describe("linux profile", () => {
  const linuxYaml = (extra: string) =>
    EXAMPLE.replace("profile: mac-restricted", "profile: linux-restricted") + extra;

  it("warns when isolation and read-only rootfs are missing", () => {
    const resolved = resolveNodeConfig(parseNodeConfig(linuxYaml("")), home);
    const plan = planLinuxHardening(resolved);
    expect(plan.warnings.join(" ")).toContain("dedicated OS user");
    expect(plan.readOnlyRootFilesystem).toBe(true);
    expect(plan.writablePaths).toContain("/tmp");
    expect(plan.writablePaths).toContain(
      path.join(home, "Workspace", "Repositories"),
    );
  });

  it("accepts a dedicated user with a read-only root filesystem", () => {
    const resolved = resolveNodeConfig(
      parseNodeConfig(
        linuxYaml(`
linux:
  os_user: meidoya-node
  read_only_root_filesystem: true
  writable_paths:
    - ~/.local/share/meidoya/worktrees
`),
      ),
      home,
    );
    const plan = planLinuxHardening(resolved);
    expect(plan.isolation).toEqual({
      kind: "dedicated-user",
      user: "meidoya-node",
    });
    expect(plan.warnings).toEqual([]);
  });

  it("warns about root and open network policy", () => {
    const resolved = resolveNodeConfig(
      parseNodeConfig(
        linuxYaml(`
linux:
  os_user: root
  read_only_root_filesystem: false
`).replace("policy: restricted", "policy: open"),
      ),
      home,
    );
    const plan = planLinuxHardening(resolved);
    expect(plan.warnings.join(" ")).toContain("must not be root");
    expect(plan.warnings.join(" ")).toContain("read-only root filesystem");
    expect(plan.warnings.join(" ")).toContain("open");
  });

  it("enforces the network allowlist", () => {
    const resolved = resolveNodeConfig(parseNodeConfig(linuxYaml("")), home);
    const plan = planLinuxHardening(resolved);
    expect(isDomainAllowed(plan, "github.com")).toBe(true);
    expect(isDomainAllowed(plan, "api.github.com")).toBe(true);
    expect(isDomainAllowed(plan, "evil.com")).toBe(false);
    expect(isDomainAllowed(plan, "notgithub.com")).toBe(false);
  });
});
