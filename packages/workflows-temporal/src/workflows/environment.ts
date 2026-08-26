import {
  allHandlersFinished,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  ParentClosePolicy,
  setHandler,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";
import type { EnvironmentId, WorkspaceId } from "@meidoya/domain";

import {
  DEFAULT_CONTINUE_AS_NEW_THRESHOLDS,
  shouldContinueAsNew,
  type ContinueAsNewThresholds,
} from "../continue-as-new.js";
import { maidWorkflowId } from "../workflow-ids.js";
import { WorkspaceMaidWorkflow } from "./workspace-maid.js";

export type EnvironmentInput = {
  environmentId: EnvironmentId;
  workspaceIds: WorkspaceId[];
  policyRevision: number;
  startedWorkspaceIds?: WorkspaceId[];
  thresholds?: ContinueAsNewThresholds;
};

export const addWorkspaceSignal = defineSignal<[WorkspaceId]>("addWorkspace");
export const removeWorkspaceSignal = defineSignal<[WorkspaceId]>("removeWorkspace");
export const environmentRefreshPolicySignal = defineSignal<[number]>("refreshPolicy");
export const environmentStateQuery = defineQuery<{
  environmentId: EnvironmentId;
  workspaceIds: WorkspaceId[];
  residentMaids: WorkspaceId[];
  policyRevision: number;
}>("environmentState");

/** Supervises one resident Maid workflow per Workspace. */
export async function EnvironmentWorkflow(input: EnvironmentInput): Promise<void> {
  const thresholds = input.thresholds ?? DEFAULT_CONTINUE_AS_NEW_THRESHOLDS;
  const startedWithPolicyRevision = input.policyRevision;
  const workspaces = new Set<WorkspaceId>(input.workspaceIds);
  const started = new Set<WorkspaceId>(input.startedWorkspaceIds ?? []);
  let policyRevision = input.policyRevision;

  setHandler(addWorkspaceSignal, (workspaceId) => {
    workspaces.add(workspaceId);
  });
  setHandler(removeWorkspaceSignal, (workspaceId) => {
    workspaces.delete(workspaceId);
    started.delete(workspaceId);
  });
  setHandler(environmentRefreshPolicySignal, (revision) => {
    policyRevision = revision;
  });
  setHandler(environmentStateQuery, () => ({
    environmentId: input.environmentId,
    workspaceIds: [...workspaces],
    residentMaids: [...started],
    policyRevision,
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
      },
      thresholds,
    );

  for (;;) {
    for (const workspaceId of workspaces) {
      if (started.has(workspaceId)) continue;
      await startChild(WorkspaceMaidWorkflow, {
        workflowId: maidWorkflowId(input.environmentId, workspaceId),
        args: [{ environmentId: input.environmentId, workspaceId, policyRevision }],
        // Maids outlive an Environment Continue-As-New.
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
      started.add(workspaceId);
    }

    await condition(
      () =>
        [...workspaces].some((w) => !started.has(w)) ||
        [...started].some((w) => !workspaces.has(w)) ||
        rotation().continueAsNew,
    );

    const decision = rotation();
    if (decision.continueAsNew) {
      await condition(() => allHandlersFinished());
      await continueAsNew<typeof EnvironmentWorkflow>({
        environmentId: input.environmentId,
        workspaceIds: [...workspaces],
        policyRevision,
        startedWorkspaceIds: [...started],
        thresholds,
      });
    }
  }
}
