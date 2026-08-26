import os from "node:os";
import { z } from "zod";
import { load as parseYaml } from "js-yaml";
import { NodeProfileSchema } from "@meidoya/node-protocol";
import { expandTilde } from "./paths.js";
import { FilesystemSandbox } from "./sandbox.js";

export const NodeConfigSchema = z
  .object({
    schema_version: z.literal(1),
    node: z.object({
      id: z.string().min(1),
      profile: NodeProfileSchema,
      control_plane: z.string().min(1),
      temporal: z.object({
        address: z.string().min(1),
        namespace: z.string().min(1),
        task_queue: z.string().min(1),
      }),
      max_concurrency: z.number().int().positive().max(64),
    }),
    workspaces: z.record(
      z.object({
        projects: z.record(z.object({ path: z.string().min(1) })),
      }),
    ),
    filesystem: z.object({
      allowed_roots: z.array(z.string().min(1)).min(1),
      /** Hard requirement from node.example.yaml: never allow the whole home. */
      allow_home_fallback: z.literal(false),
      allowed_sensitive_paths: z.array(z.string()).default([]),
      mode: z.enum(["allowed-roots", "guest-full"]).default("allowed-roots"),
    }),
    runtimes: z
      .record(
        z.object({
          enabled: z.boolean(),
          mode: z.enum(["sdk", "cli"]),
          auth: z.string(),
        }),
      )
      .default({}),
    capabilities: z.array(z.string()).default([]),
    /**
     * The node operator's OWN quality-gate allowlist.
     *
     * A verification activity arrives carrying the workspace's catalog, which
     * the Control Plane owns. The node does not execute it on that word alone:
     * exactly as capabilities are the INTERSECTION of the control plane's grant
     * and this node's local policy (10 section 6), an argv is only spawned when
     * this node can independently justify it, and listing gates here is the
     * ONLY justification there is.
     *
     * An empty list therefore means no verification runs on this node at all —
     * deny by default, refused loudly per activity (`justifyQualityGate` in
     * meidoya-node). It used to fall back to a structural denylist of known-bad
     * argv shapes, which a review measured at 69 of 75 crafted argvs accepted;
     * that denylist has since been deleted rather than extended, and what a
     * gate can reach once it runs is decided by its environment and by an
     * OS-level confinement (`planGateConfinement`), not by its argv.
     */
    quality_gates: z
      .array(
        z
          .object({
            name: z.string().min(1),
            argv: z.array(z.string().min(1)).min(1),
            /**
             * Accept an argv the structural floor would refuse — one whose
             * program the gate's PATH resolves (`pnpm -r test`), or that names
             * a checkout-relative path (`timeout 60 scripts/gate.sh`).
             *
             * Configuring a gate is NOT on its own a reason to run it: the
             * thing such an argv executes lives in the checkout, and the same
             * task's `implement` step holds `repo.write` over that checkout.
             * The opt-out is per entry and explicit so the risk is a written
             * decision (`meidoya-node` refuses the config at startup
             * otherwise).
             */
            allow_unsafe: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
    /**
     * Extra environment variable names quality gates may see, on top of the
     * minimal PATH/HOME/LANG/TMPDIR set. For build caches and toolchain homes
     * (`CARGO_HOME`, `JAVA_HOME`, `CI`). Credential names are refused here:
     * a gate executes repo-authored code and holds no capability grant.
     */
    quality_gate_env: z.array(z.string().min(1)).default([]),
    /**
     * Network endpoints quality gates may reach, as `host:port` (either half
     * may be `*`). DEFAULT EMPTY, which means a gate gets no network at all:
     * `(deny network*)` in the generated sandbox profile, unix sockets
     * included.
     *
     * Separate from `network:` below on purpose. That one is the AGENT's egress
     * policy, which a run's capability grant backs; a gate holds no capability
     * grant at all, and `network.allowed_domains` cannot be expressed in an OS
     * profile anyway — the kernel filters addresses, not names, so "allow
     * github.com" would have to be written `*:443`, which is the whole internet
     * on the port that matters. An operator who needs a gate to reach a package
     * mirror or a local service writes the address here and can see what they
     * granted.
     */
    quality_gate_network: z.array(z.string().min(1)).default([]),
    network: z
      .object({
        policy: z.enum(["none", "restricted", "open"]),
        allowed_domains: z.array(z.string()).default([]),
      })
      .default({ policy: "none", allowed_domains: [] }),
    linux: z
      .object({
        os_user: z.string().optional(),
        rootless_container: z.boolean().default(false),
        read_only_root_filesystem: z.boolean().default(true),
        writable_paths: z.array(z.string()).default([]),
      })
      .optional(),
  })
  .strict();

export type NodeConfig = z.infer<typeof NodeConfigSchema>;

export class NodeConfigError extends Error {
  constructor(message: string, readonly issues?: unknown) {
    super(message);
    this.name = "NodeConfigError";
  }
}

export function parseNodeConfig(yamlText: string): NodeConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new NodeConfigError(
      `node config is not valid YAML: ${(error as Error).message}`,
    );
  }
  const result = NodeConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new NodeConfigError("node config failed validation", result.error.issues);
  }
  return result.data;
}

