import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";
import type { PipelineName, WorkspaceId, WorkspacePolicy } from "@meidoya/domain";
import type { GateOverrides } from "@meidoya/checkpoint-policy";
import {
  parseQualityGateCatalog,
  QualityGateConfigError,
  type QualityGateCatalog,
} from "@meidoya/task-engine";
import {
  ModelMappingSchema,
  parseModelPolicy,
  type ModelMapping,
  type ModelPolicy,
} from "@meidoya/model-router";
import type { InteractionConfig } from "@meidoya/interaction-policy";
import type { IngressBinding } from "@meidoya/chat-vercel";
import { NodeProfileSchema } from "@meidoya/node-protocol";
import type { DelegationCapability } from "@meidoya/workspace-scope";

/* -------------------------------------------------------------- schema */

const DurationSchema = z.union([z.string().min(1), z.number().positive()]);

const PipelineSchema = z.enum(["quick", "research", "coding", "scheduled", "cross-workspace"]);
const DelegationCapabilitySchema = z.enum([
  "status.read",
  "task.delegate",
  "task-summary.read",
  "schedule.manage",
]);

const IngressChannelSchema = z.object({
  account: z.string().optional(),
  channel: z.union([z.string(), z.number()]).optional(),
  profile: z.string().optional(),
});

const AgentProfilesSchema = z
  .object({
    maid: z
      .object({
        profile: z.literal("secretary").default("secretary"),
      })
      .default({}),
  })
  .default({});

const WorkspaceConfigSchema = z.object({
  display_name: z.string().optional(),
  kind: z.enum(["execution", "coordination"]).default("execution"),
  maid: z.unknown().optional(),
  ingress: z
    .object({
      slack: IngressChannelSchema.optional(),
      discord: IngressChannelSchema.optional(),
      cli: IngressChannelSchema.optional(),
    })
    .default({}),
  projects: z.record(z.object({ workspace_ref: z.string() })).default({}),
  request_policy: z
    .object({
      quick_soft_deadline: DurationSchema.default("20s"),
      default_pipeline: PipelineSchema.default("coding"),
    })
    .default({}),
  human_gates: z
    .object({
      clarification: z.enum(["never", "when-needed", "always"]).default("when-needed"),
      plan: z.enum(["never", "on-risk", "always"]).default("always"),
      review: z
        .enum(["never", "on-findings", "before-complete", "always"])
        .default("before-complete"),
      side_effect: z.enum(["policy", "always"]).default("policy"),
    })
    .default({}),
  limits: z
    .object({
      max_steps: z.number().int().positive().default(24),
      max_step_visits: z.number().int().positive().default(5),
      max_fix_rounds: z.number().int().positive().default(3),
      max_review_rounds: z.number().int().positive().default(3),
      max_no_progress_rounds: z.number().int().positive().default(2),
      max_parallel_workers: z.number().int().positive().default(3),
      max_model_escalations: z.number().int().nonnegative().default(2),
      max_consecutive_failures: z.number().int().positive().default(3),
      max_wall_time: DurationSchema.default("4h"),
    })
    .default({}),
  /**
   * 06 section 2: the strongest layer. A gate named here cannot be relaxed by
   * the workspace's own `human_gates`, by a one-off task override, or by a
   * plan; it is a floor, never a ceiling.
   */
  security_policy: z
    .object({
      mandatory_gates: z
        .object({
          clarification: z.enum(["never", "when-needed", "always"]).optional(),
          plan: z.enum(["never", "on-risk", "always"]).optional(),
          review: z.enum(["never", "on-findings", "before-complete", "always"]).optional(),
          side_effect: z.enum(["policy", "always"]).optional(),
        })
        .default({}),
    })
    .default({}),
  /**
   * 10 section 2: the operator's allowlist of verification commands. A plan may
   * only SELECT one of these by name.
   *
   * Omitted or empty means NO catalog — never a built-in default. `toQualityGates`
   * returns `undefined`, the workflow pauses the task with
   * `no-quality-gate-catalog`, and nothing is spawned. The catalog also has to
   * agree token for token with the `quality_gates:` of every node that serves the
   * workspace, since the node justifies each selected argv against its own
   * allowlist before spawning it; see docs/design/config.example.yaml.
   */
  quality_gates: z
    .object({
      commands: z
        .array(z.object({ name: z.string().min(1), command: z.string().min(1) }))
        .default([]),
    })
    .default({}),
  execution: z
    .object({
      preferred_profile: z.string().default("mac-restricted"),
      fallback_profiles: z.array(z.string()).default([]),
    })
    .default({}),
});

