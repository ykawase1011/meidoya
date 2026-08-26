import { describe, expect, it } from "vitest";
import { nextEscalation, type EscalationState } from "./escalation.js";
import { parseModelPolicy } from "./policy.js";

const limits = { maxModelEscalations: 2 };

const start: EscalationState = {
  runtime: { provider: "codex", modelProfile: "economy" },
  escalations: 0,
};

describe("escalation ladder (09 section 7)", () => {
  it("does nothing when the attempt succeeded", () => {
    const decision = nextEscalation(start, { failed: false, progress: true }, limits);
    expect(decision.type).toBe("continue");
  });

  it("walks economy -> standard -> high and then to needs_attention", () => {
    const first = nextEscalation(start, { failed: true, failureClass: "test_failed", progress: false }, limits);
    expect(first.type).toBe("escalate");
    if (first.type !== "escalate") throw new Error("unreachable");
    expect(first.from).toBe("economy");
    expect(first.state.runtime.modelProfile).toBe("standard");
    expect(first.state.escalations).toBe(1);

    const second = nextEscalation(
      first.state,
      { failed: true, failureClass: "test_failed", progress: false },
      limits,
    );
    expect(second.type).toBe("escalate");
    if (second.type !== "escalate") throw new Error("unreachable");
    expect(second.state.runtime.modelProfile).toBe("high");
    expect(second.state.escalations).toBe(2);

    const third = nextEscalation(
      second.state,
      { failed: true, failureClass: "test_failed", progress: false },
      limits,
    );
    expect(third).toEqual({ type: "needs_attention", reason: "no_progress_at_high" });
  });

  it("retries instead of escalating when standard hits a different failure class", () => {
    const state: EscalationState = {
      runtime: { provider: "codex", modelProfile: "standard" },
      escalations: 1,
      lastFailureClass: "test_failed",
    };
    const decision = nextEscalation(
      state,
      { failed: true, failureClass: "network_error", progress: false },
      limits,
    );
    expect(decision.type).toBe("retry");
    if (decision.type === "retry") {
      expect(decision.state.runtime.modelProfile).toBe("standard");
      expect(decision.state.escalations).toBe(1);
    }
  });

  it("retries at high while there is still progress", () => {
    const state: EscalationState = {
      runtime: { provider: "codex", modelProfile: "high" },
      escalations: 2,
    };
    expect(nextEscalation(state, { failed: true, progress: true }, limits).type).toBe("retry");
  });

  it("stops at max_model_escalations", () => {
    const state: EscalationState = {
      runtime: { provider: "codex", modelProfile: "economy" },
      escalations: 1,
      lastFailureClass: "test_failed",
    };
    const decision = nextEscalation(
      state,
      { failed: true, failureClass: "test_failed", progress: false },
      { maxModelEscalations: 1 },
    );
    expect(decision).toEqual({ type: "needs_attention", reason: "escalation_limit_reached" });
  });

  it("stops when the higher profile is not allowed by policy", () => {
    const policy = parseModelPolicy({
      roles: {},
      worker_profiles: { "mechanical-editor": { allowed: ["codex-economy"] } },
    });
    const decision = nextEscalation(
      start,
      { failed: true, failureClass: "test_failed", progress: false },
      limits,
      { policy, workerProfile: "mechanical-editor" },
    );
    expect(decision).toEqual({ type: "needs_attention", reason: "no_allowed_higher_profile" });
  });
});