export type NodeQualityGate = {
  readonly name: string;
  readonly argv: readonly string[];
  /** Operator's explicit acceptance of an argv the structural floor refuses. */
  readonly allowUnsafe?: boolean;
};

export type ResolvedNodeConfig = {
  config: NodeConfig;
  home: string;
  allowedRoots: string[];
  /**
   * workspaceId -> projectId -> absolute (un-canonicalized) path.
   *
   * Null-prototype at every level: these are lookup maps keyed by ids that
   * arrive from the Control Plane, so `__proto__` (or `constructor`) as a
   * workspace or project id must miss, not return something inherited from
   * `Object.prototype` that then passes an `=== undefined` guard.
   */
  workspaceProjects: Record<string, Record<string, string>>;
  workspaceBindings: string[];
  /** The node operator's own quality-gate allowlist; empty when unconfigured. */
  qualityGates: readonly NodeQualityGate[];
  /** Extra env names gates may see; never a credential (checked at load). */
  qualityGateEnv: readonly string[];
  /** `host:port` endpoints gates may reach; empty means no network at all. */
  qualityGateNetwork: readonly string[];
};

export function resolveNodeConfig(
  config: NodeConfig,
  home: string = os.homedir(),
): ResolvedNodeConfig {
  const allowedRoots = config.filesystem.allowed_roots.map((r) =>
    expandTilde(r, home),
  );
  const workspaceProjects = Object.create(null) as Record<string, Record<string, string>>;
  for (const [workspaceId, workspace] of Object.entries(config.workspaces)) {
    const projects = Object.create(null) as Record<string, string>;
    for (const [projectId, project] of Object.entries(workspace.projects)) {
      projects[projectId] = expandTilde(project.path, home);
    }
    workspaceProjects[workspaceId] = projects;
  }
  return {
    config,
    home,
    allowedRoots,
    workspaceProjects,
    workspaceBindings: Object.keys(config.workspaces).sort(),
    qualityGates: Object.freeze(
      config.quality_gates.map((gate) =>
        Object.freeze({
          name: gate.name,
          argv: Object.freeze([...gate.argv]),
          allowUnsafe: gate.allow_unsafe,
        }),
      ),
    ),
    qualityGateEnv: Object.freeze([...config.quality_gate_env]),
    qualityGateNetwork: Object.freeze([...config.quality_gate_network]),
  };
}

export function createSandboxFromConfig(
  resolved: ResolvedNodeConfig,
  cwd?: string,
): FilesystemSandbox {
  return new FilesystemSandbox({
    allowedRoots: resolved.allowedRoots,
    allowHomeFallback: false,
    explicitlyAllowedSensitivePaths:
      resolved.config.filesystem.allowed_sensitive_paths,
    home: resolved.home,
    ...(cwd === undefined ? {} : { cwd }),
  });
}

export type ValidatedProjectPaths = {
  /** workspaceId -> projectId -> canonical path. Null-prototype maps. */
  valid: Record<string, Record<string, string>>;
  /** Human-readable `workspace/project: reason` lines for every drop. */
  rejected: string[];
  /**
   * workspaceId -> the project ids that were DROPPED for it.
   *
   * A drop is not a detail: a workspace configured with two projects, one of
   * whose paths is missing, collapses to a single valid binding, and anything
   * that infers "the only project" from that set then picks the wrong project
   * silently. Callers must treat a truncated workspace as ambiguous rather than
   * unambiguous — see `resolveVerificationRoot` in meidoya-node.
   */
  truncated: Record<string, string[]>;
};

/**
 * Project paths declared in config must themselves sit inside an allowed root;
 * otherwise the binding is dropped rather than silently widening the sandbox.
 *
 * The drop is reported loudly (`rejected` + `truncated`) precisely because the
 * remaining set is no longer the operator's configured set.
 */
export function validateProjectPaths(
  resolved: ResolvedNodeConfig,
  sandbox: FilesystemSandbox,
): ValidatedProjectPaths {
  const valid = Object.create(null) as Record<string, Record<string, string>>;
  const rejected: string[] = [];
  const truncated = Object.create(null) as Record<string, string[]>;
  for (const [workspaceId, projects] of Object.entries(
    resolved.workspaceProjects,
  )) {
    for (const [projectId, projectPath] of Object.entries(projects)) {
      try {
        const r = sandbox.resolve(projectPath, { mustExist: true });
        const bucket =
          valid[workspaceId] ?? (Object.create(null) as Record<string, string>);
        bucket[projectId] = r.path;
        valid[workspaceId] = bucket;
      } catch (error) {
        rejected.push(
          `${workspaceId}/${projectId}: ${(error as Error).message}`,
        );
        (truncated[workspaceId] ??= []).push(projectId);
      }
    }
  }
  return { valid, rejected, truncated };
}