/**
 * Local policy for each execution node (10 section 6). Not present in
 * config.example.yaml; without an entry a node's registration is refused,
 * because the node's self-report is only ever a claim.
 */
const NodePolicyConfigSchema = z.object({
  profiles: z.array(NodeProfileSchema).default(["mac-restricted"]),
  capabilities: z.array(z.string()).default([]),
  workspaces: z.array(z.string()).default([]),
  max_concurrency: z.number().int().positive().default(4),
  heartbeat_interval: DurationSchema.default("15s"),
});

export const ControlPlaneConfigSchema = z.object({
  schema_version: z.literal(1),
  environment: z.object({
    id: z.string().min(1),
    timezone: z.string().default("UTC"),
    data_dir: z.string().min(1),
  }),
  control_plane: z.object({
    listen: z.object({
      unix_socket: z.string().min(1),
      node_tcp: z
        .object({
          host: z.string().min(1).default("0.0.0.0"),
          port: z.number().int().positive().max(65_535),
          allowed_peers: z.array(z.string().min(1)).min(1).default(["127.0.0.1", "::1"]),
        })
        .optional(),
    }),
    sqlite: z.object({ path: z.string().min(1) }),
    temporal: z.object({
      address: z.string().min(1),
      namespace: z.string().min(1),
      control_task_queue: z.string().min(1),
    }),
  }),
  head_maid: z
    .object({
      enabled: z.boolean().default(false),
      workspace_id: z.string().default("head-maid"),
      runtime: z.unknown().optional(),
      grants: z.record(z.array(DelegationCapabilitySchema)).default({}),
    })
    .optional(),
  agents: AgentProfilesSchema,
  workspaces: z.record(WorkspaceConfigSchema),
  nodes: z.record(NodePolicyConfigSchema).default({}),
  models: z.unknown().optional(),
  model_policy: z.unknown().optional(),
  interaction: z.unknown().optional(),
  schedules: z
    .object({
      default_delivery: z.enum(["always", "on-change", "on-failure", "never"]).default("on-change"),
      default_overlap: z.enum(["skip", "buffer-one", "allow"]).default("skip"),
    })
    .default({}),
});

export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type NodePolicyConfig = z.infer<typeof NodePolicyConfigSchema>;

export class ControlPlaneConfigError extends Error {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "ControlPlaneConfigError";
  }
}

/* -------------------------------------------------------------- parsing */

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDurationMs(value: string | number): number {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new ControlPlaneConfigError(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = DURATION_UNITS[match[2] ?? ""];
  if (unit === undefined) throw new ControlPlaneConfigError(`invalid duration unit: ${value}`);
  return Math.round(amount * unit);
}

export function expandTilde(input: string, home: string = os.homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

export function parseControlPlaneConfig(yamlText: string): ControlPlaneConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new ControlPlaneConfigError(
      `control plane config is not valid YAML: ${(error as Error).message}`,
    );
  }
  const result = ControlPlaneConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ControlPlaneConfigError("control plane config failed validation", result.error.issues);
  }
  return result.data;
}

export function loadControlPlaneConfig(file: string): ControlPlaneConfig {
  return parseControlPlaneConfig(readFileSync(file, "utf8"));
}

/* -------------------------------------------------------------- resolving */

export type ResolvedNodePolicy = NodePolicyConfig & { nodeId: string; heartbeatIntervalMs: number };

export type ResolvedWorkspace = {
  workspaceId: WorkspaceId;
  displayName: string;
  kind: "execution" | "coordination";
  projects: string[];
  policy: WorkspacePolicy;
  /** Mandatory security floor (06 section 2); empty when none is configured. */
  mandatoryGates: GateOverrides;
  /**
   * Operator-configured verification commands. `undefined` means the workspace
   * has NO catalog: verification pauses with `no-quality-gate-catalog`, it does
   * not fall back to `DEFAULT_QUALITY_GATES`.
   */
  qualityGates: QualityGateCatalog | undefined;
};

