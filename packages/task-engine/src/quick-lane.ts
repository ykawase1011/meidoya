import type { HumanCheckpointKind, PipelineName } from "@meidoya/domain";

import { gateWaitStatus } from "./gates.js";
import { QUICK_FORBIDDEN, isTerminal, type TaskMachineState } from "./state-machine.js";

/**
 * The gates the quick lane skips, and the exhaustive reason why.
 *
 * 05 section 2: a quick task is an inline Maid → Manager → one Worker hop with
 * no durable state to park an approval in, so the two gates that exist to shape
 * DURABLE work — approving a plan, approving completion — are not asked for. It
 * is a narrow carve-out and it must stay narrow:
 *
 *  - `side-effect-approval` is NOT skipped. It is the one gate that stands
 *    between a Worker and an effect outside the workspace, and "the lane has
 *    nowhere to park it" is not a reason to hand out `network` + `shell`
 *    unasked. A quick task that trips it waits like any other.
 *  - `clarification` is NOT skipped: a blocked Worker asking a question is the
 *    quick lane's normal shape.
 *  - `limit-exceeded` is NOT skipped: it is a pause offering an extension, not
 *    an approval.
 *
 * Widening this is how the escape comes back, so it is not a condition inlined
 * in the workflow and not a second list either: it is DERIVED from the wait
 * states the state machine forbids a quick task ({@link QUICK_FORBIDDEN}).
 * Skipping a gate the machine would happily hold, or holding one it rejects,
 * are both bugs — deriving makes them the same edit. `quick-lane.test.ts` pins
 * the resulting set.
 */
export function quickLaneWaivesGate(kind: HumanCheckpointKind): boolean {
  return QUICK_FORBIDDEN.includes(gateWaitStatus(kind));
}

export type QuickLaneConfig = {
  softDeadlineMs: number;
  /** Durable pipeline the task is promoted into. */
  promoteTo: PipelineName;
};

export function isQuickSoftDeadlineExceeded(
  state: TaskMachineState,
  config: QuickLaneConfig,
  now: number,
): boolean {
  if (state.lane !== "quick") return false;
  if (isTerminal(state.status)) return false;
  return now - state.startedAt >= config.softDeadlineMs;
}

export type Promotion = {
  taskId: string;
  from: "quick";
  to: "durable";
  pipeline: PipelineName;
  /** 05 section 2: promotion is silent — no extra progress message. */
  emitProgressMessage: false;
};

export type PromotionResult =
  | { ok: true; state: TaskMachineState; promotion: Promotion }
  | { ok: false; reason: "not-quick-lane" | "terminal-state" };

/**
 * Promotes a quick task to the durable lane keeping the SAME task id, status and
 * step, so the user sees one continuous task (05 section 2, 02 section 4.2).
 */
export function promoteQuickToDurable(
  state: TaskMachineState,
  args: { now: number; pipeline: PipelineName },
): PromotionResult {
  if (state.lane !== "quick") return { ok: false, reason: "not-quick-lane" };
  if (isTerminal(state.status)) return { ok: false, reason: "terminal-state" };

  const next: TaskMachineState = {
    ...state,
    lane: "durable",
    pipeline: args.pipeline,
    version: state.version + 1,
    updatedAt: args.now,
  };

  return {
    ok: true,
    state: next,
    promotion: {
      taskId: state.taskId,
      from: "quick",
      to: "durable",
      pipeline: args.pipeline,
      emitProgressMessage: false,
    },
  };
}
