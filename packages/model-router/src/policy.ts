import type { RuntimeProfile, WorkerProfile } from "@meidoya/domain";
import { z } from "zod";
import { parseRuntimeKey, type RuntimeKey } from "./model-mapping.js";

const RuntimeKeySchema = z.string().refine((k) => parseRuntimeKey(k) !== undefined, {
  message: "not a <provider>-<profile> key",
}) as z.ZodType<RuntimeKey, z.ZodTypeDef, string>;

const WorkerProfileSchema = z.enum([
  "researcher",
  "implementer",
  "reviewer",
  "security-reviewer",
  "tester",
  "mechanical-editor",
]);

export const WorkerProfilePolicySchema = z
  .object({
    default: RuntimeKeySchema.optional(),
    allowed: z.array(RuntimeKeySchema).min(1),
  })
  .superRefine((policy, ctx) => {
    if (policy.default !== undefined && !policy.allowed.includes(policy.default)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: "default runtime must also appear in allowed",
      });
    }
  });

export const RoleRuntimeSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  profile: z.enum(["high", "standard", "economy"]),
});

export const ModelPolicySchema = z.object({
  roles: z.record(z.enum(["head-maid", "maid", "manager"]), RoleRuntimeSchema),
  worker_profiles: z.record(WorkerProfileSchema, WorkerProfilePolicySchema),
});

export type WorkerProfilePolicy = z.infer<typeof WorkerProfilePolicySchema>;

export type ModelPolicy = {
  readonly roles: Partial<Record<"head-maid" | "maid" | "manager", RuntimeProfile>>;
  readonly workerProfiles: Partial<Record<WorkerProfile, WorkerProfilePolicy>>;
};

/** Normalizes the snake_case `model_policy:` config block into domain shape. */
export function parseModelPolicy(raw: unknown): ModelPolicy {
  const parsed = ModelPolicySchema.parse(raw);
  const roles: Record<string, RuntimeProfile> = {};
  for (const [role, runtime] of Object.entries(parsed.roles)) {
    if (runtime === undefined) continue;
    roles[role] = { provider: runtime.provider, modelProfile: runtime.profile };
  }
  const workerProfiles: Record<string, WorkerProfilePolicy> = {};
  for (const [profile, policy] of Object.entries(parsed.worker_profiles)) {
    if (policy === undefined) continue;
    workerProfiles[profile] = policy;
  }
  return {
    roles: roles as ModelPolicy["roles"],
    workerProfiles: workerProfiles as ModelPolicy["workerProfiles"],
  };
}

export function allowedRuntimes(
  policy: ModelPolicy,
  workerProfile: WorkerProfile,
): readonly RuntimeProfile[] {
  const entry = policy.workerProfiles[workerProfile];
  if (entry === undefined) return [];
  const out: RuntimeProfile[] = [];
  for (const key of entry.allowed) {
    const runtime = parseRuntimeKey(key);
    if (runtime !== undefined) out.push(runtime);
  }
  return out;
}

export function isAllowed(
  policy: ModelPolicy,
  workerProfile: WorkerProfile,
  runtime: RuntimeProfile,
): boolean {
  return allowedRuntimes(policy, workerProfile).some(
    (r) => r.provider === runtime.provider && r.modelProfile === runtime.modelProfile,
  );
}

/** Selects the operator default, then the first allowed runtime, without widening policy. */
export function workerDefaultRuntime(
  policy: ModelPolicy,
  workerProfile: WorkerProfile,
): RuntimeProfile | undefined {
  const entry = policy.workerProfiles[workerProfile];
  if (entry === undefined) return undefined;
  if (entry.default !== undefined) return parseRuntimeKey(entry.default);
  return allowedRuntimes(policy, workerProfile)[0];
}
