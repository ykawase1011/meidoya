import type { HumanCheckpointKind, ReviewFinding } from "@meidoya/domain";
import type { GateKind, ResolvedGate } from "./gates.js";

export type SideEffectKind =
  | "git.push"
  | "pull-request.create"
  | "deploy"
  | "external-message"
  | "credential.change"
  | "other";

export type GateSituation =
  | { kind: "clarification"; missingInformation: boolean }
  | { kind: "plan"; risk: "low" | "medium" | "high" }
  | { kind: "review"; findings: readonly ReviewFinding[]; aboutToComplete: boolean }
  | { kind: "side-effect"; effect: SideEffectKind; policyRequiresApproval: boolean };

export type StopReason =
  | "gate-disabled"
  | "gate-always"
  | "missing-information"
  | "no-missing-information"
  | "plan-risk-at-or-above-threshold"
  | "plan-risk-below-threshold"
  | "review-findings-present"
  | "no-review-findings"
  | "before-complete"
  | "not-completing-yet"
  | "policy-requires-approval"
  | "policy-allows";

export type StopDecision =
  | { stop: true; checkpointKind: HumanCheckpointKind; reason: StopReason; mandatory: boolean }
  | { stop: false; reason: StopReason };

export const GATE_CHECKPOINT_KIND: Readonly<Record<GateKind, HumanCheckpointKind>> = {
  clarification: "clarification",
  plan: "plan-approval",
  review: "review-approval",
  "side-effect": "side-effect-approval",
};

function stop(gate: ResolvedGate, reason: StopReason): StopDecision {
  return {
    stop: true,
    checkpointKind: GATE_CHECKPOINT_KIND[gate.kind],
    reason,
    mandatory: gate.mandatory,
  };
}

function decide(gate: ResolvedGate, situation: GateSituation): StopDecision {
  switch (situation.kind) {
    case "clarification": {
      if (gate.mode === "never") {
        return { stop: false, reason: "gate-disabled" };
      }
      if (gate.mode === "always") {
        return stop(gate, "gate-always");
      }
      return situation.missingInformation
        ? stop(gate, "missing-information")
        : { stop: false, reason: "no-missing-information" };
    }
    case "plan": {
      if (gate.mode === "never") {
        return { stop: false, reason: "gate-disabled" };
      }
      if (gate.mode === "always") {
        return stop(gate, "gate-always");
      }
      return situation.risk === "medium" || situation.risk === "high"
        ? stop(gate, "plan-risk-at-or-above-threshold")
        : { stop: false, reason: "plan-risk-below-threshold" };
    }
    case "review": {
      if (gate.mode === "never") {
        return { stop: false, reason: "gate-disabled" };
      }
      if (gate.mode === "always") {
        return stop(gate, "gate-always");
      }
      if (gate.mode === "before-complete") {
        return situation.aboutToComplete
          ? stop(gate, "before-complete")
          : { stop: false, reason: "not-completing-yet" };
      }
      return situation.findings.length > 0
        ? stop(gate, "review-findings-present")
        : { stop: false, reason: "no-review-findings" };
    }
    case "side-effect": {
      if (gate.mode === "always") {
        return stop(gate, "gate-always");
      }
      return situation.policyRequiresApproval
        ? stop(gate, "policy-requires-approval")
        : { stop: false, reason: "policy-allows" };
    }
  }
}

export function shouldStop<K extends GateKind>(
  gate: ResolvedGate<K>,
  situation: Extract<GateSituation, { kind: K }>,
): StopDecision {
  return decide(gate as ResolvedGate, situation as GateSituation);
}
