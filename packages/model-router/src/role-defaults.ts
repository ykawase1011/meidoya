import type { ActorSpec, RuntimeProfile, WorkerProfile } from "@meidoya/domain";

/** Task class from 09 section 5, independent of any vendor. */
export type TaskClass =
  | "difficult-design"
  | "normal-implementation"
  | "mechanical-edit"
  | "security-review";

const WORKER_PROFILE_DEFAULTS: Record<WorkerProfile, RuntimeProfile> = {
  researcher: { provider: "codex", modelProfile: "high" },
  implementer: { provider: "codex", modelProfile: "standard" },
  reviewer: { provider: "codex", modelProfile: "high" },
  "security-reviewer": { provider: "codex", modelProfile: "high" },
  tester: { provider: "codex", modelProfile: "standard" },
  "mechanical-editor": { provider: "codex", modelProfile: "economy" },
};

const TASK_CLASS_DEFAULTS: Record<TaskClass, RuntimeProfile> = {
  "difficult-design": { provider: "codex", modelProfile: "high" },
  "normal-implementation": { provider: "codex", modelProfile: "standard" },
  "mechanical-edit": { provider: "codex", modelProfile: "economy" },
  "security-review": { provider: "codex", modelProfile: "high" },
};

/** 09 section 5. Head Maid / Maid / Manager are always Codex at the high profile. */
export function roleDefaultRuntime(actor: ActorSpec, taskClass?: TaskClass): RuntimeProfile {
  if (actor.role !== "worker") return { provider: "codex", modelProfile: "high" };
  if (taskClass !== undefined) return TASK_CLASS_DEFAULTS[taskClass];
  return WORKER_PROFILE_DEFAULTS[actor.profile];
}

export function taskClassDefault(taskClass: TaskClass): RuntimeProfile {
  return TASK_CLASS_DEFAULTS[taskClass];
}