export type ResolvedControlPlaneConfig = {
  raw: ControlPlaneConfig;
  environmentId: string;
  timezone: string;
  dataDir: string;
  socketPath: string;
  nodeTcp:
    | { readonly host: string; readonly port: number; readonly allowedPeers: readonly string[] }
    | undefined;
  sqlitePath: string;
  temporal: { address: string; namespace: string; controlTaskQueue: string };
  workspaces: ResolvedWorkspace[];
  /** Immutable routing rows: the only thing allowed to decide a workspace. */
  ingressBindings: IngressBinding[];
  nodePolicies: ResolvedNodePolicy[];
  interaction: InteractionConfig | undefined;
  /**
   * Concrete vendor model names for the coordinating roles that run on this
   * host (09 section 4). Parsed here so `models:` is real configuration: the
   * daemon can only build an agent port when it validates.
   */
  modelMapping: ModelMapping | undefined;
  /** Validated logical routing policy; absent retains the documented defaults. */
  modelPolicy: ModelPolicy | undefined;
  /** Named prompt profile used by the top-level ingress Maid. */
  maidAgentProfile: "secretary";
  headMaid:
    | {
        enabled: boolean;
        workspaceId: string;
        grants: Record<string, DelegationCapability[]>;
      }
    | undefined;
};

/** Selects a configured node using the workspace's preferred/fallback profiles. */
export function executionNodeForWorkspace(
  config: ResolvedControlPlaneConfig,
  workspaceId: string,
): string | undefined {
  const workspace = config.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
  if (workspace === undefined || workspace.kind !== "execution") return undefined;
  const profiles = [
    workspace.policy.execution.preferredProfile,
    ...workspace.policy.execution.fallbackProfiles,
  ];
  for (const profile of profiles) {
    const node = config.nodePolicies.find(
      (candidate) =>
        candidate.workspaces.includes(workspaceId) &&
        candidate.profiles.some((candidateProfile) => candidateProfile === profile),
    );
    if (node !== undefined) return node.nodeId;
  }
  return undefined;
}

function toWorkspacePolicy(config: WorkspaceConfig): WorkspacePolicy {
  return {
    requestPolicy: {
      quickSoftDeadlineMs: parseDurationMs(config.request_policy.quick_soft_deadline),
      defaultPipeline: config.request_policy.default_pipeline as PipelineName,
    },
    humanGates: {
      clarification: config.human_gates.clarification,
      plan: config.human_gates.plan,
      review: config.human_gates.review,
      sideEffect: config.human_gates.side_effect,
    },
    limits: {
      maxSteps: config.limits.max_steps,
      maxStepVisits: config.limits.max_step_visits,
      maxFixRounds: config.limits.max_fix_rounds,
      maxReviewRounds: config.limits.max_review_rounds,
      maxNoProgressRounds: config.limits.max_no_progress_rounds,
      maxParallelWorkers: config.limits.max_parallel_workers,
      maxModelEscalations: config.limits.max_model_escalations,
      maxConsecutiveFailures: config.limits.max_consecutive_failures,
      maxWallTimeMs: parseDurationMs(config.limits.max_wall_time),
    },
    execution: {
      preferredProfile: config.execution.preferred_profile,
      fallbackProfiles: config.execution.fallback_profiles,
    },
  };
}

function toMandatoryGates(config: WorkspaceConfig): GateOverrides {
  const m = config.security_policy.mandatory_gates;
  return {
    ...(m.clarification === undefined ? {} : { clarification: m.clarification }),
    ...(m.plan === undefined ? {} : { plan: m.plan }),
    ...(m.review === undefined ? {} : { review: m.review }),
    ...(m.side_effect === undefined ? {} : { "side-effect": m.side_effect }),
  };
}

/**
 * The operator owns every argv that can reach a process. A malformed gate is a
 * hard config error rather than a silent fallback to the defaults, because
 * "silently used something else" is how an allowlist stops being one.
 */
