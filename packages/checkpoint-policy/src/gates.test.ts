import { describe, expect, it } from "vitest";
import { resolveGate, resolveGates, type GateModes, type LayeredGatePolicy } from "./gates.js";

const environmentDefault: GateModes = {
  clarification: "when-needed",
  plan: "never",
  review: "never",
  "side-effect": "policy",
};

describe("policy precedence", () => {
  it("prefers the task override over workspace, pipeline and environment", () => {
    const policy: LayeredGatePolicy = {
      taskOverride: { plan: "always" },
      workspace: { plan: "on-risk" },
      pipeline: { plan: "never" },
      environmentDefault,
    };
    expect(resolveGate("plan", policy)).toEqual({
      kind: "plan",
      mode: "always",
      source: "task-override",
      mandatory: false,
      relaxationBlocked: false,
    });
  });

  it("falls back through workspace, pipeline, environment default", () => {
    expect(
      resolveGate("review", { workspace: { review: "always" }, environmentDefault }).source,
    ).toBe("workspace");
    expect(
      resolveGate("review", { pipeline: { review: "on-findings" }, environmentDefault }).source,
    ).toBe("pipeline");
    expect(resolveGate("review", { environmentDefault }).source).toBe("environment-default");
  });
});

describe("mandatory security policy", () => {
  it("cannot be relaxed by a task override", () => {
    const resolved = resolveGate("side-effect", {
      mandatorySecurity: { "side-effect": "always" },
      taskOverride: { "side-effect": "policy" },
      environmentDefault,
    });
    expect(resolved.mode).toBe("always");
    expect(resolved.source).toBe("mandatory-security");
    expect(resolved.mandatory).toBe(true);
    expect(resolved.relaxationBlocked).toBe(true);
  });

  it("cannot be relaxed by any lower layer, for any gate", () => {
    const policy: LayeredGatePolicy = {
      mandatorySecurity: {
        clarification: "always",
        plan: "always",
        review: "before-complete",
        "side-effect": "always",
      },
      taskOverride: { clarification: "never", plan: "never", review: "never", "side-effect": "policy" },
      workspace: { clarification: "never", plan: "never", review: "never", "side-effect": "policy" },
      pipeline: { clarification: "never", plan: "never", review: "never", "side-effect": "policy" },
      environmentDefault: {
        clarification: "never",
        plan: "never",
        review: "never",
        "side-effect": "policy",
      },
    };
    const gates = resolveGates(policy);
    expect(gates.clarification.mode).toBe("always");
    expect(gates.plan.mode).toBe("always");
    expect(gates.review.mode).toBe("before-complete");
    expect(gates["side-effect"].mode).toBe("always");
    for (const gate of Object.values(gates)) {
      expect(gate.relaxationBlocked).toBe(true);
      expect(gate.source).toBe("mandatory-security");
    }
  });

  it("lets a lower layer tighten beyond the mandatory floor", () => {
    const resolved = resolveGate("review", {
      mandatorySecurity: { review: "on-findings" },
      workspace: { review: "always" },
      environmentDefault,
    });
    expect(resolved.mode).toBe("always");
    expect(resolved.source).toBe("workspace");
    expect(resolved.mandatory).toBe(true);
    expect(resolved.relaxationBlocked).toBe(false);
    expect(resolved.mandatoryFloor).toBe("on-findings");
  });

  it("leaves gates without a mandatory floor unmarked", () => {
    const resolved = resolveGate("plan", { workspace: { plan: "on-risk" }, environmentDefault });
    expect(resolved.mandatory).toBe(false);
    expect(resolved.mandatoryFloor).toBeUndefined();
  });
});
