import type { ProjectId, Role, StepId, TaskId, WorkspaceId } from "@meidoya/domain";

export type Capability =
  | "workspace.status.read"
  | "workspace.delegate"
  | "workspace.scope.change"
  | "task.create"
  | "task.answer"
  | "schedule.manage"
  | "worker.dispatch"
  | "checkpoint.request"
  | "artifact.read"
  | "repository.read"
  | "repository.write"
  | "shell";

export type ScopeQualifier =
  | "own"
  | "grant"
  | "coordination"
  | "child-step-only"
  | "request-only"
  | "summary"
  | "full"
  | "scoped"
  | "yes"
  | "no";

/** Section 7 matrix, kept as data so the API surface and the docs stay comparable. */
export const ROLE_CAPABILITY_MATRIX: Readonly<
  Record<Capability, Readonly<Record<Role, ScopeQualifier>>>
> = {
  "workspace.status.read": {
    "head-maid": "grant",
    maid: "own",
    manager: "own",
    worker: "no",
  },
  "workspace.delegate": { "head-maid": "grant", maid: "no", manager: "no", worker: "no" },
  "workspace.scope.change": { "head-maid": "no", maid: "no", manager: "no", worker: "no" },
  "task.create": {
    "head-maid": "coordination",
    maid: "own",
    manager: "child-step-only",
    worker: "no",
  },
  "task.answer": {
    "head-maid": "coordination",
    maid: "own",
    manager: "request-only",
    worker: "no",
  },
  "schedule.manage": { "head-maid": "grant", maid: "own", manager: "no", worker: "no" },
  "worker.dispatch": { "head-maid": "no", maid: "no", manager: "yes", worker: "no" },
  "checkpoint.request": { "head-maid": "yes", maid: "yes", manager: "yes", worker: "no" },
  "artifact.read": {
    "head-maid": "summary",
    maid: "summary",
    manager: "full",
    worker: "scoped",
  },
  "repository.read": { "head-maid": "no", maid: "no", manager: "no", worker: "scoped" },
  "repository.write": { "head-maid": "no", maid: "no", manager: "no", worker: "scoped" },
  shell: { "head-maid": "no", maid: "no", manager: "no", worker: "scoped" },
};

export type TaskScope = "coordination" | "own" | "child-step";
export type AnswerScope = "coordination" | "own" | "request";
export type ArtifactDetail = "summary" | "full";

export type StepScope = {
  stepId: StepId;
  workspaceId: WorkspaceId;
  projectId: ProjectId;
};

export type AuthorizationContext = {
  actorWorkspaceId: WorkspaceId;
  targetWorkspaceId?: WorkspaceId;
  delegationGranted?: boolean;
  taskScope?: TaskScope;
  parentTaskId?: TaskId;
  answerScope?: AnswerScope;
  artifactDetail?: ArtifactDetail;
  artifactWorkspaceId?: WorkspaceId;
  stepScope?: StepScope;
  allowedProjects?: readonly ProjectId[];
  repositoryAccess?: "none" | "read" | "write";
  shellAllowed?: boolean;
};

export type DenyReason =
  | "capability-not-in-role"
  | "target-workspace-not-own"
  | "no-delegation-grant"
  | "task-scope-not-allowed"
  | "answer-scope-not-allowed"
  | "parent-task-required"
  | "artifact-detail-not-allowed"
  | "step-scope-required"
  | "step-workspace-mismatch"
  | "project-not-allowed"
  | "repository-permission-missing"
  | "shell-permission-missing"
  | "capability-forbidden-for-everyone";

export type AuthorizationDecision =
  | { allowed: true; qualifier: ScopeQualifier }
  | { allowed: false; reason: DenyReason; message: string };
