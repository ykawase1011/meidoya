/** 08 section 5: long-lived Maid / Head Maid workflows trim their event history. */

export type ContinueAsNewThresholds = {
  maxHistoryLength: number;
  maxHistorySizeBytes: number;
  maxElapsedMs: number;
};

export const DEFAULT_CONTINUE_AS_NEW_THRESHOLDS: ContinueAsNewThresholds = {
  maxHistoryLength: 8_000,
  maxHistorySizeBytes: 8 * 1024 * 1024,
  maxElapsedMs: 24 * 60 * 60 * 1000,
};

export type ContinueAsNewSignals = {
  temporalSuggested: boolean;
  historyLength: number;
  historySizeBytes: number;
  elapsedMs: number;
  policyRevision: number;
  startedWithPolicyRevision: number;
  /** Unfinished update/signal handlers; draining them first avoids losing work. */
  pendingHandlers: number;
  /** In-flight work the workflow itself owns (e.g. a request being dispatched). */
  inFlightRequests?: number;
};

export type ContinueAsNewReason =
  | "temporal-suggested"
  | "history-length"
  | "history-size"
  | "policy-revision"
  | "elapsed-time";

export type ContinueAsNewDecision =
  | { continueAsNew: true; reason: ContinueAsNewReason }
  | { continueAsNew: false; blockedBy: "pending-handlers"; reason: ContinueAsNewReason }
  | { continueAsNew: false };

export function continueAsNewReason(
  signals: ContinueAsNewSignals,
  thresholds: ContinueAsNewThresholds = DEFAULT_CONTINUE_AS_NEW_THRESHOLDS,
): ContinueAsNewReason | undefined {
  if (signals.policyRevision !== signals.startedWithPolicyRevision) return "policy-revision";
  if (signals.temporalSuggested) return "temporal-suggested";
  if (signals.historyLength >= thresholds.maxHistoryLength) return "history-length";
  if (signals.historySizeBytes >= thresholds.maxHistorySizeBytes) return "history-size";
  if (signals.elapsedMs >= thresholds.maxElapsedMs) return "elapsed-time";
  return undefined;
}

export function shouldContinueAsNew(
  signals: ContinueAsNewSignals,
  thresholds: ContinueAsNewThresholds = DEFAULT_CONTINUE_AS_NEW_THRESHOLDS,
): ContinueAsNewDecision {
  const reason = continueAsNewReason(signals, thresholds);
  if (!reason) return { continueAsNew: false };
  const pending = signals.pendingHandlers + (signals.inFlightRequests ?? 0);
  if (pending > 0) return { continueAsNew: false, blockedBy: "pending-handlers", reason };
  return { continueAsNew: true, reason };
}
