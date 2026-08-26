import { z } from "zod";

export const NodePlatformSchema = z.enum(["darwin", "linux"]);
export type NodePlatform = z.infer<typeof NodePlatformSchema>;

export const NodeArchitectureSchema = z.enum(["arm64", "x64"]);
export type NodeArchitecture = z.infer<typeof NodeArchitectureSchema>;

export const NodeProfileSchema = z.enum([
  "mac-restricted",
  "linux-restricted",
  "lima-trusted",
]);
export type NodeProfile = z.infer<typeof NodeProfileSchema>;

export const NodeStatusSchema = z.enum(["online", "draining", "offline"]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const ExecutionNodeSchema = z.object({
  id: z.string(),
  protocolVersion: z.number().int(),
  platform: NodePlatformSchema,
  architecture: NodeArchitectureSchema,
  profile: NodeProfileSchema,
  capabilities: z.array(z.string()),
  allowedWorkspaces: z.array(z.string()),
  maxConcurrency: z.number().int().positive(),
  status: NodeStatusSchema,
});
export type ExecutionNode = z.infer<typeof ExecutionNodeSchema>;

export const NodeRegistrationSchema = z.object({
  nodeId: z.string(),
  nodeVersion: z.string(),
  protocolVersion: z.number().int(),
  platform: NodePlatformSchema,
  arch: NodeArchitectureSchema,
  profile: NodeProfileSchema,
  capabilities: z.array(z.string()),
  workspaceBindings: z.array(z.string()),
  maxConcurrency: z.number().int().positive(),
});
export type NodeRegistration = z.infer<typeof NodeRegistrationSchema>;

export const NodeHeartbeatSchema = z.object({
  nodeId: z.string(),
  status: NodeStatusSchema,
  activeRunCount: z.number().int().nonnegative(),
  timestamp: z.number().int(),
});
export type NodeHeartbeat = z.infer<typeof NodeHeartbeatSchema>;
