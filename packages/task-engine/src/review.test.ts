import { describe, expect, it } from "vitest";
import type { ExecutionBudget, ReviewFindings } from "@meidoya/domain";

import {
  applyManagerDecision,
  detectNoProgress,
  findingsFingerprint,
  recordReviewRound,
  repeatedFindingIds,
  type ReviewLoopState,
} from "./review.js";

const budget: ExecutionBudget = {
  maxSteps: 24,
  maxStepVisits: 5,
  maxFixRounds: 2,
  maxReviewRounds: 2,
  maxNoProgressRounds: 2,
  maxParallelWorkers: 3,
  maxModelEscalations: 2,
  maxConsecutiveFailures: 3,
  maxWallTimeMs: 1000,
};

const noFindings: ReviewFindings = { findings: [] };
const minorFindings: ReviewFindings = {
  findings: [{ id: "F-1", severity: "minor", summary: "naming" }],
};
const blockingFindings: ReviewFindings = {
  findings: [{ id: "F-2", severity: "blocking", summary: "null deref" }],
};

const loop: ReviewLoopState = { reviewRounds: 0, fixRounds: 0, fingerprints: [] };

describe("review findings", () => {
  it("fingerprints by stable finding id regardless of order", () => {
    const a = findingsFingerprint({
      findings: [
        { id: "F-1", severity: "minor", summary: "a" },
        { id: "F-2", severity: "minor", summary: "b" },
      ],
    });
    const b = findingsFingerprint({
      findings: [
        { id: "F-2", severity: "minor", summary: "different text" },
        { id: "F-1", severity: "minor", summary: "also different" },
      ],
    });
    expect(a).toBe(b);
  });

  it("detects repeated findings across rounds", () => {
    expect(repeatedFindingIds(minorFindings, minorFindings)).toEqual(["F-1"]);
    expect(repeatedFindingIds(minorFindings, blockingFindings)).toEqual([]);
    expect(repeatedFindingIds(undefined, minorFindings)).toEqual([]);
  });

  it("feeds identical rounds into no-progress detection", () => {
    let state = loop;
    state = recordReviewRound(state, minorFindings);
    expect(detectNoProgress(state.fingerprints, 2)).toBe(false);
    state = recordReviewRound(state, minorFindings);
    expect(detectNoProgress(state.fingerprints, 2)).toBe(true);
    expect(state.reviewRounds).toBe(2);
  });

  it("does not report no-progress when the round changed", () => {
    let state = recordReviewRound(loop, minorFindings);
    state = recordReviewRound(state, blockingFindings);
    expect(detectNoProgress(state.fingerprints, 2)).toBe(false);
  });
});

describe("manager decision handling", () => {
  it("completes when there are no blocking findings and no review gate", () => {
    expect(
      applyManagerDecision({
        decision: { type: "complete" },
        loop,
        findings: noFindings,
        budget,
        reviewGate: "never",
      }),
    ).toEqual({ kind: "complete" });
  });

  it("routes completion through the review gate when policy demands it", () => {
    expect(
      applyManagerDecision({
        decision: { type: "complete" },
        loop,
        findings: noFindings,
        budget,
        reviewGate: "before-complete",
      }),
    ).toMatchObject({ kind: "gate", checkpointKind: "review-approval" });

    expect(
      applyManagerDecision({
        decision: { type: "complete" },
        loop,
        findings: minorFindings,
        budget,
        reviewGate: "on-findings",
      }),
    ).toMatchObject({ kind: "gate" });

    expect(
      applyManagerDecision({
        decision: { type: "complete" },
        loop,
        findings: noFindings,
        budget,
        reviewGate: "on-findings",
      }),
    ).toEqual({ kind: "complete" });
  });

  it("refuses completion while a blocking finding is unresolved", () => {
    expect(
      applyManagerDecision({
        decision: { type: "complete" },
        loop,
        findings: blockingFindings,
        budget,
        reviewGate: "never",
      }),
    ).toMatchObject({ kind: "needs-attention" });
  });

  it("counts fix rounds and pauses instead of failing when exhausted", () => {
    const first = applyManagerDecision({
      decision: { type: "fix", findingIds: ["F-1"] },
      loop,
      findings: minorFindings,
      budget,
      reviewGate: "never",
    });
    expect(first).toMatchObject({ kind: "fix", findingIds: ["F-1"] });

    const exhausted = applyManagerDecision({
      decision: { type: "fix", findingIds: ["F-1"] },
      loop: { ...loop, fixRounds: 2 },
      findings: minorFindings,
      budget,
      reviewGate: "never",
    });
    expect(exhausted).toMatchObject({ kind: "needs-attention", limit: "max_fix_rounds" });
  });

  it("limits additional review rounds", () => {
    expect(
      applyManagerDecision({
        decision: { type: "additional_review" },
        loop: { ...loop, reviewRounds: 2 },
        findings: minorFindings,
        budget,
        reviewGate: "never",
      }),
    ).toMatchObject({ kind: "needs-attention", limit: "max_review_rounds" });
  });

  it("stops on no progress before honouring any decision", () => {
    const stuck: ReviewLoopState = {
      reviewRounds: 1,
      fixRounds: 1,
      fingerprints: ["same", "same"],
    };
    expect(
      applyManagerDecision({
        decision: { type: "fix", findingIds: ["F-1"] },
        loop: stuck,
        findings: minorFindings,
        budget,
        reviewGate: "never",
      }),
    ).toMatchObject({ kind: "needs-attention", limit: "max_no_progress_rounds" });
  });

  it("passes through explicit checkpoint requests and aborts", () => {
    expect(
      applyManagerDecision({
        decision: {
          type: "request_checkpoint",
          checkpointKind: "side-effect-approval",
          prompt: "push?",
        },
        loop,
        findings: noFindings,
        budget,
        reviewGate: "never",
      }),
    ).toEqual({ kind: "gate", checkpointKind: "side-effect-approval", prompt: "push?" });

    expect(
      applyManagerDecision({
        decision: { type: "abort", reason: "scope" },
        loop,
        findings: noFindings,
        budget,
        reviewGate: "never",
      }),
    ).toEqual({ kind: "abort", reason: "scope" });
  });
});
