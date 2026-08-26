import type { ConversationId, TaskId, WorkspaceId } from "./ids.js";

export type DomainEventType =
  | "RequestAccepted"
  | "TaskStarted"
  | "TaskProgressed"
  | "WaitingClarification"
  | "WaitingPlanApproval"
  | "WaitingReviewApproval"
  | "WaitingSideEffectApproval"
  | "TaskNeedsAttention"
  | "TaskCompleted"
  | "TaskFailed"
  | "ScheduleNoChange"
  | "ScheduleChanged";

export type DomainEvent = {
  id: string;
  taskId: TaskId;
  workspaceId: WorkspaceId;
  type: DomainEventType;
  payload: Record<string, unknown>;
  createdAt: number;
};

export type OutboxAction =
  | "add-reaction"
  | "remove-reaction"
  | "post-thread-message"
  | "update-message";

export type NotificationOutboxStatus = "pending" | "sending" | "sent" | "failed";

export type NotificationOutboxItem = {
  id: string;
  workspaceId: WorkspaceId;
  conversationId?: ConversationId;
  eventId: string;
  action: OutboxAction;
  idempotencyKey: string;
  status: NotificationOutboxStatus;
  attempt: number;
};
