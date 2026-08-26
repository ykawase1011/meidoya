import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type InitOptions = {
  readonly projectPath: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly nodeId?: string;
  readonly configDir?: string;
  readonly dataDir?: string;
  readonly provider?: "codex" | "claude";
  readonly codexModel?: string;
  readonly force?: boolean;
};

export type InitResult = {
  readonly configFile: string;
  readonly nodeConfigFile: string;
  readonly dataDir: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly nodeId: string;
  readonly profile: string;
  readonly provider: "codex" | "claude";
};

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function portableId(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized === "" || !/[a-z0-9]/.test(normalized) ? fallback : normalized;
}

export function discoverCodexModel(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string | undefined {
  const explicit = env["MEIDOYA_MODEL_CODEX_HIGH"] ?? env["MEIDOYA_CODEX_MODEL"];
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  try {
    const config = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    const match = /^\s*model\s*=\s*["']([^"']+)["']\s*$/m.exec(config);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function executableOnPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const directory of (env["PATH"] ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    try {
      accessSync(path.join(directory, name), constants.X_OK);
      return true;
    } catch {
    }
  }
  return false;
}

function selectProvider(
  requested: InitOptions["provider"],
  env: NodeJS.ProcessEnv,
): "codex" | "claude" {
  if (requested !== undefined) return requested;
  if (executableOnPath(env["MEIDOYA_CODEX_BIN"] ?? "codex", env)) return "codex";
  if (executableOnPath(env["MEIDOYA_CLAUDE_BIN"] ?? "claude", env)) return "claude";
  throw new Error("neither codex nor claude is executable; install one or pass --provider");
}

function nodeProfile(platform: NodeJS.Platform): "mac-restricted" | "linux-restricted" {
  if (platform === "darwin") return "mac-restricted";
  if (platform === "linux") return "linux-restricted";
  throw new Error(`local initialization is supported on macOS and Linux, not ${platform}`);
}

function controlPlaneYaml(input: {
  dataDir: string;
  workspaceId: string;
  projectId: string;
  nodeId: string;
  profile: string;
  provider: "codex" | "claude";
  codexModel: string;
}): string {
  const runtime = `${input.provider}-high`;
  return `schema_version: 1

environment:
  id: personal
  timezone: ${yamlString(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}
  data_dir: ${yamlString(input.dataDir)}

control_plane:
  listen:
    unix_socket: ${yamlString(path.join(input.dataDir, "meidoya.sock"))}
  sqlite:
    path: ${yamlString(path.join(input.dataDir, "meidoya.sqlite"))}
  temporal:
    address: 127.0.0.1:7233
    namespace: default
    control_task_queue: meidoya/control

agents:
  maid:
    profile: secretary

workspaces:
  ${yamlString(input.workspaceId)}:
    ingress:
      cli:
        profile: ${yamlString(input.profile)}
    projects:
      ${yamlString(input.projectId)}:
        workspace_ref: ${yamlString(input.projectId)}
    request_policy:
      quick_soft_deadline: 60s
      default_pipeline: quick
    human_gates:
      clarification: when-needed
      plan: never
      review: never
      side_effect: always
    security_policy:
      mandatory_gates:
        side_effect: always
    limits:
      max_steps: 24
      max_step_visits: 5
      max_fix_rounds: 3
      max_review_rounds: 3
      max_no_progress_rounds: 2
      max_parallel_workers: 2
      max_model_escalations: 2
      max_consecutive_failures: 3
      max_wall_time: 4h
    execution:
      preferred_profile: ${nodeProfile(process.platform)}

nodes:
  ${yamlString(input.nodeId)}:
    profiles: [${nodeProfile(process.platform)}]
    capabilities: [repo.read, repo.write, shell, network, package-install, external-side-effect]
    workspaces: [${yamlString(input.workspaceId)}]
    max_concurrency: 2
    heartbeat_interval: 15s

models:
  codex:
    high: ${yamlString(input.codexModel)}
    standard: ${yamlString(input.codexModel)}
    economy: ${yamlString(input.codexModel)}
  claude:
    high: opus
    standard: sonnet
    economy: haiku

model_policy:
  roles:
    maid: { provider: ${input.provider}, profile: high }
    manager: { provider: ${input.provider}, profile: high }
  worker_profiles:
    researcher: { default: ${runtime}, allowed: [${runtime}] }
    implementer: { default: ${runtime}, allowed: [${runtime}] }
    reviewer: { default: ${runtime}, allowed: [${runtime}] }
    security-reviewer: { default: ${runtime}, allowed: [${runtime}] }
    tester: { default: ${runtime}, allowed: [${runtime}] }
    mechanical-editor: { default: ${runtime}, allowed: [${runtime}] }
`;
}

function nodeYaml(input: {
  dataDir: string;
  projectPath: string;
  workspaceId: string;
  projectId: string;
  nodeId: string;
  provider: "codex" | "claude";
}): string {
  const profile = nodeProfile(process.platform);
  return `schema_version: 1

node:
  id: ${yamlString(input.nodeId)}
  profile: ${profile}
  control_plane: ${yamlString(`unix://${path.join(input.dataDir, "meidoya.sock")}`)}
  temporal:
    address: 127.0.0.1:7233
    namespace: default
    task_queue: ${yamlString(`meidoya/node/${input.nodeId}`)}
  max_concurrency: 2

workspaces:
  ${yamlString(input.workspaceId)}:
    projects:
      ${yamlString(input.projectId)}:
        path: ${yamlString(input.projectPath)}

filesystem:
  allowed_roots:
    - ${yamlString(input.projectPath)}
    - ${yamlString(path.join(input.dataDir, "worktrees"))}
  allow_home_fallback: false

runtimes:
  codex:
    enabled: ${String(input.provider === "codex")}
    mode: sdk
    auth: chatgpt-subscription
  claude:
    enabled: ${String(input.provider === "claude")}
    mode: cli
    auth: claude-subscription

capabilities: [repo.read, repo.write, shell, network, package-install, external-side-effect]
quality_gates: []
quality_gate_env: []
quality_gate_network: []

network:
  policy: restricted
  allowed_domains: [github.com, registry.npmjs.org]
`;
}

export function initializeLocalConfig(
  options: InitOptions,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): InitResult {
  const projectPath = path.resolve(options.projectPath);
  try {
    accessSync(projectPath, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(`project path is not readable and writable: ${projectPath}`);
  }

  const projectId = portableId(options.projectId ?? path.basename(projectPath), "project");
  const workspaceId = portableId(options.workspaceId ?? projectId, "workspace");
  const nodeId = portableId(options.nodeId ?? os.hostname(), "local-node");
  const configDir = path.resolve(options.configDir ?? path.join(home, ".config", "meidoya"));
  const dataDir = path.resolve(options.dataDir ?? path.join(home, ".local", "share", "meidoya"));
  const provider = selectProvider(options.provider, env);
  const codexModel = options.codexModel ?? discoverCodexModel(env, home) ?? "unused-codex-model";
  if (provider === "codex" && codexModel === "unused-codex-model") {
    throw new Error(
      "cannot discover a Codex model from ~/.codex/config.toml; pass --codex-model <name>",
    );
  }

  const configFile = path.join(configDir, "config.yaml");
  const nodeConfigFile = path.join(configDir, "node.yaml");
  if (options.force !== true) {
    const existing = [configFile, nodeConfigFile].filter((file) => existsSync(file));
    if (existing.length > 0) {
      throw new Error(`refusing to overwrite ${existing.join(", ")}; pass --force to replace`);
    }
  }

  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(dataDir, "worktrees"), { recursive: true });
  const common = { dataDir, workspaceId, projectId, nodeId, provider };
  writeFileSync(configFile, controlPlaneYaml({ ...common, profile: workspaceId, codexModel }), {
    mode: 0o600,
  });
  writeFileSync(nodeConfigFile, nodeYaml({ ...common, projectPath }), { mode: 0o600 });

  return {
    configFile,
    nodeConfigFile,
    dataDir,
    workspaceId,
    projectId,
    nodeId,
    profile: workspaceId,
    provider,
  };
}
