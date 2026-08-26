import {
  ParentClosePolicy,
  executeChild,
  getExternalWorkflowHandle,
  proxyActivities,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type { EnvironmentId, PipelineName, TaskBrief, TaskId, WorkspaceId } from "@meidoya/domain";
import { handleMaidDecision } from "@meidoya/task-engine";

import type { Activities, AdministrativeCommandResult } from "../activities.js";
import { MANAGER_ACTIVITY_OPTIONS, NOTIFICATION_ACTIVITY_OPTIONS } from "../retry-policies.js";
import { requestUpdateId } from "../idempotency.js";
import { taskWorkflowId } from "../workflow-ids.js";
import { childCompletedSignal } from "./cross-workspace.js";
import { TaskWorkflow, type TaskWorkflowInput } from "./task.js";

export type RequestOrigin = "chat" | "cli" | "schedule" | "delegation" | "agent";

export type RequestWorkflowInput = {
  environmentId: EnvironmentId;
  workspaceId: WorkspaceId;
  requestKey: string;
  origin: RequestOrigin;
  messageRef: string;
  conversationId?: string;
  pipelineHint?: PipelineName;
  interpretation?: "auto" | "schedule";
  executionNodeId?: string;
  delegation?: {
    brief: TaskBrief;
    childTaskId: TaskId;
    rootTaskId: TaskId;
    coordinationWorkflowId: string;
  };
};

export type RequestWorkflowResult = {
  outcome: "administrative" | "responded" | "task" | "answer" | "ask-user" | "rejected";
  taskId?: TaskId;
};

const maid = proxyActivities<Activities>(MANAGER_ACTIVITY_OPTIONS);
const notify = proxyActivities<Activities>(NOTIFICATION_ACTIVITY_OPTIONS);

async function signalDelegationFailure(input: RequestWorkflowInput, summary: string): Promise<void> {
  if (input.delegation === undefined) return;
  await getExternalWorkflowHandle(input.delegation.coordinationWorkflowId).signal(
    childCompletedSignal,
    {
      workspaceId: input.workspaceId,
      childTaskId: input.delegation.childTaskId,
      status: "failed",
      summary,
    },
  );
}

/**
 * One inbound request. A schedule trigger takes exactly this path, so cron work
 * flows through Maid → Manager → Worker like any other request (08 section 6).
 */
export async function RequestWorkflow(
  input: RequestWorkflowInput,
): Promise<RequestWorkflowResult> {
  try {
    return await runRequestWorkflow(input);
  } catch (error) {
    await signalDelegationFailure(input, input.delegation?.brief.summary ?? "request failed");
    throw error;
  }
}

async function runRequestWorkflow(
  input: RequestWorkflowInput,
): Promise<RequestWorkflowResult> {
  const requestKey =
    input.origin === "schedule" ? `${input.requestKey}-${workflowInfo().runId}` : input.requestKey;
  const taskId = input.delegation?.childTaskId ?? `task-${requestKey}`;
  const scheduled =
    input.origin === "schedule"
      ? await maid.materializeScheduledRequest({
          workspaceId: input.workspaceId,
          requestKey,
          messageRef: input.messageRef,
          ...(input.conversationId === undefined
            ? {}
            : { conversationId: input.conversationId }),
        })
      : undefined;
  const { policy } = await maid.loadWorkspacePolicy({ workspaceId: input.workspaceId });

  // A delegation still goes through the TARGET workspace's Maid. That Maid is
  // the only coordinating role with the target's project ids in its prompt;
  // bypassing it left the child brief with no projects, which narrowed every
  // real node run to read-only and made implementation delegations inert.
  const decision = await maid.assessRequest({
    workspaceId: input.workspaceId,
    requestKey,
    origin: input.origin,
    messageRef: input.messageRef,
    interpretation: input.interpretation ?? "auto",
    idempotencyKey: requestUpdateId(input.workspaceId, requestKey),
  });

  const outcome = handleMaidDecision(decision, {
    workspaceKind: "execution",
    defaultPipeline: policy.requestPolicy.defaultPipeline,
    ...(scheduled !== undefined
      ? { pipelineHint: scheduled.pipeline }
      : input.pipelineHint !== undefined
        ? { pipelineHint: input.pipelineHint }
        : {}),
  });

  switch (outcome.kind) {
    case "respond":
      if (input.delegation !== undefined) {
        await signalDelegationFailure(input, "target Maid classified the delegation as conversation");
        return { outcome: "rejected", taskId };
      }
      await notify.finalizeIntakeRequest({
        workspaceId: input.workspaceId,
        taskId,
        status: "completed",
        presentation: "reply",
        eventId: uuid4(),
        summary: outcome.reply.summary,
        ...(outcome.reply.bullets === undefined ? {} : { bullets: outcome.reply.bullets }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      });
      return { outcome: "responded", taskId };

    case "administrative":
      if (input.delegation === undefined) {
        let result: AdministrativeCommandResult;
        try {
          result = await maid.executeAdministrativeCommand({
            workspaceId: input.workspaceId,
            taskId,
            command: outcome.command,
            ...(input.conversationId === undefined
              ? {}
              : { conversationId: input.conversationId }),
          });
        } catch {
          await notify.finalizeIntakeRequest({
            workspaceId: input.workspaceId,
            taskId,
            status: "failed",
            eventId: uuid4(),
            summary: "The administrative request could not be completed.",
            ...(input.conversationId === undefined
              ? {}
              : { conversationId: input.conversationId }),
          });
          return { outcome: "administrative", taskId };
        }
        await notify.finalizeIntakeRequest({
          workspaceId: input.workspaceId,
          taskId,
          status: "completed",
          eventId: uuid4(),
          ...result,
          ...(input.conversationId === undefined
            ? {}
            : { conversationId: input.conversationId }),
        });
        return { outcome: "administrative", taskId };
      }
      await signalDelegationFailure(input, "target Maid classified the delegation as administrative");
      return { outcome: "administrative", taskId };

    case "answer-checkpoint":
      await signalDelegationFailure(input, "target Maid classified the delegation as an answer");
      return { outcome: "answer", taskId: outcome.taskId };

    case "ask-user":
      await notify.finalizeIntakeRequest({
        taskId,
        workspaceId: input.workspaceId,
        eventId: uuid4(),
        status: "failed",
        summary: outcome.question,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      });
      await signalDelegationFailure(input, outcome.question);
      return { outcome: "ask-user", taskId };

    case "rejected":
      await notify.finalizeIntakeRequest({
        taskId,
        workspaceId: input.workspaceId,
        eventId: uuid4(),
        status: "failed",
        summary: outcome.reason,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      });
      await signalDelegationFailure(input, outcome.reason);
      return { outcome: "rejected", taskId };

    case "start-task": {
      const taskInput: TaskWorkflowInput = {
        taskId,
        workspaceId: input.workspaceId,
        environmentId: input.environmentId,
        pipeline: outcome.pipeline,
        lane: outcome.lane,
        brief: outcome.brief,
        policy,
        executionNodeId: input.executionNodeId ?? "mac-main",
        taskVersion: 0,
        ...(input.delegation === undefined ? {} : { rootTaskId: input.delegation.rootTaskId }),
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(outcome.lane === "quick"
          ? {
              quickSoftDeadlineMs: policy.requestPolicy.quickSoftDeadlineMs,
              promoteTo: policy.requestPolicy.defaultPipeline,
            }
          : {}),
      };
      const result = await executeChild(TaskWorkflow, {
        workflowId: taskWorkflowId(taskId),
        args: [taskInput],
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
      if (input.delegation !== undefined) {
        await getExternalWorkflowHandle(input.delegation.coordinationWorkflowId).signal(
          childCompletedSignal,
          {
            workspaceId: input.workspaceId,
            childTaskId: taskId,
            status:
              result.status === "completed"
                ? "completed"
                : result.status === "cancelled"
                  ? "cancelled"
                  : "failed",
            summary: result.summary,
          },
        );
      }
      return { outcome: "task", taskId };
    }
  }
}
