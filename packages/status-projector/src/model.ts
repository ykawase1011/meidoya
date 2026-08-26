import { z } from "zod";
import {
  ACTIVE_TASK_STATUSES as DOMAIN_ACTIVE_TASK_STATUSES,
  WAITING_TASK_STATUSES as DOMAIN_WAITING_TASK_STATUSES,
} from "@meidoya/domain";

export const ArtifactVisibilitySchema = z.enum(["private", "summary", "user"]);
export type ArtifactVisibility = z.infer<typeof ArtifactVisibilitySchema>;

export const StatusArtifactSchema = z.object({
  artifactId: z.string(),
  kind: z.string(),
  path: z.string(),
  sha256: z.string(),
  visibility: ArtifactVisibilitySchema,
  summary: z.string().optional(),
});
export type StatusArtifact = z.infer<typeof StatusArtifactSchema>;

export const StatusTaskSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  status: z.string(),
  pipeline: z.string(),
  origin: z.string(),
  updatedAt: z.number().int(),
  /** Internal progress: goes to STATUS.md and SQLite/logs, never to chat. */
  currentPhase: z.string().optional(),
  openCheckpoint: z
    .object({ kind: z.string(), prompt: z.string() })
    .optional(),
  artifacts: z.array(StatusArtifactSchema).default([]),
});
export type StatusTask = z.infer<typeof StatusTaskSchema>;

export const StatusScheduleSchema = z.object({
  scheduleId: z.string(),
  name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  delivery: z.string(),
  lastRunAt: z.number().int().optional(),
  lastOutcome: z.string().optional(),
});
export type StatusSchedule = z.infer<typeof StatusScheduleSchema>;

export const StatusNodeSchema = z.object({
  nodeId: z.string(),
  profile: z.string(),
  platform: z.string(),
  status: z.enum(["online", "draining", "offline"]),
  activeRunCount: z.number().int().nonnegative(),
  maxConcurrency: z.number().int().positive(),
  allowedWorkspaces: z.array(z.string()).default([]),
});
export type StatusNode = z.infer<typeof StatusNodeSchema>;

export const StatusWorkspaceSchema = z.object({
  workspaceId: z.string(),
  displayName: z.string(),
  tasks: z.array(StatusTaskSchema).default([]),
  schedules: z.array(StatusScheduleSchema).default([]),
});
export type StatusWorkspace = z.infer<typeof StatusWorkspaceSchema>;

export const StatusSnapshotSchema = z.object({
  environmentId: z.string(),
  /** Epoch ms; rendered in UTC so the output is host-independent. */
  generatedAt: z.number().int(),
  workspaces: z.array(StatusWorkspaceSchema).default([]),
  nodes: z.array(StatusNodeSchema).default([]),
});
export type StatusSnapshot = z.infer<typeof StatusSnapshotSchema>;

export const ACTIVE_TASK_STATUSES = new Set<string>(DOMAIN_ACTIVE_TASK_STATUSES);

export const WAITING_TASK_STATUSES = new Set<string>(DOMAIN_WAITING_TASK_STATUSES);
