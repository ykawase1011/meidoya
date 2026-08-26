import type { ModelProfile, Provider, RuntimeProfile } from "@meidoya/domain";
import { z } from "zod";

/**
 * 09 section 4: the ONLY layer allowed to know concrete vendor model names.
 * Domain logic speaks in logical profiles (high / standard / economy); the
 * names come from the operator's `models:` config block at runtime.
 */
export const MODEL_PROFILES: readonly ModelProfile[] = ["high", "standard", "economy"];
export const PROVIDERS: readonly Provider[] = ["codex", "claude"];

export const ProviderModelMapSchema = z.object({
  high: z.string().min(1),
  standard: z.string().min(1),
  economy: z.string().min(1),
});

export const ModelMappingSchema = z.object({
  codex: ProviderModelMapSchema,
  claude: ProviderModelMapSchema,
});

export type ModelMapping = z.infer<typeof ModelMappingSchema>;

export function parseModelMapping(raw: unknown): ModelMapping {
  return ModelMappingSchema.parse(raw);
}

export function resolveModel(mapping: ModelMapping, runtime: RuntimeProfile): string {
  return mapping[runtime.provider][runtime.modelProfile];
}

/** `codex-high` style key used by `model_policy.worker_profiles[*].allowed`. */
export type RuntimeKey = `${Provider}-${ModelProfile}`;

export function runtimeKey(runtime: RuntimeProfile): RuntimeKey {
  return `${runtime.provider}-${runtime.modelProfile}`;
}

export function parseRuntimeKey(key: string): RuntimeProfile | undefined {
  const [provider, modelProfile] = key.split("-");
  if (provider === undefined || modelProfile === undefined) return undefined;
  if (!PROVIDERS.includes(provider as Provider)) return undefined;
  if (!MODEL_PROFILES.includes(modelProfile as ModelProfile)) return undefined;
  return { provider: provider as Provider, modelProfile: modelProfile as ModelProfile };
}
