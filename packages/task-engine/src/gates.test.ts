import { describe, expect, it } from "vitest";
import type { HumanCheckpointKind } from "@meidoya/domain";

import {
  APPROVAL_GATE_KINDS,
  gateGrantsProgress,
  gateResumeStatus,
  gateWaitStatus,
  type GateAnswer,
} from "./gates.js";

const ALL_KINDS: HumanCheckpointKind[] = [
  "clarification",
  "plan-approval",
  "review-approval",
  "side-effect-approval",
  "limit-exceeded",
];

const ANSWERS: GateAnswer[] = ["approved", "rejected", "answered"];

/**
 * `TaskWorkflow` branched on `answer === "rejected"` alone, so `"answered"` —
 * the third answer, and the one a text reply produces — meant "proceed" for
 * every approval gate. For `side-effect-approval` that handed a Worker the
 * capabilities a human had NOT approved; for `plan-approval` it ran the plan.
 */
describe("gateGrantsProgress", () => {
  it("never lets a rejection proceed", () => {
    for (const kind of ALL_KINDS) {
      expect(gateGrantsProgress(kind, "rejected"), `${kind} proceeded on a rejection`).toBe(false);
    }
  });

  it("requires an approval for the gates that grant an effect", () => {
    for (const kind of ["plan-approval", "side-effect-approval"] as const) {
      expect(gateGrantsProgress(kind, "approved")).toBe(true);
      expect(gateGrantsProgress(kind, "answered"), `${kind} treated an answer as consent`).toBe(
        false,
      );
    }
  });

  /**
   * The review gate is the exception, and deliberately so: its answer is not a
   * licence to act but the value the completion check reads, and `answered`
   * means "here is my feedback, keep working" — which is exactly where
   * `gateResumeStatus` sends it. Approval there is enforced by
   * `reviewGateSatisfied`, not by this predicate.
   */
  it("lets an answered review gate carry on without approving anything", () => {
    expect(gateGrantsProgress("review-approval", "answered")).toBe(true);
    expect(gateResumeStatus("review-approval", "answered", "running")).toBe("running");
    expect(gateResumeStatus("review-approval", "approved", "running")).toBe("completed");
  });

  it("lets a clarification carry on however it is answered, short of a rejection", () => {
    expect(gateGrantsProgress("clarification", "answered")).toBe(true);
    expect(gateGrantsProgress("clarification", "approved")).toBe(true);
  });

  /**
   * The two directions have to agree: a gate this predicate lets through must
   * not be one whose resume status is `needs_attention`, which is the state
   * meaning "a human has to look at this".
   */
  it("never proceeds into needs_attention", () => {
    for (const kind of ALL_KINDS) {
      for (const answer of ANSWERS) {
        if (!gateGrantsProgress(kind, answer)) continue;
        expect(
          gateResumeStatus(kind, answer, "running"),
          `${kind}/${answer} proceeds into a paused task`,
        ).not.toBe("needs_attention");
      }
    }
  });

  it("names the approval kinds and gives each one a wait state", () => {
    expect([...APPROVAL_GATE_KINDS].sort()).toEqual([
      "plan-approval",
      "review-approval",
      "side-effect-approval",
    ]);
    for (const kind of APPROVAL_GATE_KINDS) {
      expect(gateWaitStatus(kind)).toContain("waiting_");
    }
  });
});
