import type { CheckpointChoice, ExecutionBudget, ModelProfile, TaskId } from "@meidoya/domain";
import { nextModelProfile } from "./escalation.js";
import {
  NoProgressDetector,
  type NoProgressState,
  type ProgressInputs,
} from "./fingerprint.js";
import { stepCost, type StepKind } from "./steps.js";

export type LimitName =
  | "max_steps"
  | "max_step_visits"
  | "max_fix_rounds"
  | "max_review_rounds"
  | "max_no_progress_rounds"
  | "max_parallel_workers"
  | "max_model_escalations"
  | "max_consecutive_failures"
  | "max_wall_time";

export type LimitViolation = {
  limit: LimitName;
  limitValue: number;
  observed: number;
  detail?: string;
};

export type LimitChoiceId =
  | "extend-once"
  | "change-model"
  | "add-instruction"
  | "accept"
  | "cancel";

export const LIMIT_EXCEEDED_CHOICES: readonly (CheckpointChoice & { id: LimitChoiceId })[] = [
  { id: "extend-once", label: "Extend budget once" },
  { id: "change-model", label: "Change model/profile" },
  { id: "add-instruction", label: "Add instruction" },
  { id: "accept", label: "Accept current result" },
  { id: "cancel", label: "Cancel" },
];

export type LimitExceededCheckpointRequest = {
  kind: "limit-exceeded";
  prompt: string;
  choices: readonly CheckpointChoice[];
};

export type NeedsAttentionOutcome = {
  status: "needs_attention";
  violation: LimitViolation;
  checkpoint: LimitExceededCheckpointRequest;
};

export type OkOutcome = {
  status: "ok";
  stepsUsed: number;
  stepsRemaining: number;
};

export type LedgerOutcome = OkOutcome | NeedsAttentionOutcome;

export type EscalationOutcome =
  | { status: "escalated"; from: ModelProfile; to: ModelProfile; escalationsUsed: number }
  | NeedsAttentionOutcome;

export type ExtensionOutcome =
  | { ok: true; maxSteps: number }
  | { ok: false; reason: "already-extended" };

export type StepEvent = {
  taskId: TaskId;
  stepKey: string;
  kind: StepKind;
};

export type BudgetLedgerState = {
  rootTaskId: TaskId;
  startedAt: number;
  stepsUsed: number;
  stepVisits: Record<string, number>;
  fixRounds: number;
  reviewRounds: number;
  consecutiveFailures: number;
  modelEscalations: number;
  extensionsUsed: number;
  extraSteps: number;
  noProgress: NoProgressState;
};

function visitKey(taskId: TaskId, stepKey: string): string {
  return `${taskId}\u0000${stepKey}`;
}

export type ChildBudget = {
  readonly taskId: TaskId;
  recordStep(stepKey: string, kind: StepKind): LedgerOutcome;
  recordFixRound(): LedgerOutcome;
  recordReviewRound(): LedgerOutcome;
};

/**
 * All counters live on the root ledger. Child tasks and subworkflows get a
 * facade (forChild) rather than their own ledger, so splitting work into
 * children cannot mint extra budget.
 */
export class BudgetLedger {
  readonly #budget: ExecutionBudget;
  readonly #state: BudgetLedgerState;
  #noProgress: NoProgressDetector;

