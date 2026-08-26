import type { RuntimeProfile, WorkerProfile, WorkspaceId } from "@meidoya/domain";
import {
  allowedRuntimes,
  roleDefaultRuntime,
  workerDefaultRuntime,
  type ModelPolicy,
} from "@meidoya/model-router";
import type { ActivityDependencies } from "@meidoya/workflows-temporal";

export function createModelRouting(
  policy: ModelPolicy | undefined,
): NonNullable<ActivityDependencies["routing"]> {
  return {
    role(_workspaceId: WorkspaceId, role: "head-maid" | "maid" | "manager"): RuntimeProfile {
      return policy?.roles[role] ?? roleDefaultRuntime({ role });
    },
    worker(_workspaceId: WorkspaceId, workerProfile: WorkerProfile) {
      const fallback = roleDefaultRuntime({ role: "worker", profile: workerProfile });
      const allowed = policy === undefined ? [fallback] : allowedRuntimes(policy, workerProfile);
      if (policy !== undefined && allowed.length === 0) {
        throw new Error(`model_policy has no allowed runtime for worker profile ${workerProfile}`);
      }
      const runtime =
        policy === undefined ? fallback : (workerDefaultRuntime(policy, workerProfile) ?? allowed[0]!);
      return {
        runtime,
        allowedRuntimes: [...allowed],
      };
    },
  };
}
