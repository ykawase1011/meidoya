import {
  allHandlersFinished,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  defineUpdate,
  ParentClosePolicy,
  setHandler,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";
import type { EnvironmentId, TaskBrief, TaskId, WorkspaceId } from "@meidoya/domain";

import {
  DEFAULT_CONTINUE_AS_NEW_THRESHOLDS,
  shouldContinueAsNew,
  type ContinueAsNewThresholds,
} from "../continue-as-new.js";
import { crossWorkspaceWorkflowId } from "../workflow-ids.js";
import {
  CrossWorkspaceWorkflow,
  coordinationCompletedSignal,
  type CrossWorkspaceInput,
} from "./cross-workspace.js";

export type HeadMaidInput = {
  environmentId: EnvironmentId;
  coordinationWorkspaceId: WorkspaceId;
  policyRevision: number;
  activeCoordinationTaskIds?: TaskId[];
  pending?: CoordinationRequest[];
  thresholds?: ContinueAsNewThresholds;
};

export type CoordinationRequest = {
  taskId: TaskId;
  brief: TaskBrief;
  targetWorkspaceIds: WorkspaceId[];
  conversationId?: string;
};

export const submitCoordinationUpdate = defineUpdate<TaskId, [CoordinationRequest]>(
  "submitCoordination",
);
export const headMaidRefreshPolicySignal = defineSignal<[number]>("refreshPolicy");
export const cancelCoordinationTaskSignal = defineSignal<[{ taskId: TaskId; reason: string }]>(
  "cancelTask",
);
export const headMaidStateQuery = defineQuery<{
  environmentId: EnvironmentId;
  policyRevision: number;
  activeCoordinationTaskIds: TaskId[];
}>("headMaidState");

function workflowAlreadyStarted(error: unknown): boolean {
  return error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError";
}

export async function HeadMaidWorkflow(input: HeadMaidInput): Promise<void> {
  const thresholds = input.thresholds ?? DEFAULT_CONTINUE_AS_NEW_THRESHOLDS;
  const startedWithPolicyRevision = input.policyRevision;
  const pending: CoordinationRequest[] = [...(input.pending ?? [])];
  const active = new Set<TaskId>(input.activeCoordinationTaskIds ?? []);
  let policyRevision = input.policyRevision;
  let dispatching = 0;

  setHandler(submitCoordinationUpdate, (request) => {
    if (!active.has(request.taskId)) {
      active.add(request.taskId);
      pending.push(request);
    }
    return request.taskId;
  });
  setHandler(headMaidRefreshPolicySignal, (revision) => {
    policyRevision = revision;
  });
  setHandler(cancelCoordinationTaskSignal, ({ taskId }) => {
    active.delete(taskId);
  });
  setHandler(coordinationCompletedSignal, (taskId) => {
    active.delete(taskId);
  });
  setHandler(headMaidStateQuery, () => ({
    environmentId: input.environmentId,
    policyRevision,
    activeCoordinationTaskIds: [...active],
  }));

  const rotation = () =>
    shouldContinueAsNew(
      {
        temporalSuggested: workflowInfo().continueAsNewSuggested,
        historyLength: workflowInfo().historyLength,
        historySizeBytes: workflowInfo().historySize,
        elapsedMs: Date.now() - workflowInfo().startTime.getTime(),
        policyRevision,
        startedWithPolicyRevision,
        pendingHandlers: allHandlersFinished() ? 0 : 1,
        inFlightRequests: dispatching,
      },
      thresholds,
    );

  for (;;) {
    await condition(() => pending.length > 0 || rotation().continueAsNew);

    while (pending.length > 0) {
      const request = pending.shift();
      if (!request) break;
      dispatching += 1;
      try {
        const args: CrossWorkspaceInput = {
          environmentId: input.environmentId,
          coordinationWorkspaceId: input.coordinationWorkspaceId,
          taskId: request.taskId,
          brief: request.brief,
          targetWorkspaceIds: request.targetWorkspaceIds,
          headMaidWorkflowId: workflowInfo().workflowId,
          ...(request.conversationId !== undefined
            ? { conversationId: request.conversationId }
            : {}),
        };
        try {
          const child = await startChild(CrossWorkspaceWorkflow, {
            workflowId: crossWorkspaceWorkflowId(request.taskId),
            args: [args],
            parentClosePolicy: ParentClosePolicy.ABANDON,
          });
          void child.result().then(
            () => active.delete(request.taskId),
            () => active.delete(request.taskId),
          );
        } catch (error) {
          if (!workflowAlreadyStarted(error)) throw error;
          active.delete(request.taskId);
        }
      } finally {
        dispatching -= 1;
      }
    }

    const decision = rotation();
    if (decision.continueAsNew) {
      await condition(() => allHandlersFinished());
      await continueAsNew<typeof HeadMaidWorkflow>({
        environmentId: input.environmentId,
        coordinationWorkspaceId: input.coordinationWorkspaceId,
        policyRevision,
        activeCoordinationTaskIds: [...active],
        pending,
        thresholds,
      });
    }
  }
}
