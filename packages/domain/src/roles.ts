export type Role = "head-maid" | "maid" | "manager" | "worker";

export type WorkerProfile =
  | "researcher"
  | "implementer"
  | "reviewer"
  | "security-reviewer"
  | "tester"
  | "mechanical-editor";

export type Provider = "codex" | "claude";
export type ModelProfile = "high" | "standard" | "economy";

export type RuntimeProfile = {
  provider: Provider;
  modelProfile: ModelProfile;
};

export type WorkerCapability =
  | "repo.read"
  | "repo.write"
  | "shell"
  | "network"
  | "browser"
  | "package-install"
  | "external-side-effect";

export type WorkerPermissions = {
  repository: "none" | "read" | "write";
  shell: boolean;
  network: boolean;
};

export type ActorSpec =
  | { role: "head-maid" | "maid" | "manager" }
  | { role: "worker"; profile: WorkerProfile };

/** Capability matrix from 04-roles-and-scopes.md section 7. */
export const ROLE_CAPABILITIES: Record<Role, readonly string[]> = {
  "head-maid": [
    "workspace.status.read:grant",
    "workspace.delegate:grant",
    "task.create:coordination",
    "task.answer:coordination",
    "schedule.manage:grant",
    "checkpoint.request",
    "artifact.read:summary",
  ],
  maid: [
    "workspace.status.read:own",
    "task.create:own",
    "task.answer:own",
    "schedule.manage:own",
    "checkpoint.request",
    "artifact.read:summary",
  ],
  manager: [
    "workspace.status.read:own",
    "task.create:child-step",
    "task.answer:request",
    "worker.dispatch",
    "checkpoint.request",
    "artifact.read:full",
  ],
  worker: ["repository.read/write:scoped", "shell:scoped", "artifact.read:scoped"],
};
