import type {
  ExecutionBudget,
  HumanCheckpointKind,
  ManagerDecision,
  ReviewFinding,
  ReviewFindings,
  WorkspacePolicy,
} from "@meidoya/domain";

import type { BudgetLimitName } from "./ports.js";
import type { VerificationResult } from "./verification.js";

/** 06 section 6 fingerprint inputs. */
export type ProgressFingerprintInput = {
  gitDiffHash?: string;
  verificationFailureSignature?: string;
  reviewFindingIds?: string[];
  artifactHashes?: string[];
  managerDecisionClass?: string;
};

export function progressFingerprint(input: ProgressFingerprintInput): string {
  const parts = [
    `diff=${input.gitDiffHash ?? ""}`,
    `verify=${input.verificationFailureSignature ?? ""}`,
    `findings=${(input.reviewFindingIds ?? []).slice().sort().join(",")}`,
    `artifacts=${(input.artifactHashes ?? []).slice().sort().join(",")}`,
    `decision=${input.managerDecisionClass ?? ""}`,
  ];
  return parts.join("|");
}

export function findingsFingerprint(findings: ReviewFindings): string {
  return progressFingerprint({ reviewFindingIds: findings.findings.map((f) => f.id) });
}

/** Same fingerprint repeated `threshold` times in a row means no progress. */
export function detectNoProgress(history: readonly string[], threshold: number): boolean {
  if (threshold <= 0) return false;
  if (history.length < threshold) return false;
  const tail = history.slice(-threshold);
  const first = tail[0];
  if (first === undefined) return false;
  return tail.every((f) => f === first);
}

export function blockingFindings(findings: ReviewFindings): ReviewFinding[] {
  return findings.findings.filter((f) => f.severity === "blocking");
}

export function repeatedFindingIds(
  previous: ReviewFindings | undefined,
  current: ReviewFindings,
): string[] {
  if (!previous) return [];
  const before = new Set(previous.findings.map((f) => f.id));
  return current.findings.filter((f) => before.has(f.id)).map((f) => f.id);
}

export type ReviewLoopState = {
  reviewRounds: number;
  fixRounds: number;
  fingerprints: string[];
};

export function recordReviewRound(
  state: ReviewLoopState,
  findings: ReviewFindings,
  verification?: VerificationResult,
): ReviewLoopState {
  const fingerprint = progressFingerprint({
    reviewFindingIds: findings.findings.map((f) => f.id),
    ...(verification?.failureSignature !== undefined
      ? { verificationFailureSignature: verification.failureSignature }
      : {}),
  });
  return {
    ...state,
    reviewRounds: state.reviewRounds + 1,
    fingerprints: [...state.fingerprints, fingerprint],
  };
}

export type ManagerOutcome =
  | { kind: "complete" }
  | { kind: "gate"; checkpointKind: HumanCheckpointKind; prompt: string }
  | { kind: "fix"; findingIds: string[]; loop: ReviewLoopState }
  | { kind: "review-again"; loop: ReviewLoopState }
  | { kind: "needs-attention"; limit: BudgetLimitName; message: string }
  | { kind: "abort"; reason: string };

export type ManagerDecisionContext = {
  decision: ManagerDecision;
  loop: ReviewLoopState;
  findings: ReviewFindings;
  budget: ExecutionBudget;
  reviewGate: WorkspacePolicy["humanGates"]["review"];
};

function reviewGateRequired(
  mode: WorkspacePolicy["humanGates"]["review"],
  hasFindings: boolean,
): boolean {
  switch (mode) {
    case "never":
      return false;
    case "on-findings":
      return hasFindings;
    case "before-complete":
    case "always":
      return true;
  }
}

/**
 * 05 section 8 + 06 sections 6/8: the Manager proposes, the Control Plane enforces
 * loop guards, and an exhausted budget pauses into needs_attention rather than failing.
 */
export function applyManagerDecision(ctx: ManagerDecisionContext): ManagerOutcome {
  const { decision, loop, budget } = ctx;

  if (detectNoProgress(loop.fingerprints, budget.maxNoProgressRounds)) {
    return {
      kind: "needs-attention",
      limit: "max_no_progress_rounds",
      message: `no progress after ${budget.maxNoProgressRounds} identical rounds`,
    };
  }

  switch (decision.type) {
    case "abort":
      return { kind: "abort", reason: decision.reason };

    case "request_checkpoint":
      return {
        kind: "gate",
        checkpointKind: decision.checkpointKind,
        prompt: decision.prompt,
      };

    case "fix": {
      if (loop.fixRounds >= budget.maxFixRounds) {
        return {
          kind: "needs-attention",
          limit: "max_fix_rounds",
          message: `fix loop exceeded max_fix_rounds=${budget.maxFixRounds}`,
        };
      }
      return {
        kind: "fix",
        findingIds: decision.findingIds,
        loop: { ...loop, fixRounds: loop.fixRounds + 1 },
      };
    }

    case "additional_review": {
      if (loop.reviewRounds >= budget.maxReviewRounds) {
        return {
          kind: "needs-attention",
          limit: "max_review_rounds",
          message: `review loop exceeded max_review_rounds=${budget.maxReviewRounds}`,
        };
      }
      return { kind: "review-again", loop };
    }

    case "complete": {
      const blocking = blockingFindings(ctx.findings);
      if (blocking.length > 0) {
        return {
          kind: "needs-attention",
          limit: "max_no_progress_rounds",
          message: `cannot complete with ${blocking.length} unresolved blocking finding(s)`,
        };
      }
      if (reviewGateRequired(ctx.reviewGate, ctx.findings.findings.length > 0)) {
        return {
          kind: "gate",
          checkpointKind: "review-approval",
          prompt: "Review complete. Approve completion?",
        };
      }
      return { kind: "complete" };
    }
  }
}
