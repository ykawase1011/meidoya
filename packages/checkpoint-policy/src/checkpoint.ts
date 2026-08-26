import type {
  CheckpointChoice,
  HumanCheckpoint,
  HumanCheckpointKind,
  TaskId,
} from "@meidoya/domain";

export type OpenCheckpointInput = {
  id: string;
  taskId: TaskId;
  kind: HumanCheckpointKind;
  prompt: string;
  choices?: readonly CheckpointChoice[];
};

const APPROVAL_KINDS: readonly HumanCheckpointKind[] = [
  "plan-approval",
  "review-approval",
  "side-effect-approval",
];

const ANSWER_KINDS: readonly HumanCheckpointKind[] = ["clarification", "limit-exceeded"];

export function openCheckpoint(input: OpenCheckpointInput): HumanCheckpoint {
  return {
    id: input.id,
    taskId: input.taskId,
    kind: input.kind,
    status: "pending",
    prompt: input.prompt,
    choices: [...(input.choices ?? [])],
    version: 1,
  };
}

export type CheckpointEvent =
  | { type: "approve" }
  | { type: "reject" }
  | { type: "answer"; choiceId?: string; text?: string }
  | { type: "expire" };

export type CheckpointTransitionError =
  | "not-pending"
  | "event-not-valid-for-kind"
  | "choice-required"
  | "unknown-choice";

export type CheckpointTransition =
  | { ok: true; checkpoint: HumanCheckpoint }
  | { ok: false; error: CheckpointTransitionError };

function advance(
  checkpoint: HumanCheckpoint,
  status: HumanCheckpoint["status"],
): CheckpointTransition {
  return {
    ok: true,
    checkpoint: { ...checkpoint, status, version: checkpoint.version + 1 },
  };
}

export function applyCheckpointEvent(
  checkpoint: HumanCheckpoint,
  event: CheckpointEvent,
): CheckpointTransition {
  if (checkpoint.status !== "pending") {
    return { ok: false, error: "not-pending" };
  }

  switch (event.type) {
    case "expire":
      return advance(checkpoint, "expired");
    case "approve":
    case "reject": {
      if (!APPROVAL_KINDS.includes(checkpoint.kind)) {
        return { ok: false, error: "event-not-valid-for-kind" };
      }
      return advance(checkpoint, event.type === "approve" ? "approved" : "rejected");
    }
    case "answer": {
      if (!ANSWER_KINDS.includes(checkpoint.kind)) {
        return { ok: false, error: "event-not-valid-for-kind" };
      }
      if (checkpoint.choices.length > 0) {
        if (event.choiceId === undefined) {
          return { ok: false, error: "choice-required" };
        }
        if (!checkpoint.choices.some((choice) => choice.id === event.choiceId)) {
          return { ok: false, error: "unknown-choice" };
        }
      }
      return advance(checkpoint, "answered");
    }
  }
}

export function isCheckpointResolved(checkpoint: HumanCheckpoint): boolean {
  return checkpoint.status !== "pending";
}

/* --------------------------------------------------------------- delivery */

/**
 * What the control plane knows about one checkpoint when a caller asks to
 * answer it: whether the answer has been committed, and whether that committed
 * answer has been handed to the workflow yet.
 */
export type CheckpointDeliveryState = {
  status: HumanCheckpoint["status"];
  /** True once the workflow signal for the committed answer has landed. */
  signalled: boolean;
};

export type CheckpointDeliveryPlan =
  /** Still pending: run the version-guarded resolve, then deliver. */
  | { action: "resolve" }
  /**
   * The answer is committed but was never delivered — the signal RPC failed
   * after the compare-and-swap. Re-send the committed answer instead of
   * refusing the caller; the workflow is still parked waiting for it.
   */
  | { action: "redeliver" }
  /** Committed and delivered: a second, different answer is a conflict. */
  | { action: "conflict" };

/**
 * The commit of a checkpoint answer and the signal that tells the workflow
 * about it are two separate operations, and no transaction spans them. If the
 * process stops between them the row says "approved" while the workflow is
 * still parked in `condition()` with no timeout — permanently, because every
 * retry used to see a non-pending row and get a 409.
 *
 * The `signalled` flag is what makes the pair recoverable: a committed answer
 * that was never delivered is not a conflict, it is unfinished work, and the
 * only correct response to a retry (or to a reconciliation sweep) is to finish
 * it. Delivering it more than once is harmless — TaskWorkflow matches answers
 * by checkpoint id, consumes exactly one, and discards the rest — so this
 * trades at-most-once delivery for at-least-once, which is the only one of the
 * two that can be made to terminate.
 */
export function planCheckpointDelivery(state: CheckpointDeliveryState): CheckpointDeliveryPlan {
  if (state.status === "pending") return { action: "resolve" };
  return state.signalled ? { action: "conflict" } : { action: "redeliver" };
}

/**
 * The `answer` field of the workflow signal for a resolved checkpoint, or
 * `undefined` when the resolution is not something the workflow can be told
 * about (`pending`, or an `expired` checkpoint, which the workflow learns about
 * through its own timer rather than through an answer signal).
 */
export function checkpointSignalAnswer(
  status: HumanCheckpoint["status"],
): "approved" | "rejected" | "answered" | undefined {
  switch (status) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "answered":
      return "answered";
    default:
      return undefined;
  }
}
