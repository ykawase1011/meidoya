import type {
  Client,
  ScheduleHandle,
  ScheduleOptions,
  ScheduleOptionsStartWorkflowAction,
  ScheduleOverlapPolicy,
  Workflow,
} from "@temporalio/client";
import { ScheduleAlreadyRunning } from "@temporalio/client";
import type { WorkspaceId } from "@meidoya/domain";

import { CONTROL_TASK_QUEUE } from "./task-queues.js";
import { requestWorkflowId, scheduleId } from "./workflow-ids.js";
import type { RequestWorkflowInput } from "./workflows/request.js";

export type MeidoyaScheduleSpec =
  | { kind: "cron"; expressions: string[]; timezone: string }
  | { kind: "interval"; every: string };

export type MeidoyaScheduleDefinition = {
  workspaceId: WorkspaceId;
  environmentId: string;
  executionNodeId?: string;
  name: string;
  spec: MeidoyaScheduleSpec;
  /** Skip, buffer or cancel a still-running previous run — delegated to Temporal. */
  overlap: ScheduleOverlapPolicy;
  messageRef: string;
  conversationId?: string;
  paused?: boolean;
  note?: string;
};

/**
 * 08 section 6: a schedule starts a RequestWorkflow with origin=schedule, so cron
 * work takes the same Maid → Manager → Worker path as a chat message.
 */
export function buildScheduleOptions(
  definition: MeidoyaScheduleDefinition,
): ScheduleOptions {
  const id = scheduleId(definition.workspaceId, definition.name);
  const args: [RequestWorkflowInput] = [
    {
      environmentId: definition.environmentId,
      workspaceId: definition.workspaceId,
      requestKey: definition.name,
      origin: "schedule",
      messageRef: definition.messageRef,
      ...(definition.executionNodeId === undefined
        ? {}
        : { executionNodeId: definition.executionNodeId }),
      ...(definition.conversationId !== undefined
        ? { conversationId: definition.conversationId }
        : {}),
    },
  ];

  return {
    scheduleId: id,
    spec:
      definition.spec.kind === "cron"
        ? { cronExpressions: definition.spec.expressions, timezone: definition.spec.timezone }
        : { intervals: [{ every: definition.spec.every }] },
    policies: { overlap: definition.overlap },
    ...(definition.paused === true ? { state: { paused: true } } : {}),
    action: {
      type: "startWorkflow" as const,
      workflowType: "RequestWorkflow",
      workflowId: requestWorkflowId(definition.workspaceId, definition.name),
      taskQueue: CONTROL_TASK_QUEUE,
      args,
    },
  };
}

export type BackfillWindow = { start: Date; end: Date; overlap?: ScheduleOverlapPolicy };

/** Thin wrapper so schedule control stays in Temporal, not in our own scheduler. */
export class MeidoyaSchedules {
  constructor(private readonly client: Client) {}

  async create(definition: MeidoyaScheduleDefinition): Promise<ScheduleHandle> {
    const options = buildScheduleOptions(definition);
    try {
      return await this.client.schedule.create(options);
    } catch (error) {
      if (!(error instanceof ScheduleAlreadyRunning)) throw error;
      const handle = this.client.schedule.getHandle(options.scheduleId);
      await handle.update(() => ({
        spec: options.spec,
        action: options.action as ScheduleOptionsStartWorkflowAction<Workflow>,
        ...(options.policies === undefined ? {} : { policies: options.policies }),
        state: {
          paused: definition.paused === true,
          ...(definition.note === undefined ? {} : { note: definition.note }),
        },
      }));
      return handle;
    }
  }

  handle(workspaceId: WorkspaceId, name: string): ScheduleHandle {
    return this.client.schedule.getHandle(scheduleId(workspaceId, name));
  }

  async pause(workspaceId: WorkspaceId, name: string, note?: string): Promise<void> {
    await this.handle(workspaceId, name).pause(note);
  }

  async resume(workspaceId: WorkspaceId, name: string, note?: string): Promise<void> {
    await this.handle(workspaceId, name).unpause(note);
  }

  async runNow(workspaceId: WorkspaceId, name: string): Promise<void> {
    await this.handle(workspaceId, name).trigger();
  }

  async backfill(
    workspaceId: WorkspaceId,
    name: string,
    windows: BackfillWindow[],
  ): Promise<void> {
    await this.handle(workspaceId, name).backfill(windows);
  }
}
