export type StepKind =
  | "agent-run"
  | "verification-group"
  | "review-group"
  | "manager-replan"
  | "human-wait"
  | "temporal-timer"
  | "db-projection";

/** Section 5: only these four consume the root budget. */
export const COUNTED_STEP_KINDS: readonly StepKind[] = [
  "agent-run",
  "verification-group",
  "review-group",
  "manager-replan",
];

export const UNCOUNTED_STEP_KINDS: readonly StepKind[] = [
  "human-wait",
  "temporal-timer",
  "db-projection",
];

export function stepCost(kind: StepKind): 0 | 1 {
  return COUNTED_STEP_KINDS.includes(kind) ? 1 : 0;
}
