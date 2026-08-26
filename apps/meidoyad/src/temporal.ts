import { createRequire } from "node:module";
import path from "node:path";
import type { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";
import { Client as TemporalClient, Connection as TemporalConnection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { TaskBrief, TaskId, WorkspaceId } from "@meidoya/domain";
import {
  CONTROL_TASK_QUEUE,
  MeidoyaSchedules,
  controlWorkerOptions,
  headMaidWorkflowId,
  maidWorkflowId,
  taskWorkflowId,
  type Activities,
  type MeidoyaScheduleDefinition,
} from "@meidoya/workflows-temporal";

const require = createRequire(import.meta.url);

/**
 * Workflow code is bundled from the built workflows entry point of
 * @meidoya/workflows-temporal, so the daemon never re-declares workflow logic.
 */
export function controlWorkflowsPath(): string {
  const entry = require.resolve("@meidoya/workflows-temporal");
  return path.join(path.dirname(entry), "workflows", "index.js");
}

export type MailboxEntry = {
  requestKey: string;
  origin: "chat" | "cli" | "schedule" | "delegation" | "agent";
  messageRef: string;
  interpretation?: "auto" | "schedule";
  executionNodeId?: string;
  conversationId?: string;
  delegation?: {
    brief: TaskBrief;
    childTaskId: string;
    rootTaskId: TaskId;
    coordinationWorkflowId: string;
  };
};

export type CheckpointAnswerSignal = {
  checkpointId: string;
  answer: "approved" | "rejected" | "answered";
  text?: string;
};

export type TaskInstructionSignal = {
  id: string;
  text: string;
};

/** Everything the Control Plane API needs from Temporal, kept injectable. */
export interface WorkflowGateway {
  submitRequest(workspaceId: WorkspaceId, entry: MailboxEntry): Promise<string>;
  submitDelegation(workspaceId: WorkspaceId, entry: MailboxEntry): Promise<string>;
  submitCoordination(input: {
    coordinationWorkspaceId: WorkspaceId;
    taskId: TaskId;
    brief: TaskBrief;
    targetWorkspaceIds: WorkspaceId[];
    conversationId?: string;
  }): Promise<string>;
  answerCheckpoint(
    taskId: string,
    answer: CheckpointAnswerSignal,
    workflowId?: string,
  ): Promise<void>;
  addTaskInstruction(
    taskId: string,
    instruction: TaskInstructionSignal,
    workflowId?: string,
  ): Promise<void>;
  cancelTask(taskId: string, reason: string, workflowId?: string): Promise<void>;
  createSchedule(definition: MeidoyaScheduleDefinition): Promise<void>;
  pauseSchedule(workspaceId: WorkspaceId, name: string): Promise<void>;
  resumeSchedule(workspaceId: WorkspaceId, name: string): Promise<void>;
  triggerSchedule(workspaceId: WorkspaceId, name: string): Promise<void>;
  deleteSchedule(workspaceId: WorkspaceId, name: string): Promise<void>;
}

export type TemporalRuntimeOptions = {
  client: Client;
  connection?: NativeConnection;
  namespace: string;
  environmentId: string;
  activities: Activities;
  maxConcurrentActivityTaskExecutions?: number;
  /**
   * How long a workflow task waits for the worker that last cached it. Kept
   * short so a daemon restart resumes in-flight tasks promptly instead of
   * waiting on a process that is already gone.
   */
  stickyQueueScheduleToStartTimeout?: string;
  /** 0 disables the workflow cache (and with it sticky execution entirely). */
  maxCachedWorkflows?: number;
};

function alreadyStarted(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "WorkflowExecutionAlreadyStartedError" ||
      /already started|already exists/i.test(error.message))
  );
}

