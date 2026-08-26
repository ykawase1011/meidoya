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
import { requestWorkflowId } from "../workflow-ids.js";
import { RequestWorkflow, type RequestOrigin, type RequestWorkflowInput } from "./request.js";

/**
 * 02 section 3 / 08 section 3: the resident Maid is a long-lived workflow holding
 * only identity, mailbox, scope, policy revision and active request references —
 * never message bodies or task details.
 */
export type WorkspaceMaidInput = {
  environmentId: EnvironmentId;
  workspaceId: WorkspaceId;
  policyRevision: number;
  /** Carried across Continue-As-New. */
  mailbox?: MailboxEntry[];
  activeRequestKeys?: string[];
  activeTaskIds?: TaskId[];
  thresholds?: ContinueAsNewThresholds;
};

export type MailboxEntry = {
  requestKey: string;
  origin: RequestOrigin;
  /** Reference only; the body stays in SQLite. */
  messageRef: string;
  interpretation?: "auto" | "schedule";
  /** Control-plane-selected node; mailbox callers cannot choose it. */
  executionNodeId?: string;
  conversationId?: string;
  delegation?: {
    brief: TaskBrief;
    childTaskId: TaskId;
    rootTaskId: TaskId;
    coordinationWorkflowId: string;
  };
};

export type MaidState = {
  environmentId: EnvironmentId;
  workspaceId: WorkspaceId;
  policyRevision: number;
  mailboxDepth: number;
  activeRequestKeys: string[];
  activeTaskIds: TaskId[];
};

export type CheckpointAnswerInput = {
  taskId: TaskId;
  checkpointId: string;
  answer: "approved" | "rejected" | "answered";
  text?: string;
};

export const submitMessageUpdate = defineUpdate<string, [MailboxEntry]>("submitMessage");
export const submitCliRequestUpdate = defineUpdate<string, [MailboxEntry]>("submitCliRequest");
export const submitDelegationUpdate = defineUpdate<string, [MailboxEntry]>("submitDelegation");
export const answerCheckpointUpdate = defineUpdate<boolean, [CheckpointAnswerInput]>(
  "answerCheckpoint",
);
export const submitScheduleTriggerSignal = defineSignal<[MailboxEntry]>("submitScheduleTrigger");
export const maidCancelTaskSignal = defineSignal<[{ taskId: TaskId; reason: string }]>("cancelTask");
export const maidRefreshPolicySignal = defineSignal<[number]>("refreshPolicy");
export const maidStateQuery = defineQuery<MaidState>("maidState");

export type PendingAnswer = CheckpointAnswerInput;

function workflowAlreadyStarted(error: unknown): boolean {
  return error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError";
}

export async function WorkspaceMaidWorkflow(input: WorkspaceMaidInput): Promise<void> {
  const thresholds = input.thresholds ?? DEFAULT_CONTINUE_AS_NEW_THRESHOLDS;
  const startedWithPolicyRevision = input.policyRevision;
  const mailbox: MailboxEntry[] = [...(input.mailbox ?? [])];
  const activeRequestKeys = new Set<string>(input.activeRequestKeys ?? []);
  const activeTaskIds = new Set<TaskId>(input.activeTaskIds ?? []);
  const pendingAnswers: PendingAnswer[] = [];
  const cancellations: { taskId: TaskId; reason: string }[] = [];
  let policyRevision = input.policyRevision;
  let dispatching = 0;

  const enqueue = (entry: MailboxEntry): string => {
    if (!activeRequestKeys.has(entry.requestKey)) {
      activeRequestKeys.add(entry.requestKey);
      mailbox.push(entry);
    }
    return entry.requestKey;
  };

  setHandler(submitMessageUpdate, enqueue);
  setHandler(submitCliRequestUpdate, enqueue);
  setHandler(submitDelegationUpdate, enqueue);
  setHandler(submitScheduleTriggerSignal, (entry) => {
    enqueue(entry);
  });
  setHandler(answerCheckpointUpdate, (answer) => {
    if (!activeTaskIds.has(answer.taskId)) return false;
    pendingAnswers.push(answer);
    return true;
  });
  setHandler(maidCancelTaskSignal, (request) => {
    cancellations.push(request);
  });
  setHandler(maidRefreshPolicySignal, (revision) => {
    policyRevision = revision;
  });
  setHandler(maidStateQuery, () => ({
    environmentId: input.environmentId,
    workspaceId: input.workspaceId,
    policyRevision,
    mailboxDepth: mailbox.length,
    activeRequestKeys: [...activeRequestKeys],
    activeTaskIds: [...activeTaskIds],
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
    await condition(
      () =>
        mailbox.length > 0 ||
        pendingAnswers.length > 0 ||
        cancellations.length > 0 ||
        rotation().continueAsNew,
    );

    while (mailbox.length > 0) {
      const entry = mailbox.shift();
      if (!entry) break;
      dispatching += 1;
      try {
        const requestInput: RequestWorkflowInput = {
          environmentId: input.environmentId,
          workspaceId: input.workspaceId,
          requestKey: entry.requestKey,
          origin: entry.origin,
          messageRef: entry.messageRef,
          ...(entry.interpretation === undefined
            ? {}
            : { interpretation: entry.interpretation }),
          ...(entry.executionNodeId === undefined
            ? {}
            : { executionNodeId: entry.executionNodeId }),
          ...(entry.conversationId !== undefined ? { conversationId: entry.conversationId } : {}),
          ...(entry.delegation !== undefined ? { delegation: entry.delegation } : {}),
        };
        // Requests outlive a Continue-As-New of the Maid.
        try {
          const child = await startChild(RequestWorkflow, {
            workflowId: requestWorkflowId(input.workspaceId, entry.requestKey),
            args: [requestInput],
            parentClosePolicy: ParentClosePolicy.ABANDON,
          });
          // Reference only: the Maid never stores the request body or task detail.
          void child.result().then(
            (result) => {
              activeRequestKeys.delete(entry.requestKey);
              if (result.taskId !== undefined) activeTaskIds.delete(result.taskId);
            },
            () => {
              activeRequestKeys.delete(entry.requestKey);
            },
          );
        } catch (error) {
          if (!workflowAlreadyStarted(error)) throw error;
          // An update may be delivered again after the child completed but
          // before the activity that submitted it recorded completion. The
          // original child owns the stable workflow id and its callback/result;
          // the replay is already satisfied and must not kill the resident Maid.
          activeRequestKeys.delete(entry.requestKey);
        }
      } finally {
        dispatching -= 1;
      }
    }

    pendingAnswers.length = 0;
    cancellations.length = 0;

    const decision = rotation();
    if (decision.continueAsNew) {
      // Only after pending handlers drained (08 section 5).
      await condition(() => allHandlersFinished());
      await continueAsNew<typeof WorkspaceMaidWorkflow>({
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        policyRevision,
        mailbox,
        activeRequestKeys: [...activeRequestKeys],
        activeTaskIds: [...activeTaskIds],
        thresholds,
      });
    }
  }
}
