import type {
  ArtifactId,
  ConversationId,
  ProjectId,
  StepId,
  TaskId,
  WorkspaceId,
} from "./ids.js";
import type { PipelineName } from "./environment.js";
import type { ModelProfile, Provider, WorkerProfile } from "./roles.js";

export type TaskOrigin = "chat" | "cli" | "schedule" | "delegation" | "agent";

export type TaskStatus =
  | "received"
  | "planning"
  | "waiting_clarification"
  | "waiting_plan_approval"
  | "running"
  | "verifying"
  | "reviewing"
  | "waiting_review_approval"
  | "waiting_user_input"
  | "waiting_side_effect_approval"
  | "needs_attention"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskListView = "open" | "waiting" | "closed" | "all";

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  "received",
  "planning",
  "running",
  "verifying",
  "reviewing",
];

export const WAITING_TASK_STATUSES: readonly TaskStatus[] = [
  "waiting_clarification",
  "waiting_plan_approval",
  "waiting_review_approval",
  "waiting_user_input",
  "waiting_side_effect_approval",
  "needs_attention",
];

export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"];

export type TaskBrief = {
  summary: string;
  projects: ProjectId[];
  origin: TaskOrigin;
};

export type MaidDecision =
  | { type: "administrative"; command: AdminCommand }
  | { type: "quick"; brief: TaskBrief }
  | { type: "durable"; brief: TaskBrief }
  | { type: "answer_question"; taskId: TaskId; questionId: string; answer: string }
  | { type: "ask_user"; question: string }
  | { type: "out_of_scope"; reason: string };

export type AdminCommand =
  | { kind: "task.list"; view?: TaskListView }
  | { kind: "task.get"; taskId: TaskId }
  | { kind: "task.cancel"; taskId: TaskId }
  | { kind: "schedule.list" }
  | {
      kind: "schedule.create";
      name: string;
      cron: string;
      timezone: string;
      title: string;
      summary: string;
      projects: ProjectId[];
      delivery: "always" | "on-change";
      overlap: "skip" | "buffer-one" | "allow";
      enabled: boolean;
    }
  | { kind: "schedule.pause"; scheduleId: string }
  | { kind: "schedule.resume"; scheduleId: string };

export type ProjectAccess = {
  projectId: ProjectId;
  mode: "read" | "write";
};

export type PlannedStep = {
  key: string;
  kind: "investigate" | "implement" | "test" | "review" | "other";
  description: string;
  workerProfile: WorkerProfile;
  dependsOn: string[];
};

/**
 * A verification plan SELECTS operator-configured quality gates by name.
 * The plan never carries an argv or a command line: see
 * `@meidoya/task-engine`'s quality-gates module (10 section 2).
 */
export type VerificationCommandSelection = {
  /** Name of a configured quality gate, optionally `group:gate`. */
  name: string;
  /**
   * @deprecated Legacy free-form command line. Ignored everywhere: it is never
   * parsed, never resolved and never executed. Rejected at agent ingest.
   */
  command?: string;
};

export type VerificationPlan = {
  commands: VerificationCommandSelection[];
};

export type ExecutionPlan = {
  summary: string;
  risk: "low" | "medium" | "high";
  projects: ProjectAccess[];
  steps: PlannedStep[];
  expectedArtifacts: string[];
  verification: VerificationPlan;
};

export type ArtifactRef = {
  artifactId: ArtifactId;
  kind: string;
  path: string;
  sha256: string;
};

export type EvidenceRef = {
  kind: "command-output" | "test-report" | "diff" | "log";
  artifactId: ArtifactId;
};

export type WorkerResult =
  | { type: "completed"; summary: string; artifacts: ArtifactRef[]; evidence: EvidenceRef[] }
  | { type: "blocked"; reason: string; proposedQuestion?: string }
  | { type: "failed"; errorClass: string; retryable: boolean };

export type ReviewFinding = {
  id: string;
  severity: "blocking" | "major" | "minor" | "note";
  summary: string;
  location?: string;
};

export type ReviewFindings = {
  findings: ReviewFinding[];
};

export type ManagerDecision =
  | { type: "complete" }
  | { type: "fix"; findingIds: string[] }
  | { type: "additional_review" }
  | { type: "request_checkpoint"; checkpointKind: HumanCheckpointKind; prompt: string }
  | { type: "abort"; reason: string };

export type HumanCheckpointKind =
  | "clarification"
  | "plan-approval"
  | "review-approval"
  | "side-effect-approval"
  | "limit-exceeded";

export type CheckpointChoice = {
  id: string;
  label: string;
};

export type HumanCheckpoint = {
  id: string;
  taskId: TaskId;
  kind: HumanCheckpointKind;
  status: "pending" | "approved" | "rejected" | "answered" | "expired";
  prompt: string;
  choices: CheckpointChoice[];
  version: number;
};

export type Task = {
  id: TaskId;
  workspaceId: WorkspaceId;
  conversationId?: ConversationId;
  parentTaskId?: TaskId;
  origin: TaskOrigin;
  pipeline: PipelineName;
  title: string;
  intent: TaskBrief;
  status: TaskStatus;
  temporalWorkflowId: string;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type TaskStep = {
  id: StepId;
  taskId: TaskId;
  stepKey: string;
  stepKind: string;
  status: TaskStatus | "pending" | "running" | "succeeded" | "failed" | "skipped";
  visitCount: number;
  attemptCount: number;
  input: unknown;
  output?: unknown;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type AgentRunRole = "head-maid" | "maid" | "manager" | "worker";

export type AgentRun = {
  id: string;
  taskId: TaskId;
  stepId?: StepId;
  role: AgentRunRole;
  workerProfile?: WorkerProfile;
  provider: Provider;
  modelProfile: ModelProfile;
  executionNodeId?: string;
  externalSessionId?: string;
  status: "starting" | "running" | "succeeded" | "failed" | "cancelled";
  attempt: number;
  startedAt?: number;
  completedAt?: number;
};
