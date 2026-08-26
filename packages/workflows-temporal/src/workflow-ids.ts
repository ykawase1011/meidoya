import type { EnvironmentId, TaskId, WorkspaceId } from "@meidoya/domain";

export function environmentWorkflowId(environmentId: EnvironmentId): string {
  return `environment/${environmentId}`;
}

export function headMaidWorkflowId(environmentId: EnvironmentId): string {
  return `head-maid/${environmentId}`;
}

/** 08 section 3. */
export function maidWorkflowId(
  environmentId: EnvironmentId,
  workspaceId: WorkspaceId,
): string {
  return `maid/${environmentId}/${workspaceId}`;
}

export function requestWorkflowId(workspaceId: WorkspaceId, requestKey: string): string {
  return `request/${workspaceId}/${requestKey}`;
}

export function taskWorkflowId(taskId: TaskId): string {
  return `task/${taskId}`;
}

export function crossWorkspaceWorkflowId(taskId: TaskId): string {
  return `cross-workspace/${taskId}`;
}

export function scheduleId(workspaceId: WorkspaceId, name: string): string {
  return `schedule/${workspaceId}/${name}`;
}
