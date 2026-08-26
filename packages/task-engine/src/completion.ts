import type { DomainEvent, ReviewFindings } from "@meidoya/domain";

import type { PipelineDefinition } from "./pipelines.js";
import { requiredStepKeys } from "./pipelines.js";
import type {
  InteractionPolicyPort,
  OutboxIntent,
  StepRecord,
  TaskRepositoryPort,
} from "./ports.js";
import { blockingFindings } from "./review.js";
import { transition, type TaskMachineState } from "./state-machine.js";
import type { VerificationResult } from "./verification.js";

export type CompletionCondition =
  | "required-steps-terminal"
  | "verification-policy-satisfied"
  | "no-unresolved-blocking-findings"
  | "review-gate-satisfied"
  | "required-artifacts-stored"
  | "completion-notification-registered";

export type CompletionCheckInput = {
  pipeline: PipelineDefinition;
  steps: readonly Pick<StepRecord, "stepKey" | "status">[];
  verificationRequired: boolean;
  verification?: VerificationResult;
  findings?: ReviewFindings;
  reviewGateSatisfied: boolean;
  requiredArtifactPaths: readonly string[];
  storedArtifactPaths: readonly string[];
  /** Set once the outbox intent for completion has been produced. */
  notificationRegistered: boolean;
};

export type CompletionCheck =
  | { ok: true }
  | { ok: false; unmet: CompletionCondition[]; detail: Record<string, unknown> };

const TERMINAL_STEP_STATUSES = ["succeeded", "skipped"] as const;

/** 05 section 10: every condition must hold. */
export function evaluateCompletion(input: CompletionCheckInput): CompletionCheck {
  const unmet: CompletionCondition[] = [];
  const detail: Record<string, unknown> = {};

  const byKey = new Map(input.steps.map((s) => [s.stepKey, s.status]));
  const missingSteps = requiredStepKeys(input.pipeline).filter((key) => {
    const status = byKey.get(key);
    return status === undefined || !(TERMINAL_STEP_STATUSES as readonly string[]).includes(status);
  });
  if (missingSteps.length > 0) {
    unmet.push("required-steps-terminal");
    detail["missingSteps"] = missingSteps;
  }

  if (input.verificationRequired) {
    if (!input.verification || input.verification.status !== "passed") {
      unmet.push("verification-policy-satisfied");
      detail["verification"] = input.verification?.status ?? "missing";
    }
  }

  const blocking = input.findings ? blockingFindings(input.findings) : [];
  if (blocking.length > 0) {
    unmet.push("no-unresolved-blocking-findings");
    detail["blockingFindingIds"] = blocking.map((f) => f.id);
  }

  if (!input.reviewGateSatisfied) unmet.push("review-gate-satisfied");

  const stored = new Set(input.storedArtifactPaths);
  const missingArtifacts = input.requiredArtifactPaths.filter((p) => !stored.has(p));
  if (missingArtifacts.length > 0) {
    unmet.push("required-artifacts-stored");
    detail["missingArtifacts"] = missingArtifacts;
  }

  if (!input.notificationRegistered) unmet.push("completion-notification-registered");

  return unmet.length === 0 ? { ok: true } : { ok: false, unmet, detail };
}

export type CompleteTaskResult =
  | { ok: true; state: TaskMachineState; intents: OutboxIntent[] }
  | { ok: false; reason: "conditions-unmet"; unmet: CompletionCondition[] }
  | { ok: false; reason: "illegal-transition"; message: string }
  | { ok: false; reason: "version-conflict" }
  | { ok: false; reason: "no-notification" };

export type CompleteTaskArgs = {
  state: TaskMachineState;
  taskVersion: number;
  event: DomainEvent;
  conditions: Omit<CompletionCheckInput, "notificationRegistered">;
  now: number;
  ports: {
    repository: TaskRepositoryPort;
    interactionPolicy: InteractionPolicyPort;
  };
};

class RollbackSignal extends Error {
  constructor(readonly reason: "version-conflict") {
    super(reason);
  }
}

/**
 * Terminal write and completion notification share one transaction so a task can
 * never be completed without its outbox row (05 section 10, 08 section 1).
 */
export async function completeTask(args: CompleteTaskArgs): Promise<CompleteTaskResult> {
  const intents = await args.ports.interactionPolicy.emit(args.event);
  if (intents.length === 0) return { ok: false, reason: "no-notification" };

  const check = evaluateCompletion({ ...args.conditions, notificationRegistered: true });
  if (!check.ok) return { ok: false, reason: "conditions-unmet", unmet: check.unmet };

  const moved = transition(args.state, { to: "completed" }, args.now);
  if (!moved.ok) return { ok: false, reason: "illegal-transition", message: moved.message };

  try {
    await args.ports.repository.transaction(async (tx) => {
      const updated = await tx.updateTaskStatus({
        taskId: args.state.taskId,
        nextStatus: "completed",
        expectedVersion: args.taskVersion,
      });
      if (!updated) throw new RollbackSignal("version-conflict");
      await tx.appendTaskEvent({
        taskId: args.state.taskId,
        eventType: "TaskCompleted",
        idempotencyKey: `task:${args.state.taskId}:completed`,
        payload: args.event.payload,
      });
      for (const intent of intents) {
        await tx.enqueueNotification(intent);
      }
    });
  } catch (error) {
    if (error instanceof RollbackSignal) return { ok: false, reason: "version-conflict" };
    throw error;
  }

  // The intents are durable, so the ledger may remember them. Before the
  // commit it could not: a retried attempt would find its own key already
  // present and edit a row nobody ever inserted.
  await args.ports.interactionPolicy.recordEmitted(intents);

  // Only now, with the terminal status and the outbox rows durable. Announcing
  // before the checks above told every watching client the task had completed
  // and then moved it to `needs_attention` when a condition was unmet.
  await args.ports.interactionPolicy.publish(args.event);

  return { ok: true, state: moved.state, intents };
}
