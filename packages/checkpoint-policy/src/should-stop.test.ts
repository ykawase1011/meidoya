import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "@meidoya/domain";
import { resolveGate, type GateModes, type LayeredGatePolicy } from "./gates.js";
import { shouldStop } from "./should-stop.js";

const environmentDefault: GateModes = {
  clarification: "when-needed",
  plan: "never",
  review: "never",
  "side-effect": "policy",
};

function gate<K extends keyof GateModes>(kind: K, mode: GateModes[K]) {
  const policy: LayeredGatePolicy = { taskOverride: { [kind]: mode }, environmentDefault };
  return resolveGate(kind, policy);
}

const finding: ReviewFinding = { id: "F1", severity: "blocking", summary: "unsafe" };

describe("clarification gate", () => {
  it("never stops when disabled", () => {
    expect(shouldStop(gate("clarification", "never"), {
      kind: "clarification",
      missingInformation: true,
    })).toEqual({ stop: false, reason: "gate-disabled" });
  });

  it("stops only when information is missing under when-needed", () => {
    const g = gate("clarification", "when-needed");
    expect(shouldStop(g, { kind: "clarification", missingInformation: false }).stop).toBe(false);
    expect(shouldStop(g, { kind: "clarification", missingInformation: true })).toMatchObject({
      stop: true,
      checkpointKind: "clarification",
    });
  });

  it("always stops under always", () => {
    expect(
      shouldStop(gate("clarification", "always"), {
        kind: "clarification",
        missingInformation: false,
      }).stop,
    ).toBe(true);
  });
});

describe("plan gate", () => {
  it("on-risk stops only at medium or high risk", () => {
    const g = gate("plan", "on-risk");
    expect(shouldStop(g, { kind: "plan", risk: "low" })).toEqual({
      stop: false,
      reason: "plan-risk-below-threshold",
    });
    expect(shouldStop(g, { kind: "plan", risk: "medium" })).toMatchObject({
      stop: true,
      checkpointKind: "plan-approval",
    });
    expect(shouldStop(g, { kind: "plan", risk: "high" }).stop).toBe(true);
  });

  it("never and always ignore risk", () => {
    expect(shouldStop(gate("plan", "never"), { kind: "plan", risk: "high" }).stop).toBe(false);
    expect(shouldStop(gate("plan", "always"), { kind: "plan", risk: "low" }).stop).toBe(true);
  });
});

describe("review gate", () => {
  it("on-findings stops only when there are findings", () => {
    const g = gate("review", "on-findings");
    expect(
      shouldStop(g, { kind: "review", findings: [], aboutToComplete: true }),
    ).toEqual({ stop: false, reason: "no-review-findings" });
    expect(
      shouldStop(g, { kind: "review", findings: [finding], aboutToComplete: false }),
    ).toMatchObject({ stop: true, checkpointKind: "review-approval" });
  });

  it("before-complete stops only at the completion boundary", () => {
    const g = gate("review", "before-complete");
    expect(shouldStop(g, { kind: "review", findings: [], aboutToComplete: false }).stop).toBe(
      false,
    );
    expect(shouldStop(g, { kind: "review", findings: [], aboutToComplete: true }).stop).toBe(true);
  });
});

describe("side-effect gate", () => {
  it("policy mode defers to the security policy verdict", () => {
    const g = gate("side-effect", "policy");
    expect(
      shouldStop(g, { kind: "side-effect", effect: "git.push", policyRequiresApproval: false }),
    ).toEqual({ stop: false, reason: "policy-allows" });
    expect(
      shouldStop(g, { kind: "side-effect", effect: "deploy", policyRequiresApproval: true }),
    ).toMatchObject({ stop: true, checkpointKind: "side-effect-approval" });
  });

  it("marks a mandatory gate stop as mandatory", () => {
    const resolved = resolveGate("side-effect", {
      mandatorySecurity: { "side-effect": "always" },
      taskOverride: { "side-effect": "policy" },
      environmentDefault,
    });
    const decision = shouldStop(resolved, {
      kind: "side-effect",
      effect: "credential.change",
      policyRequiresApproval: false,
    });
    expect(decision).toMatchObject({ stop: true, mandatory: true });
  });
});
