import type { CheckpointId, TaskId, WorkspaceId } from "@meidoya/domain";

/** 08 section 10: every retried or resent effect carries a stable key. */

export function inboundMessageKey(source: string, externalMessageId: string): string {
  return `inbound:${source}:${externalMessageId}`;
}

export function requestUpdateId(workspaceId: WorkspaceId, requestKey: string): string {
  return `request:${workspaceId}:${requestKey}`;
}

export function taskEventKey(taskId: TaskId, eventType: string, sequence: number): string {
  return `task:${taskId}:${eventType}:${sequence}`;
}

export function agentRunKey(taskId: TaskId, stepKey: string, attempt: number): string {
  return `run:${taskId}:${stepKey}:${attempt}`;
}

export function checkpointKey(checkpointId: CheckpointId, version: number): string {
  return `checkpoint:${checkpointId}:${version}`;
}

export function notificationKey(eventId: string, action: string): string {
  return `notification:${eventId}:${action}`;
}

export function delegationKey(parentTaskId: TaskId, targetWorkspaceId: WorkspaceId): string {
  return `delegation:${parentTaskId}:${targetWorkspaceId}`;
}
