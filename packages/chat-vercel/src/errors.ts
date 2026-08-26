/**
 * Transport errors. The outbox owns retry (07 section 5), so the transport only
 * classifies failures and never sleeps or retries internally.
 *
 * `retryable` and `retryAfterMs` are consumed by the outbox publisher, which
 * reads them STRUCTURALLY (`notification-outbox/src/publisher.ts`) rather than
 * through predicates exported from here: the outbox is transport agnostic and
 * must not depend on this package — chat-vercel already depends on the outbox,
 * so an import the other way would be a cycle. Predicates living here would
 * therefore have no production caller, which is why there are none.
 */
export class ChatTransportError extends Error {
  /**
   * DEFAULTS TO TRUE, and that direction is load-bearing.
   *
   * The publisher dead-letters on `retryable === false`, so whatever this
   * defaults to is what an UNCLASSIFIED failure means. Defaulting to `false`
   * made every failure nobody had thought about — a socket reset, a 408, a
   * malformed body, a brand-new platform error string — a permanent loss of the
   * notification at attempt 1. The outbox exists to deliver at least once, so
   * the only safe default is "try again": the attempt budget still bounds it.
   *
   * Permanence is therefore an explicit allowlist, never an omission. See
   * `isTerminalHttpStatus` here and `TERMINAL_SLACK_ERRORS` in slack/client.ts.
   */
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    options: { retryable?: boolean; status?: number; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatTransportError";
    this.retryable = options.retryable ?? true;
    if (options.status !== undefined) this.status = options.status;
  }
}

/**
 * HTTP statuses for which a retry cannot change the answer, as an ALLOWLIST.
 *
 * The rule: terminal means "this exact request will never be accepted" — the
 * resource does not exist, or the payload is one the platform refuses. It does
 * NOT mean "something is wrong right now". Anything the environment could fix
 * on its own (408, 425, 5xx) or by an operator repairing a credential (401)
 * keeps the backoff-and-retry path, so a rotated token drains its backlog
 * instead of destroying it.
 *
 * 403 is deliberately terminal while 401 is not: 401 says no valid credential
 * was presented (rotation repairs it and the queued rows then go out), 403 says
 * a valid credential is not allowed to do this (a grant change is a
 * re-provisioning, not a retry).
 */
const TERMINAL_HTTP_STATUSES: ReadonlySet<number> = new Set([
  400, // malformed request the platform will never accept
  403, // authenticated but not permitted
  404, // channel/message does not exist
  405,
  410, // gone
  413, // payload too large
  414,
  422, // semantically invalid payload
  431,
]);

export function isTerminalHttpStatus(status: number): boolean {
  return TERMINAL_HTTP_STATUSES.has(status);
}

export class ChatRateLimitError extends ChatTransportError {
  /** Platform-advertised cool-down. The outbox publisher backs off at least this long. */
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number, status = 429) {
    super(message, { retryable: true, status });
    this.name = "ChatRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Slack/Discord both advertise seconds; header may be absent or malformed. */
export function parseRetryAfterSeconds(raw: string | null | undefined, fallbackMs = 1_000): number {
  if (raw === null || raw === undefined) return fallbackMs;
  const seconds = Number.parseFloat(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
  return Math.ceil(seconds * 1_000);
}