export class TemporalWorkflowGateway implements WorkflowGateway {
  readonly #schedules: MeidoyaSchedules;
  readonly #startedMaids = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly environmentId: string,
    private readonly executionNodeForWorkspace?: (workspaceId: WorkspaceId) => string,
  ) {
    this.#schedules = new MeidoyaSchedules(client);
  }

  async #maidHandle(workspaceId: WorkspaceId) {
    const workflowId = maidWorkflowId(this.environmentId, workspaceId);
    if (!this.#startedMaids.has(workflowId)) {
      try {
        await this.client.workflow.start("WorkspaceMaidWorkflow", {
          taskQueue: CONTROL_TASK_QUEUE,
          workflowId,
          args: [{ environmentId: this.environmentId, workspaceId, policyRevision: 1 }],
        });
      } catch (error) {
        if (!alreadyStarted(error)) throw error;
      }
      this.#startedMaids.add(workflowId);
    }
    return { workflowId, handle: this.client.workflow.getHandle(workflowId) };
  }

  /**
   * 02 section 3: the resident Maid is a long-lived workflow. A CLI request is
   * an update into its mailbox, not a direct task start, so every ingress path
   * takes the same Maid -> Manager -> Worker route.
   *
   * The control plane injects the configured execution node into every mailbox
   * entry. It is authority derived from config, never a node id supplied by a
   * CLI, chat message or Manager output.
   */
  async submitRequest(workspaceId: WorkspaceId, entry: MailboxEntry): Promise<string> {
    const { workflowId, handle } = await this.#maidHandle(workspaceId);
    await handle.executeUpdate("submitCliRequest", {
      args: [this.#routeEntry(workspaceId, entry)],
    });
    return workflowId;
  }

  async submitDelegation(workspaceId: WorkspaceId, entry: MailboxEntry): Promise<string> {
    const { workflowId, handle } = await this.#maidHandle(workspaceId);
    await handle.executeUpdate("submitDelegation", {
      args: [this.#routeEntry(workspaceId, entry)],
    });
    return workflowId;
  }

  #routeEntry(workspaceId: WorkspaceId, entry: MailboxEntry): MailboxEntry {
    const executionNodeId = this.executionNodeForWorkspace?.(workspaceId);
    return executionNodeId === undefined ? entry : { ...entry, executionNodeId };
  }

  async submitCoordination(input: {
    coordinationWorkspaceId: WorkspaceId;
    taskId: TaskId;
    brief: TaskBrief;
    targetWorkspaceIds: WorkspaceId[];
    conversationId?: string;
  }): Promise<string> {
    const workflowId = headMaidWorkflowId(this.environmentId);
    try {
      await this.client.workflow.start("HeadMaidWorkflow", {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId,
        args: [
          {
            environmentId: this.environmentId,
            coordinationWorkspaceId: input.coordinationWorkspaceId,
            policyRevision: 1,
          },
        ],
      });
    } catch (error) {
      if (!alreadyStarted(error)) throw error;
    }
    await this.client.workflow.getHandle(workflowId).executeUpdate("submitCoordination", {
      args: [
        {
          taskId: input.taskId,
          brief: input.brief,
          targetWorkspaceIds: input.targetWorkspaceIds,
          ...(input.conversationId === undefined
            ? {}
            : { conversationId: input.conversationId }),
        },
      ],
    });
    return workflowId;
  }

  async answerCheckpoint(
    taskId: string,
    answer: CheckpointAnswerSignal,
    workflowId: string = taskWorkflowId(taskId),
  ): Promise<void> {
    await this.client.workflow.getHandle(workflowId).signal("answerCheckpoint", answer);
  }

  async addTaskInstruction(
    taskId: string,
    instruction: TaskInstructionSignal,
    workflowId: string = taskWorkflowId(taskId),
  ): Promise<void> {
    await this.client.workflow.getHandle(workflowId).signal("addInstruction", instruction);
  }

  async cancelTask(
    taskId: string,
    reason: string,
    workflowId: string = taskWorkflowId(taskId),
  ): Promise<void> {
    await this.client.workflow.getHandle(workflowId).signal("cancelTask", reason);
  }

  async createSchedule(definition: MeidoyaScheduleDefinition): Promise<void> {
    const executionNodeId = this.executionNodeForWorkspace?.(definition.workspaceId);
    await this.#schedules.create(
      executionNodeId === undefined ? definition : { ...definition, executionNodeId },
    );
  }

  async pauseSchedule(workspaceId: WorkspaceId, name: string): Promise<void> {
    await this.#schedules.pause(workspaceId, name);
  }

  async resumeSchedule(workspaceId: WorkspaceId, name: string): Promise<void> {
    await this.#schedules.resume(workspaceId, name);
  }

  async triggerSchedule(workspaceId: WorkspaceId, name: string): Promise<void> {
    await this.#schedules.runNow(workspaceId, name);
  }

  async deleteSchedule(workspaceId: WorkspaceId, name: string): Promise<void> {
    await this.#schedules.handle(workspaceId, name).delete();
  }
}

export const OVERLAP_POLICIES: Record<string, ScheduleOverlapPolicy> = {
  skip: "SKIP",
  "buffer-one": "BUFFER_ONE",
  allow: "ALLOW_ALL",
};

export type TemporalConnections = {
  client: Client;
  /** Worker-side connection; `connection` matches the WorkerOptions field. */
  connection: NativeConnection;
  clientConnection: Connection;
};

export async function connectTemporal(
  address: string,
  namespace: string,
): Promise<TemporalConnections> {
  const clientConnection = await TemporalConnection.connect({ address });
  const connection = await NativeConnection.connect({ address });
  return {
    client: new TemporalClient({ connection: clientConnection, namespace }),
    connection,
    clientConnection,
  };
}

/** Control worker: every workflow plus the SQLite / notification activities. */
export async function createControlWorker(options: TemporalRuntimeOptions): Promise<Worker> {
  return Worker.create({
    stickyQueueScheduleToStartTimeout: options.stickyQueueScheduleToStartTimeout ?? "5 seconds",
    ...(options.maxCachedWorkflows === undefined
      ? {}
      : { maxCachedWorkflows: options.maxCachedWorkflows }),
    ...controlWorkerOptions({
      ...(options.connection === undefined ? {} : { connection: options.connection }),
      namespace: options.namespace,
      activities: options.activities,
      workflowsPath: controlWorkflowsPath(),
      ...(options.maxConcurrentActivityTaskExecutions === undefined
        ? {}
        : { maxConcurrentActivityTaskExecutions: options.maxConcurrentActivityTaskExecutions }),
    }),
  });
}
