import { REDACTED, redactDeep } from "./redaction.js";
import type { AgentEvent } from "./types.js";

/**
 * The ONLY fields of an `AgentEvent` that leave `make` verbatim.
 *
 * WHY an allow-list rather than a list of text fields: the previous shape
 * ("redact these five known text fields") failed open — a new event field, or a
 * field that turned out to hold an object rather than a string, was emitted
 * raw. Everything here is an identifier or a closed enum that we or the vendor
 * generated, never model text; `runId`, `sequence` and `timestamp` are stamped
 * below and never come from the caller. Anything else is treated as derived
 * from vendor output and is deep-redacted.
 */
const VERBATIM_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "status",
  "level",
  "retryable",
  "externalSessionId",
]);

/** Assigns monotonic sequence numbers so adapters never hand-roll them. */
export class AgentEventFactory {
  private sequence = 0;

  constructor(
    private readonly runId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The single egress for runtime events. Redaction happens HERE rather than at
   * each call site: an adapter cannot emit an event without going through this
   * method, so a credential cannot leak by someone forgetting a helper call.
   *
   * Removing or narrowing the redaction below is what the
   * "chokepoint" regression tests in `redaction.test.ts` exist to catch.
   */
  make<E extends Omit<AgentEvent, "runId" | "sequence" | "timestamp">>(
    event: E,
  ): Extract<AgentEvent, { type: E["type"] }> {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
      if (VERBATIM_FIELDS.has(key)) {
        safe[key] = value;
        continue;
      }
      // Fail CLOSED: if a payload is exotic enough to break the walker, the
      // event still gets emitted, just without the value. `make` has no error
      // path of its own, and a throw here would abort the whole run.
      try {
        safe[key] = redactDeep(value);
      } catch {
        safe[key] = REDACTED;
      }
    }
    return {
      ...safe,
      runId: this.runId,
      sequence: this.sequence++,
      timestamp: this.now(),
    } as unknown as Extract<AgentEvent, { type: E["type"] }>;
  }
}
