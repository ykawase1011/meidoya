import type { EnvironmentId, ProjectId, WorkspaceId } from "./ids.js";

export type Environment = {
  id: EnvironmentId;
  timezone: string;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceKind = "execution" | "coordination";
export type WorkspaceStatus = "active" | "suspended" | "retired";

export type Workspace = {
  id: WorkspaceId;
  environmentId: EnvironmentId;
  kind: WorkspaceKind;
  displayName: string;
  status: WorkspaceStatus;
  policy: WorkspacePolicy;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type Project = {
  id: ProjectId;
  workspaceId: WorkspaceId;
  displayName: string;
  workspaceRef: string;
  createdAt: number;
};

export type HumanGateSetting =
  | { kind: "clarification"; mode: "never" | "when-needed" | "always" }
  | { kind: "plan"; mode: "never" | "on-risk" | "always" }
  | {
      kind: "review";
      mode: "never" | "on-findings" | "before-complete" | "always";
    }
  | { kind: "side-effect"; mode: "policy" | "always" };

export type ExecutionBudget = {
  maxSteps: number;
  maxStepVisits: number;
  maxFixRounds: number;
  maxReviewRounds: number;
  maxNoProgressRounds: number;
  maxParallelWorkers: number;
  maxModelEscalations: number;
  maxConsecutiveFailures: number;
  maxWallTimeMs: number;
};

export type WorkspacePolicy = {
  requestPolicy: {
    quickSoftDeadlineMs: number;
    defaultPipeline: PipelineName;
  };
  humanGates: {
    clarification: "never" | "when-needed" | "always";
    plan: "never" | "on-risk" | "always";
    review: "never" | "on-findings" | "before-complete" | "always";
    sideEffect: "policy" | "always";
  };
  limits: ExecutionBudget;
  execution: {
    preferredProfile: string;
    fallbackProfiles: string[];
  };
};

export type PipelineName =
  | "quick"
  | "research"
  | "coding"
  | "scheduled"
  | "cross-workspace";
