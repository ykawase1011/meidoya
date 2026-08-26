import { z } from "zod";

export const ProjectAccessSchema = z.object({
  projectId: z.string(),
  mode: z.enum(["read", "write"]),
});

export const AgentRunScopeSchema = z.object({
  workspaceId: z.string(),
  projectAccess: z.array(ProjectAccessSchema),
  capabilities: z.array(z.string()),
  networkPolicy: z.string(),
  sideEffectPolicy: z.string(),
});
export type AgentRunScope = z.infer<typeof AgentRunScopeSchema>;

export const RunRequestSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  stepId: z.string().optional(),
  role: z.enum(["head-maid", "maid", "manager", "worker"]),
  workerProfile: z.string().optional(),
  provider: z.enum(["codex", "claude"]),
  modelProfile: z.enum(["high", "standard", "economy"]),
  resolvedModel: z.string(),
  scope: AgentRunScopeSchema,
  resumeSessionId: z.string().optional(),
  prompt: z.string(),
  structuredOutputSchemaRef: z
    .enum(["MaidDecision", "ExecutionPlan", "ManagerDecision", "WorkerResult", "ReviewFindings"])
    .optional(),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

export const RunEventSchema = z.object({
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  type: z.enum(["phase", "heartbeat", "log", "session-id"]),
  phase: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.number().int(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunResultSchema = z.object({
  runId: z.string(),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  externalSessionId: z.string().optional(),
  structuredOutput: z.unknown().optional(),
  errorClass: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

export const CancelRequestSchema = z.object({
  runId: z.string(),
  reason: z.string().optional(),
});
export type CancelRequest = z.infer<typeof CancelRequestSchema>;