  constructor(rootTaskId: TaskId, budget: ExecutionBudget, startedAt = 0) {
    this.#budget = budget;
    this.#state = {
      rootTaskId,
      startedAt,
      stepsUsed: 0,
      stepVisits: {},
      fixRounds: 0,
      reviewRounds: 0,
      consecutiveFailures: 0,
      modelEscalations: 0,
      extensionsUsed: 0,
      extraSteps: 0,
      noProgress: { repeatCount: 0 },
    };
    this.#noProgress = new NoProgressDetector(budget.maxNoProgressRounds, this.#state.noProgress);
  }

  static restore(budget: ExecutionBudget, state: BudgetLedgerState): BudgetLedger {
    const ledger = new BudgetLedger(state.rootTaskId, budget, state.startedAt);
    ledger.#assign(state);
    return ledger;
  }

  #assign(state: BudgetLedgerState): void {
    this.#state.stepsUsed = state.stepsUsed;
    this.#state.stepVisits = { ...state.stepVisits };
    this.#state.fixRounds = state.fixRounds;
    this.#state.reviewRounds = state.reviewRounds;
    this.#state.consecutiveFailures = state.consecutiveFailures;
    this.#state.modelEscalations = state.modelEscalations;
    this.#state.extensionsUsed = state.extensionsUsed;
    this.#state.extraSteps = state.extraSteps;
    this.#state.noProgress = { ...state.noProgress };
    this.#noProgress = new NoProgressDetector(
      this.#budget.maxNoProgressRounds,
      this.#state.noProgress,
    );
  }

  get rootTaskId(): TaskId {
    return this.#state.rootTaskId;
  }

  get maxSteps(): number {
    return this.#budget.maxSteps + this.#state.extraSteps;
  }

  get stepsUsed(): number {
    return this.#state.stepsUsed;
  }

  get stepsRemaining(): number {
    return Math.max(0, this.maxSteps - this.#state.stepsUsed);
  }

  get extensionsUsed(): number {
    return this.#state.extensionsUsed;
  }

  snapshot(): BudgetLedgerState {
    return {
      ...this.#state,
      stepVisits: { ...this.#state.stepVisits },
      noProgress: this.#noProgress.snapshot(),
    };
  }

  #ok(): OkOutcome {
    return {
      status: "ok",
      stepsUsed: this.#state.stepsUsed,
      stepsRemaining: this.stepsRemaining,
    };
  }

  #needsAttention(violation: LimitViolation): NeedsAttentionOutcome {
    return {
      status: "needs_attention",
      violation,
      checkpoint: {
        kind: "limit-exceeded",
        prompt: `Task paused: execution limit reached (${violation.limit}).`,
        choices: this.availableChoices(),
      },
    };
  }

  availableChoices(): readonly CheckpointChoice[] {
    return LIMIT_EXCEEDED_CHOICES.filter(
      (choice) => choice.id !== "extend-once" || this.#state.extensionsUsed === 0,
    ).map((choice) => ({ id: choice.id, label: choice.label }));
  }

  recordStep(event: StepEvent): LedgerOutcome {
    const cost = stepCost(event.kind);
    if (cost === 0) {
      return this.#ok();
    }

    if (this.#state.stepsUsed + cost > this.maxSteps) {
      return this.#needsAttention({
        limit: "max_steps",
        limitValue: this.maxSteps,
        observed: this.#state.stepsUsed + cost,
      });
    }

    const key = visitKey(event.taskId, event.stepKey);
    const visits = (this.#state.stepVisits[key] ?? 0) + 1;
    if (visits > this.#budget.maxStepVisits) {
      return this.#needsAttention({
        limit: "max_step_visits",
        limitValue: this.#budget.maxStepVisits,
        observed: visits,
        detail: event.stepKey,
      });
    }

    this.#state.stepVisits[key] = visits;
    this.#state.stepsUsed += cost;
    return this.#ok();
  }

  recordFixRound(): LedgerOutcome {
    const rounds = this.#state.fixRounds + 1;
    if (rounds > this.#budget.maxFixRounds) {
      return this.#needsAttention({
        limit: "max_fix_rounds",
        limitValue: this.#budget.maxFixRounds,
        observed: rounds,
      });
    }
    this.#state.fixRounds = rounds;
    return this.#ok();
  }

  recordReviewRound(): LedgerOutcome {
    const rounds = this.#state.reviewRounds + 1;
    if (rounds > this.#budget.maxReviewRounds) {
      return this.#needsAttention({
        limit: "max_review_rounds",
        limitValue: this.#budget.maxReviewRounds,
        observed: rounds,
      });
    }
    this.#state.reviewRounds = rounds;
    return this.#ok();
  }

  recordFailure(): LedgerOutcome {
    const failures = this.#state.consecutiveFailures + 1;
    this.#state.consecutiveFailures = failures;
    if (failures >= this.#budget.maxConsecutiveFailures) {
      return this.#needsAttention({
        limit: "max_consecutive_failures",
        limitValue: this.#budget.maxConsecutiveFailures,
        observed: failures,
      });
    }
    return this.#ok();
  }

  recordSuccess(): void {
    this.#state.consecutiveFailures = 0;
  }

  recordProgress(inputs: ProgressInputs): LedgerOutcome {
    const observation = this.#noProgress.observe(inputs);
    this.#state.noProgress = this.#noProgress.snapshot();
    if (observation.noProgress) {
      return this.#needsAttention({
        limit: "max_no_progress_rounds",
        limitValue: this.#budget.maxNoProgressRounds,
        observed: observation.repeatCount,
        detail: observation.fingerprint,
      });
    }
    return this.#ok();
  }

  checkWallTime(now: number): LedgerOutcome {
    const elapsed = now - this.#state.startedAt;
    if (elapsed > this.#budget.maxWallTimeMs) {
      return this.#needsAttention({
        limit: "max_wall_time",
        limitValue: this.#budget.maxWallTimeMs,
        observed: elapsed,
      });
    }
    return this.#ok();
  }

  checkParallelWorkers(requested: number): LedgerOutcome {
    if (requested > this.#budget.maxParallelWorkers) {
      return this.#needsAttention({
        limit: "max_parallel_workers",
        limitValue: this.#budget.maxParallelWorkers,
        observed: requested,
      });
    }
    return this.#ok();
  }

  escalateModel(current: ModelProfile): EscalationOutcome {
    const used = this.#state.modelEscalations + 1;
    if (used > this.#budget.maxModelEscalations) {
      return this.#needsAttention({
        limit: "max_model_escalations",
        limitValue: this.#budget.maxModelEscalations,
        observed: used,
      });
    }
    const next = nextModelProfile(current);
    if (next === undefined) {
      return this.#needsAttention({
        limit: "max_model_escalations",
        limitValue: this.#budget.maxModelEscalations,
        observed: this.#state.modelEscalations,
        detail: "already at the highest model profile",
      });
    }
    this.#state.modelEscalations = used;
    return { status: "escalated", from: current, to: next, escalationsUsed: used };
  }

  /**
   * Section 8: the budget may be extended exactly once, and by exactly one
   * more budget's worth of steps.
   *
   * How much an extension is worth is POLICY — it comes from the workspace's
   * configured `max_steps` — so it takes no argument. It used to accept an
   * unbounded `additionalSteps` that no production caller ever passed: an inert
   * parameter sitting on the one method whose whole purpose is to relax a
   * limit, waiting for a caller to wire the number through from a checkpoint
   * answer and hand whoever answers the gate an arbitrarily large budget. Inert
   * fields becoming live is how three defects got here already; the size of an
   * extension is not a caller's to choose.
   */
  extendOnce(): ExtensionOutcome {
    if (this.#state.extensionsUsed >= 1) {
      return { ok: false, reason: "already-extended" };
    }
    this.#state.extensionsUsed = 1;
    this.#state.extraSteps += this.#budget.maxSteps;
    return { ok: true, maxSteps: this.maxSteps };
  }

  forChild(childTaskId: TaskId): ChildBudget {
    return {
      taskId: childTaskId,
      recordStep: (stepKey, kind) =>
        this.recordStep({ taskId: childTaskId, stepKey, kind }),
      recordFixRound: () => this.recordFixRound(),
      recordReviewRound: () => this.recordReviewRound(),
    };
  }
}
