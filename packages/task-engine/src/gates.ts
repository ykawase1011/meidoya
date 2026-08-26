import type {
  CheckpointChoice,
  HumanCheckpoint,
  HumanCheckpointKind,
  TaskStatus,
} from "@meidoya/domain";

import { transition, type TaskMachineState, type TransitionResult } from "./state-machine.js";

const GATE_STATUS: Record<HumanCheckpointKind, TaskStatus> = {
  clarification: "waiting_clarification",
  "plan-approval": "waiting_plan_approval",
  "review-approval": "waiting_review_approval",
  "side-effect-approval": "waiting_side_effect_approval",
  "limit-exceeded": "needs_attention",
};

export function gateWaitStatus(kind: HumanCheckpointKind): TaskStatus {
  return GATE_STATUS[kind];
}

export function buildCheckpoint(args: {
  id: string;
  taskId: string;
  kind: HumanCheckpointKind;
  prompt: string;
  choices: CheckpointChoice[];
  version?: number;
}): HumanCheckpoint {
  return {
    id: args.id,
    taskId: args.taskId,
    kind: args.kind,
    status: "pending",
    prompt: args.prompt,
    choices: args.choices,
    version: args.version ?? 1,
  };
}

/** 07 section 4: one thread message per checkpoint version. */
export function checkpointIdempotencyKey(checkpoint: HumanCheckpoint): string {
  return `checkpoint:${checkpoint.id}:${checkpoint.version}`;
}

export function enterGate(
  state: TaskMachineState,
  kind: HumanCheckpointKind,
  now: number,
  resumeStatus?: TaskStatus,
): TransitionResult {
  const to = gateWaitStatus(kind);
  const input =
    to === "waiting_side_effect_approval"
      ? { to, resumeStatus: resumeStatus ?? state.status }
      : { to };
  return transition(state, input, now);
}

export type GateAnswer = "approved" | "rejected" | "answered";

/**
 * Where an answered gate resumes. Rejection sends approval gates back to planning
 * rather than failing, so the user can amend the request.
 */
export function gateResumeStatus(
  kind: HumanCheckpointKind,
  answer: GateAnswer,
  resumeStatus: TaskStatus,
): TaskStatus {
  switch (kind) {
    case "clarification":
      return "planning";
    case "plan-approval":
      return answer === "approved" ? "running" : "planning";
    case "review-approval":
      return answer === "approved" ? "completed" : "running";
    case "side-effect-approval":
      return answer === "approved" ? resumeStatus : "needs_attention";
    case "limit-exceeded":
      return answer === "approved" ? resumeStatus : "cancelled";
  }
}

/**
 * The kinds whose whole purpose is consent. An `approved` answer is the ONLY
 * thing that grants what they guard.
 */
export const APPROVAL_GATE_KINDS: readonly HumanCheckpointKind[] = [
  "plan-approval",
  "review-approval",
  "side-effect-approval",
];

/**
 * Whether an answered gate lets the caller CARRY ON with what the gate guards.
 *
 * 06 section 1.4: the human answer is what grants an external effect, and there
 * are three answers, not two. `TaskWorkflow` branched only on `rejected`, so an
 * `answered` verdict on a `plan-approval` or a `side-effect-approval` fell
 * through to "proceed" — the plan ran, and the gated capabilities went into the
 * run scope, on an answer that is not consent. {@link gateResumeStatus} already
 * said otherwise (`answered` sends a side-effect gate to `needs_attention` and a
 * plan gate back to `planning`); nothing acted on it.
 *
 * `review-approval` is deliberately not in the strict set: its answer is not a
 * licence to act but a value the completion check reads
 * (`reviewGateSatisfied`), and an `answered` review gate means "here is my
 * feedback, keep working" — which is exactly what `gateResumeStatus` maps it to
 * (`running`). Approval there is enforced by the flag, not by this predicate.
 *
 * `limit-exceeded` never reaches here from `TaskWorkflow` — it is an ANSWER
 * checkpoint whose choice arrives as text, resolved before this is consulted —
 * but it is spelled out rather than defaulted, so the switch stays exhaustive
 * when a new kind is added.
 *
 * Pure and total: it runs inside workflow code.
 */
export function gateGrantsProgress(kind: HumanCheckpointKind, answer: GateAnswer): boolean {
  switch (kind) {
    case "plan-approval":
    case "side-effect-approval":
    case "limit-exceeded":
      return answer === "approved";
    case "review-approval":
    case "clarification":
      return answer !== "rejected";
  }
}

export function resolveGate(
  state: TaskMachineState,
  kind: HumanCheckpointKind,
  answer: GateAnswer,
  now: number,
): TransitionResult {
  const resume = gateResumeStatus(kind, answer, state.resumeStatus ?? "running");
  return transition(state, { to: resume }, now);
}
