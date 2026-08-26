import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ReviewFindings } from "@meidoya/domain";
import type { RunRequest } from "@meidoya/node-protocol";
import { nodeCredentialFilePath } from "../client-credentials.js";
import { FAILING_QUALITY_GATE_NAME } from "./harness.js";
import {
  FakeNodeRuntime,
  loadNodeConfig,
  startNode,
  type StartedNode,
} from "meidoya-node";

export function nodeConfigYaml(
  dataDir: string,
  workspaces: string[],
  temporalAddress: string,
): string {
  const repos = path.join(dataDir, "repos");
  const blocks = workspaces
    .map(
      (workspaceId) => `  ${workspaceId}:
    projects:
      ${workspaceId}-project:
        path: ${path.join(repos, workspaceId)}`,
    )
    .join("\n");
  return `schema_version: 1

node:
  id: mac-main
  profile: lima-trusted
  control_plane: unix://${path.join(dataDir, "meidoya.sock")}
  temporal:
    address: ${temporalAddress}
    namespace: default
    task_queue: meidoya/node/mac-main
  max_concurrency: 2

workspaces:
${blocks}

filesystem:
  allowed_roots:
    - ${repos}
  allow_home_fallback: false

runtimes:
  codex:
    enabled: false
    mode: sdk
    auth: none

capabilities:
  - repo.read
  - repo.write
  - shell

# This node's OWN allowlist. A verification activity carries the workspace's
# catalog, which the control plane owns; the node spawns an argv only when it can
# independently justify it (10 section 6), exactly as capabilities are an
# intersection. This list is not optional: a node with no \`quality_gates\` refuses
# every argv, because a denylist of dangerous forms was repeatedly bypassed and
# the floor is now deny-by-default. It matches the workspace catalog the daemon
# harness writes (\`PASSING_QUALITY_GATE\`), argv for argv.
quality_gates:
  - name: test
    argv:
      - "${process.execPath}"
      - "--version"
  - name: ${FAILING_QUALITY_GATE_NAME}
    argv:
      - "${process.execPath}"
      - "--no-such-flag"
`;
}

/**
 * Starts the real meidoya-node app against a fake agent runtime, so the demo and
 * the integration tests exercise node registration, sandboxing and the per-node
 * task queue without any Codex/Claude binary.
 */
export async function startTestNode(options: {
  dataDir: string;
  temporalAddress: string;
  workspaces: string[];
  reviewFindingsByWorkspace?: Readonly<Record<string, ReviewFindings>>;
}): Promise<StartedNode & { runtime: FakeNodeRuntime }> {
  const repos = path.join(options.dataDir, "repos");
  for (const workspaceId of options.workspaces) {
    mkdirSync(path.join(repos, workspaceId), { recursive: true });
  }
  const configFile = path.join(options.dataDir, "node.yaml");
  writeFileSync(
    configFile,
    nodeConfigYaml(options.dataDir, options.workspaces, options.temporalAddress),
  );

  // The node's registration token, exactly as a real deployment hands it over:
  // the daemon provisioned a 0600 file under its data dir, and whoever launches
  // the node points the process at it. Nothing in the node's own config can
  // supply it — the config is the claim the token authenticates.
  process.env["MEIDOYA_NODE_TOKEN_FILE"] = nodeCredentialFilePath(options.dataDir, "mac-main");

  const runtime = new FakeNodeRuntime((request: RunRequest) =>
    request.structuredOutputSchemaRef === "ReviewFindings"
      ? options.reviewFindingsByWorkspace?.[request.scope.workspaceId]
      : undefined,
  );
  const node = await startNode({
    resolved: loadNodeConfig(configFile),
    runtime,
  });
  return Object.assign(node, { runtime });
}
