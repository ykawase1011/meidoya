import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTINUE_AS_NEW_THRESHOLDS,
  shouldContinueAsNew,
  type ContinueAsNewSignals,
} from "./continue-as-new.js";

function signals(overrides: Partial<ContinueAsNewSignals> = {}): ContinueAsNewSignals {
  return {
    temporalSuggested: false,
    historyLength: 10,
    historySizeBytes: 1024,
    elapsedMs: 1000,
    policyRevision: 3,
    startedWithPolicyRevision: 3,
    pendingHandlers: 0,
    ...overrides,
  };
}

describe("continue-as-new", () => {
  it("keeps running a quiet long-lived workflow", () => {
    expect(shouldContinueAsNew(signals())).toEqual({ continueAsNew: false });
  });

  it("rotates on each trigger from 08 section 5", () => {
    expect(shouldContinueAsNew(signals({ temporalSuggested: true }))).toEqual({
      continueAsNew: true,
      reason: "temporal-suggested",
    });
    expect(
      shouldContinueAsNew(
        signals({ historyLength: DEFAULT_CONTINUE_AS_NEW_THRESHOLDS.maxHistoryLength }),
      ),
    ).toEqual({ continueAsNew: true, reason: "history-length" });
    expect(
      shouldContinueAsNew(
        signals({ historySizeBytes: DEFAULT_CONTINUE_AS_NEW_THRESHOLDS.maxHistorySizeBytes }),
      ),
    ).toEqual({ continueAsNew: true, reason: "history-size" });
    expect(
      shouldContinueAsNew(signals({ elapsedMs: DEFAULT_CONTINUE_AS_NEW_THRESHOLDS.maxElapsedMs })),
    ).toEqual({ continueAsNew: true, reason: "elapsed-time" });
    expect(shouldContinueAsNew(signals({ policyRevision: 4 }))).toEqual({
      continueAsNew: true,
      reason: "policy-revision",
    });
  });

  it("waits for pending handlers to drain before rotating", () => {
    expect(shouldContinueAsNew(signals({ temporalSuggested: true, pendingHandlers: 1 }))).toEqual({
      continueAsNew: false,
      blockedBy: "pending-handlers",
      reason: "temporal-suggested",
    });
    expect(
      shouldContinueAsNew(signals({ temporalSuggested: true, inFlightRequests: 2 })),
    ).toMatchObject({ continueAsNew: false, blockedBy: "pending-handlers" });
  });

  it("honours custom thresholds", () => {
    const decision = shouldContinueAsNew(signals({ historyLength: 50 }), {
      maxHistoryLength: 40,
      maxHistorySizeBytes: 1_000_000,
      maxElapsedMs: 1_000_000,
    });
    expect(decision).toEqual({ continueAsNew: true, reason: "history-length" });
  });
});