function toQualityGates(
  workspaceId: string,
  config: WorkspaceConfig,
): QualityGateCatalog | undefined {
  const entries = config.quality_gates.commands;
  if (entries.length === 0) return undefined;
  try {
    return parseQualityGateCatalog(entries);
  } catch (error) {
    if (error instanceof QualityGateConfigError) {
      throw new ControlPlaneConfigError(`workspace ${workspaceId}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * `models:` is optional, but a malformed one is a hard error rather than a
 * silent "no runtime": an operator who configured model names and got none
 * would otherwise learn about it from a failed task.
 */
function parseModelMapping(raw: unknown): ModelMapping | undefined {
  if (raw === undefined || raw === null) return undefined;
  const result = ModelMappingSchema.safeParse(raw);
  if (!result.success) {
    throw new ControlPlaneConfigError("`models:` failed validation", result.error.issues);
  }
  return result.data;
}

function parseConfiguredModelPolicy(raw: unknown): ModelPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  try {
    return parseModelPolicy(raw);
  } catch (error) {
    throw new ControlPlaneConfigError("`model_policy:` failed validation", error);
  }
}

/**
 * A CLI ingress row is constrained by its profile, but a binding needs an
 * account or channel to be bindable at all. The CLI's "account" is the local
 * host: the socket is owner-only, so there is no remote CLI account.
 */
export const CLI_ACCOUNT_REF = "local";

function bindingsFor(workspaceId: string, config: WorkspaceConfig): IngressBinding[] {
  const rows: IngressBinding[] = [];
  const push = (
    source: IngressBinding["source"],
    spec: z.infer<typeof IngressChannelSchema> | undefined,
  ): void => {
    if (spec === undefined) return;
    const accountRef = spec.account ?? (source === "cli" ? CLI_ACCOUNT_REF : null);
    const channelRef = spec.channel === undefined ? null : String(spec.channel);
    const profileRef = spec.profile ?? null;
    // A binding constrained on nothing would be a catch-all default workspace.
    if (accountRef === null && channelRef === null && profileRef === null) return;
    rows.push({
      id: `${source}:${workspaceId}`,
      workspaceId,
      source,
      accountRef,
      channelRef,
      profileRef,
      enabled: true,
    });
  };
  push("slack", config.ingress.slack);
  push("discord", config.ingress.discord);
  push("cli", config.ingress.cli);
  return rows;
}

export function resolveControlPlaneConfig(
  config: ControlPlaneConfig,
  home: string = os.homedir(),
): ResolvedControlPlaneConfig {
  const workspaces: ResolvedWorkspace[] = [];
  const ingressBindings: IngressBinding[] = [];

  for (const [workspaceId, workspace] of Object.entries(config.workspaces)) {
    workspaces.push({
      workspaceId,
      displayName: workspace.display_name ?? workspaceId,
      kind: workspace.kind,
      projects: Object.keys(workspace.projects).sort(),
      policy: toWorkspacePolicy(workspace),
      mandatoryGates: toMandatoryGates(workspace),
      qualityGates: toQualityGates(workspaceId, workspace),
    });
    ingressBindings.push(...bindingsFor(workspaceId, workspace));
  }

  const nodePolicies: ResolvedNodePolicy[] = Object.entries(config.nodes).map(
    ([nodeId, policy]) => ({
      ...policy,
      nodeId,
      heartbeatIntervalMs: parseDurationMs(policy.heartbeat_interval),
    }),
  );

  if (config.head_maid?.enabled === true) {
    const coordination = workspaces.find(
      (workspace) => workspace.workspaceId === config.head_maid?.workspace_id,
    );
    if (coordination === undefined || coordination.kind !== "coordination") {
      throw new ControlPlaneConfigError(
        `head_maid.workspace_id ${config.head_maid.workspace_id} must name a coordination workspace`,
      );
    }
    for (const target of Object.keys(config.head_maid.grants)) {
      const workspace = workspaces.find((candidate) => candidate.workspaceId === target);
      if (workspace === undefined || workspace.kind !== "execution") {
        throw new ControlPlaneConfigError(
          `head_maid grant target ${target} must name an execution workspace`,
        );
      }
    }
  }

  return {
    raw: config,
    environmentId: config.environment.id,
    timezone: config.environment.timezone,
    dataDir: expandTilde(config.environment.data_dir, home),
    socketPath: expandTilde(config.control_plane.listen.unix_socket, home),
    nodeTcp:
      config.control_plane.listen.node_tcp === undefined
        ? undefined
        : {
            host: config.control_plane.listen.node_tcp.host,
            port: config.control_plane.listen.node_tcp.port,
            allowedPeers: [...config.control_plane.listen.node_tcp.allowed_peers],
          },
    sqlitePath: expandTilde(config.control_plane.sqlite.path, home),
    temporal: {
      address: config.control_plane.temporal.address,
      namespace: config.control_plane.temporal.namespace,
      controlTaskQueue: config.control_plane.temporal.control_task_queue,
    },
    workspaces: workspaces.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    ingressBindings,
    nodePolicies,
    interaction: config.interaction as InteractionConfig | undefined,
    modelMapping: parseModelMapping(config.models),
    modelPolicy: parseConfiguredModelPolicy(config.model_policy),
    maidAgentProfile: config.agents.maid.profile,
    headMaid:
      config.head_maid === undefined
        ? undefined
        : {
            enabled: config.head_maid.enabled,
            workspaceId: config.head_maid.workspace_id,
            grants: config.head_maid.grants,
          },
  };
}
