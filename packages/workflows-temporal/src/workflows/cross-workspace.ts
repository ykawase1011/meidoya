import {
  condition,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type { EnvironmentId, TaskBrief, TaskId, WorkspaceId } from "@meidoya/domain";
import { advancePipeline, getPipeline } from "@meidoya/task-engine";

import type { Activities } from "../activities.js";
import { recordCheckpointAnswer } from "../answer-queue.js";
import { delegationKey } from "../idempotency.js";
import {
  DB_ACTIVITY_OPTIONS,
  MANAGER_ACTIVITY_OPTIONS,
  NOTIFICATION_ACTIVITY_OPTIONS,
} from "../retry-policies.js";
import {
  taskAnswerCheckpointSignal,
  type CheckpointAnswer,
} from "./task.js";

export type CrossWorkspaceInput = {
  environmentId: EnvironmentId;
  coordinationWorkspaceId: WorkspaceId;
  taskId: TaskId;
  brief: TaskBrief;
  targetWorkspaceIds: WorkspaceId[];
  headMaidWorkflowId?: string;
  conversationId?: string;
};

export type ChildOutcome = {
  workspaceId: WorkspaceId;
  childTaskId: TaskId;
  status: "completed" | "failed" | "cancelled";
  summary: string;
};

export const childCompletedSignal = defineSignal<[ChildOutcome]>("childCompleted");
export const coordinationCompletedSignal = defineSignal<[TaskId]>("coordinationCompleted");
export const cancelCoordinationSignal = defineSignal<[string]>("cancelTask");
export const coordinationStateQuery = defineQuery<{
  delegated: WorkspaceId[];
  completed: WorkspaceId[];
}>("coordinationState");

export type CrossWorkspaceResult = {
  taskId: TaskId;
  status: "completed" | "cancelled" | "needs_attention";
  children: ChildOutcome[];
};

const db = proxyActivities<Activities>(DB_ACTIVITY_OPTIONS);
const manager = proxyActivities<Activities>(MANAGER_ACTIVITY_OPTIONS);
const notify = proxyActivities<Activities>(NOTIFICATION_ACTIVITY_OPTIONS);

/**
 * 02 section 7: the Head Maid plans and aggregates but never touches a target
 * workspace's paths, workers or credentials — only delegations cross the boundary.
 */
export async function CrossWorkspaceWorkflow(
  input: CrossWorkspaceInput,
): Promise<CrossWorkspaceResult> {
  try {
    return await runCrossWorkspaceWorkflow(input);
  } finally {
    if (input.headMaidWorkflowId !== undefined) {
      await getExternalWorkflowHandle(input.headMaidWorkflowId).signal(
        coordinationCompletedSignal,
        input.taskId,
      );
    }
  }
}

async function runCrossWorkspaceWorkflow(
  input: CrossWorkspaceInput,
): Promise<CrossWorkspaceResult> {
  const pipeline = getPipeline("cross-workspace");
  const delegated: WorkspaceId[] = [];
  const received = new Map<TaskId, ChildOutcome>();
  const expected = new Map<TaskId, WorkspaceId>();
  const answers: CheckpointAnswer[] = [];
  let cancelReason: string | undefined;
  let taskVersion = 0;
  let eventSequence = 0;

  setHandler(childCompletedSignal, (outcome) => {
    if (!received.has(outcome.childTaskId)) received.set(outcome.childTaskId, outcome);
  });
  setHandler(cancelCoordinationSignal, (reason) => {
    cancelReason = reason;
  });
  setHandler(taskAnswerCheckpointSignal, (answer) => {
    recordCheckpointAnswer(answers, answer);
  });
  setHandler(coordinationStateQuery, () => ({
    delegated,
    completed: [...received.values()]
      .filter((outcome) => expected.get(outcome.childTaskId) === outcome.workspaceId)
      .map((outcome) => outcome.workspaceId),
  }));

  const moveTo = async (status: Parameters<Activities["recordTaskStatus"]>[0]["status"]) => {
    eventSequence += 1;
    const recorded = await db.recordTaskStatus({
      taskId: input.taskId,
      status,
      expectedVersion: taskVersion,
      eventType: `TaskStatus:${status}`,
      idempotencyKey: `coordination:${input.taskId}:${eventSequence}:${status}`,
    });
    taskVersion = recorded.version;
    return recorded.applied;
  };

  const pause = async (reason: string, message: string): Promise<CrossWorkspaceResult> => {
    await moveTo("needs_attention");
    await notify.emitDomainEvent({
      taskId: input.taskId,
      workspaceId: input.coordinationWorkspaceId,
      eventId: uuid4(),
      type: "TaskNeedsAttention",
      payload: { reason, message },
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    });
    return {
      taskId: input.taskId,
      status: "needs_attention",
      children: [...expected].map(([childTaskId]) => received.get(childTaskId)!).filter(Boolean),
    };
  };

  const runGate = async (
    kind: "plan-approval" | "review-approval",
    prompt: string,
  ): Promise<{ proceed: boolean; satisfied: boolean }> => {
    const created = await db.createCheckpoint({
      taskId: input.taskId,
      workspaceId: input.coordinationWorkspaceId,
      kind,
      prompt,
      version: taskVersion + 1,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      requested: true,
      ...(kind === "review-approval"
        ? { hasFindings: [...received.values()].some((child) => child.status !== "completed") }
        : {}),
    });
    if (!created.required) return { proceed: true, satisfied: true };

    await moveTo(kind === "plan-approval" ? "waiting_plan_approval" : "waiting_review_approval");
    const answerIndex = () =>
      answers.findIndex((candidate) => candidate.checkpointId === created.checkpointId);
    await condition(() => answerIndex() >= 0 || cancelReason !== undefined);
    if (cancelReason !== undefined) return { proceed: false, satisfied: false };
    const index = answerIndex();
    const answer = index >= 0 ? answers.splice(index, 1)[0] : undefined;
    answers.length = 0;
    return {
      proceed: answer?.answer === "approved",
      satisfied: answer?.answer === "approved",
    };
  };

  if (input.targetWorkspaceIds.length === 0) {
    return pause("no-delegation-targets", "a coordination task needs at least one workspace");
  }

  await moveTo("planning");
  const planCharge = await db.chargeBudget({
    taskId: input.taskId,
    kind: "agent-run",
    stepKey: "plan",
  });
  if (!planCharge.allowed) {
    return pause(planCharge.limit, planCharge.message ?? "coordination planning exceeded budget");
  }
  const planned = await manager.planTask({
    taskId: input.taskId,
    workspaceId: input.coordinationWorkspaceId,
    brief: input.brief,
    stepKey: pipeline.entry,
    attempt: 1,
    idempotencyKey: `plan:${input.taskId}`,
  });
  if (planned.status !== "planned") {
    return pause("coordination-plan-failed", "Head Maid could not produce a coordination plan");
  }
  await db.recordStepOutcome({
    taskId: input.taskId,
    stepKey: "plan",
    stepKind: "plan",
    status: "succeeded",
  });
  const planGate = await runGate("plan-approval", "Approve this cross-workspace plan?");
  if (!planGate.proceed) {
    if (cancelReason !== undefined) {
      await moveTo("cancelled");
      return { taskId: input.taskId, status: "cancelled", children: [] };
    }
    return pause("gate-rejected", "the cross-workspace plan was not approved");
  }

  const targets = [...new Set(input.targetWorkspaceIds)];
  await moveTo("running");
  for (const target of targets) {
    const delegation = await db.createDelegation({
      environmentId: input.environmentId,
      parentTaskId: input.taskId,
      coordinationWorkflowId: workflowInfo().workflowId,
      targetWorkspaceId: target,
      brief: { ...input.brief, origin: "delegation" },
      idempotencyKey: delegationKey(input.taskId, target),
    });
    expected.set(delegation.childTaskId, target);
    delegated.push(target);
  }
  await db.recordStepOutcome({
    taskId: input.taskId,
    stepKey: "delegate",
    stepKind: "delegate",
    status: "succeeded",
  });

  await condition(
    () =>
      [...expected].every(
        ([childTaskId, workspaceId]) => received.get(childTaskId)?.workspaceId === workspaceId,
      ) || cancelReason !== undefined,
  );

  const children = [...expected].map(([childTaskId]) => received.get(childTaskId)!).filter(Boolean);

  if (cancelReason !== undefined) {
    await moveTo("cancelled");
    return { taskId: input.taskId, status: "cancelled", children };
  }

  await db.recordStepOutcome({
    taskId: input.taskId,
    stepKey: "await-children",
    stepKind: "await-children",
    status: "succeeded",
  });

  const advance = advancePipeline(pipeline, "await-children", "success");
  if (advance.kind !== "step") {
    return pause("pipeline-stuck", "cross-workspace pipeline could not reach aggregate");
  }

  await moveTo("reviewing");
  const aggregateCharge = await db.chargeBudget({
    taskId: input.taskId,
    kind: "agent-run",
    stepKey: "aggregate",
  });
  if (!aggregateCharge.allowed) {
    return pause(
      aggregateCharge.limit,
      aggregateCharge.message ?? "coordination aggregation exceeded budget",
    );
  }
  const aggregated = await manager.planTask({
    taskId: input.taskId,
    workspaceId: input.coordinationWorkspaceId,
    brief: input.brief,
    stepKey: advance.step.key,
    attempt: 1,
    idempotencyKey: `aggregate:${input.taskId}`,
    delegationResults: children.map((child) => ({
      workspaceId: child.workspaceId,
      status: child.status,
      summary: child.summary,
    })),
  });

  if (aggregated.status !== "planned") {
    return pause("aggregation-failed", "Head Maid could not aggregate child summaries");
  }
  await db.recordStepOutcome({
    taskId: input.taskId,
    stepKey: "aggregate",
    stepKind: "aggregate",
    status: "succeeded",
  });

  const reviewGate = await runGate("review-approval", "Approve the aggregated result?");
  if (!reviewGate.proceed) {
    if (cancelReason !== undefined) {
      await moveTo("cancelled");
      return { taskId: input.taskId, status: "cancelled", children };
    }
    return pause("gate-rejected", "the aggregated result was not approved");
  }

  const completion = await db.completeTask({
    taskId: input.taskId,
    workspaceId: input.coordinationWorkspaceId,
    pipeline: "cross-workspace",
    expectedVersion: taskVersion,
    eventId: uuid4(),
    summary: aggregated.plan.summary,
    verificationRequired: false,
    reviewGateSatisfied: reviewGate.satisfied,
    requiredArtifactPaths: [],
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
  });
  if (completion.status !== "completed") {
    return pause(
      "completion-rejected",
      completion.status === "conflict"
        ? "coordination task changed concurrently"
        : completion.unmet.join(", "),
    );
  }

  return { taskId: input.taskId, status: "completed", children };
}
