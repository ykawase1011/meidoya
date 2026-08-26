import type { PipelineName, TaskId, TaskStatus } from "@meidoya/domain";

export type TaskLane = "quick" | "durable";

export type TaskMachineState = {
  taskId: TaskId;
  pipeline: PipelineName;
  lane: TaskLane;
  status: TaskStatus;
  /** Where an answered wait state resumes to. */
  resumeStatus?: TaskStatus;
  currentStepKey?: string;
  version: number;
  startedAt: number;
  updatedAt: number;
};

export const ALL_TASK_STATUSES = [
  "received",
  "planning",
  "waiting_clarification",
  "waiting_plan_approval",
  "running",
  "verifying",
  "reviewing",
  "waiting_review_approval",
  "waiting_user_input",
  "waiting_side_effect_approval",
  "needs_attention",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TaskStatus[];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"];

/** 05 section 3: reachable from anywhere. */
export const INTERRUPT_STATUSES: readonly TaskStatus[] = [
  "waiting_user_input",
  "waiting_side_effect_approval",
  "needs_attention",
  "failed",
  "cancelled",
];

/** States that hold no agent process, git lock or SQLite transaction (05 section 9). */
export const WAIT_STATUSES: readonly TaskStatus[] = [
  "waiting_clarification",
  "waiting_plan_approval",
  "waiting_review_approval",
  "waiting_user_input",
  "waiting_side_effect_approval",
];

/** The linear durable-lane flow from 05 section 3. Interrupts are added separately. */
const FLOW: Record<TaskStatus, readonly TaskStatus[]> = {
  received: ["planning"],
  planning: ["waiting_clarification", "waiting_plan_approval", "running"],
  waiting_clarification: ["planning"],
  waiting_plan_approval: ["running", "planning"],
  running: ["verifying", "reviewing"],
  verifying: ["reviewing", "running"],
  reviewing: ["running", "waiting_review_approval", "completed"],
  waiting_review_approval: ["completed", "running"],
  waiting_user_input: [],
  waiting_side_effect_approval: [],
  // 06 section 8: a paused task resumes, is accepted as-is, or terminates.
  needs_attention: ["planning", "running", "verifying", "reviewing", "completed"],
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * Quick lane runs no approval gates other than clarification (05 section 2).
 *
 * Exported because it is the SAME rule `quickLaneWaivesGate` applies when the
 * workflow decides which gates to skip: a gate the quick lane skips and a wait
 * state the quick lane may not enter have to be the same set, or the workflow
 * either parks a quick task in a state the machine rejects or waives a gate it
 * could perfectly well have held. `waiting_side_effect_approval` is not here,
 * and must not be: a quick task that trips the side-effect gate waits.
 */
export const QUICK_FORBIDDEN: readonly TaskStatus[] = [
  "waiting_plan_approval",
  "waiting_review_approval",
];

export type TransitionInput = {
  to: TaskStatus;
  reason?: string;
  /** Required when entering waiting_user_input / waiting_side_effect_approval. */
  resumeStatus?: TaskStatus;
  stepKey?: string;
};

export type IllegalTransitionCode =
  | "terminal-state"
  | "not-in-flow"
  | "quick-lane-forbidden"
  | "unknown-status"
  | "resume-mismatch"
  | "missing-resume-status";

export type TransitionResult =
  | { ok: true; state: TaskMachineState; from: TaskStatus; to: TaskStatus }
  | { ok: false; code: IllegalTransitionCode; message: string; from: TaskStatus; to: TaskStatus };

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isWaiting(status: TaskStatus): boolean {
  return WAIT_STATUSES.includes(status);
}

function knownStatus(status: TaskStatus): boolean {
  return (ALL_TASK_STATUSES as readonly string[]).includes(status);
}

export function canTransition(
  state: TaskMachineState,
  to: TaskStatus,
): { ok: true } | { ok: false; code: IllegalTransitionCode; message: string } {
  if (!knownStatus(to)) {
    return { ok: false, code: "unknown-status", message: `unknown status ${String(to)}` };
  }
  if (isTerminal(state.status)) {
    return {
      ok: false,
      code: "terminal-state",
      message: `task is terminal in ${state.status}`,
    };
  }
  if (state.lane === "quick" && QUICK_FORBIDDEN.includes(to)) {
    return {
      ok: false,
      code: "quick-lane-forbidden",
      message: `quick lane cannot enter ${to}`,
    };
  }
  if (INTERRUPT_STATUSES.includes(to)) {
    return { ok: true };
  }
  if (
    state.status === "waiting_user_input" ||
    state.status === "waiting_side_effect_approval"
  ) {
    if (state.resumeStatus === undefined) {
      return {
        ok: false,
        code: "missing-resume-status",
        message: `${state.status} has no recorded resume status`,
      };
    }
    if (state.resumeStatus !== to) {
      return {
        ok: false,
        code: "resume-mismatch",
        message: `${state.status} resumes to ${state.resumeStatus}, not ${to}`,
      };
    }
    return { ok: true };
  }
  const allowed = FLOW[state.status];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      code: "not-in-flow",
      message: `${state.status} -> ${to} is not a legal transition`,
    };
  }
  return { ok: true };
}

export function transition(
  state: TaskMachineState,
  input: TransitionInput,
  now: number,
): TransitionResult {
  const check = canTransition(state, input.to);
  if (!check.ok) {
    return { ok: false, code: check.code, message: check.message, from: state.status, to: input.to };
  }
  const entersDynamicWait =
    input.to === "waiting_user_input" || input.to === "waiting_side_effect_approval";
  if (entersDynamicWait && input.resumeStatus !== undefined && isTerminal(input.resumeStatus)) {
    return {
      ok: false,
      code: "missing-resume-status",
      message: `resume status ${input.resumeStatus} is terminal`,
      from: state.status,
      to: input.to,
    };
  }

  const next: TaskMachineState = {
    ...state,
    status: input.to,
    version: state.version + 1,
    updatedAt: now,
  };

  if (entersDynamicWait) {
    // Remember where to come back to so an answer cannot resume into an arbitrary state.
    next.resumeStatus = input.resumeStatus ?? state.status;
  } else {
    delete next.resumeStatus;
  }

  if (input.stepKey !== undefined) {
    next.currentStepKey = input.stepKey;
  }

  return { ok: true, state: next, from: state.status, to: input.to };
}

export class IllegalTransitionError extends Error {
  readonly code: IllegalTransitionCode;
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(result: Extract<TransitionResult, { ok: false }>) {
    super(result.message);
    this.name = "IllegalTransitionError";
    this.code = result.code;
    this.from = result.from;
    this.to = result.to;
  }
}

export function transitionOrThrow(
  state: TaskMachineState,
  input: TransitionInput,
  now: number,
): TaskMachineState {
  const result = transition(state, input, now);
  if (!result.ok) throw new IllegalTransitionError(result);
  return result.state;
}

export function createTaskMachineState(args: {
  taskId: TaskId;
  pipeline: PipelineName;
  lane: TaskLane;
  now: number;
}): TaskMachineState {
  return {
    taskId: args.taskId,
    pipeline: args.pipeline,
    lane: args.lane,
    status: "received",
    version: 0,
    startedAt: args.now,
    updatedAt: args.now,
  };
}
