/**
 * Which error types Temporal must NOT retry — as a decision per error class,
 * not as a hand-maintained string list.
 *
 * ## Why a registry rather than a list
 *
 * `nonRetryableErrorTypes` matches the failure's TYPE, which for a plain
 * `Error` subclass thrown from an activity is its CLASS name — the SDK's
 * `ensureApplicationFailure` computes `error.constructor?.name ?? error.name`,
 * so `name` is consulted only when the thrown value has no constructor at all.
 * That makes the list a set of *strings* that has to agree with code living in
 * eight other packages, and every round of review has found it disagreeing:
 *
 *  - it listed `"ScopeViolation"` while `@meidoya/node-runtime` throws a
 *    `ScopeViolationError` — every scope violation was retried;
 *  - `SandboxViolationError` (`@meidoya/execution-native`, raised by
 *    `sandbox.narrowTo` and by `SandboxRunAssignment`) was in neither spelling
 *    — every sandbox denial was retried to exhaustion;
 *  - the one option set that carries `BudgetSnapshotUnreadableError`
 *    (`name = "PolicyViolation"`, thrown from `db.chargeBudget` /
 *    `db.extendBudget`) declared no `nonRetryableErrorTypes` at all — every
 *    corrupt-snapshot charge was retried ten times before the workflow paused;
 *  - and then the registry ITSELF listed the wrong string: the three refusals
 *    that set `this.name = "PolicyViolation"` were listed under that name while
 *    the server was matching `BudgetSnapshotUnreadableError`,
 *    `VerificationUnavailableError` and `VerificationPolicyError`. All three
 *    were retried to exhaustion with every declaration test green, because no
 *    test had ever watched Temporal decide. `refusals-runtime.test.ts` does.
 *
 * Four instances of one defect: a refusal was added somewhere in the repo and
 * nothing forced anyone to decide how Temporal should treat it — or the decision
 * was recorded in a spelling nothing compares against. So the decision is
 * recorded HERE, once per `Error` subclass in the repository,
 * `refusals.test.ts` scans the source tree and fails when a class exists that
 * this table does not classify, and `refusals-runtime.test.ts` throws each
 * refusal at a real server and counts the attempts. Adding an error class
 * anywhere is then a red test until its retry disposition is written down.
 *
 * ## The two dispositions
 *
 *  - `"refusal"` — a denial or a deterministic rejection: the same call made
 *    again cannot produce a different answer. Retrying only delays the error the
 *    operator needs to see, and (for a gate refusal) burns the budget while
 *    doing it. Its thrown name MUST appear in {@link NON_RETRYABLE_ERROR_TYPES}.
 *  - `"retry"` — transport, contention, or an error that never crosses an
 *    activity boundary at all (process startup config, framing on the node
 *    link, internal control flow). Its thrown name must NOT appear in the list:
 *    listing a transient failure is the opposite mistake and costs the retry
 *    that would have fixed it.
 */

export type ErrorDisposition = "refusal" | "retry";

export type ClassifiedError = {
  /** Source file, relative to the repository root. */
  readonly file: string;
  /**
   * The `name` a thrown instance carries.
   *
   * NOT, on its own, what Temporal matches: see the note below on
   * {@link NON_RETRYABLE_ERROR_TYPES}. It is listed anyway, because a peer that
   * raises an explicit `ApplicationFailure` (the execution node does, and an
   * older node build is a separate deployable) puts this string in the failure
   * type by hand. A class that never assigns `this.name` inherits `"Error"`,
   * which must never be listed — that would make every plain failure
   * non-retryable — so such a class is matched by its class name alone.
   */
  readonly thrownName: string;
  readonly disposition: ErrorDisposition;
  /** Why that disposition. Read this before changing one. */
  readonly why: string;
};

export const ERROR_CLASSIFICATION: Readonly<Record<string, ClassifiedError>> = {
  /* ------------------------------------------------------------ refusals */

  BudgetSnapshotUnreadableError: {
    file: "apps/meidoyad/src/ports.ts",
    thrownName: "PolicyViolation",
    disposition: "refusal",
    why: "a corrupt budget row: re-reading the same row never helps, and each retry delays the limit checkpoint the operator has to answer",
  },
  VerificationUnavailableError: {
    file: "apps/meidoyad/src/ports.ts",
    thrownName: "PolicyViolation",
    disposition: "refusal",
    why: "the control plane refusing to verify; a refusal, not a failure",
  },
  VerificationPolicyError: {
    file: "apps/meidoya-node/src/verification.ts",
    thrownName: "PolicyViolation",
    disposition: "refusal",
    why: "the execution node refusing a run — no sandbox, no gate catalog, an unresolvable project",
  },
  ScopeViolationError: {
    file: "packages/node-runtime/src/run-scope.ts",
    thrownName: "ScopeViolationError",
    disposition: "refusal",
    why: "the run scope denying a capability or a project; the denial is deterministic",
  },
  SandboxViolationError: {
    file: "packages/execution-native/src/errors.ts",
    thrownName: "SandboxViolationError",
    disposition: "refusal",
    why: "the sandbox denying a path (outside the allowed roots, a sensitive path, a symlink); asking again denies again",
  },
  AuthorizationError: {
    file: "packages/roles/src/authorize.ts",
    thrownName: "AuthorizationError",
    disposition: "refusal",
    why: "a role denied a capability; the role and the capability are both fixed for the attempt",
  },
  CredentialBoundaryError: {
    // Moved to @meidoya/agent-runtime so the Codex adapter is held to the same
    // boundary as the Claude one; `runtime-claude/src/credentials.ts` re-exports it.
    file: "packages/agent-runtime/src/credentials.ts",
    thrownName: "CredentialBoundaryError",
    disposition: "refusal",
    why: "a credential would have crossed a boundary it may not cross; retrying re-attempts the same leak",
  },
  QualityGateConfigError: {
    file: "packages/task-engine/src/quality-gates.ts",
    thrownName: "QualityGateConfigError",
    disposition: "refusal",
    why: "the operator's quality-gate catalog is malformed; it does not become well-formed on attempt two",
  },

  /* -------------------------------------------------------------- retry */

  IllegalTransitionError: {
    file: "packages/task-engine/src/state-machine.ts",
    thrownName: "IllegalTransitionError",
    disposition: "retry",
    why: "raised against a state read earlier in the attempt; a re-read can legitimately find a state the transition is legal from",
  },
  RollbackSignal: {
    file: "packages/task-engine/src/completion.ts",
    thrownName: "Error",
    disposition: "retry",
    why: "internal control flow for a transaction rollback; caught by its own caller and never crosses an activity boundary",
  },
  CheckpointConflictError: {
    file: "apps/meidoyad/src/repository.ts",
    thrownName: "CheckpointConflictError",
    disposition: "retry",
    why: "optimistic-concurrency contention; retrying IS the fix",
  },
  TransactionScopeError: {
    file: "apps/meidoyad/src/repository.ts",
    thrownName: "TransactionScopeError",
    disposition: "retry",
    why: "a transaction handle used out of scope; a fresh attempt opens a fresh transaction",
  },
  ControlPlaneError: {
    file: "packages/protocol/src/errors.ts",
    thrownName: "ControlPlaneError",
    disposition: "retry",
    why: "the generic dispatch error, carrying everything from a bad method to an overloaded handler; too coarse to refuse on",
  },
  ControlPlaneClientError: {
    file: "apps/meidoya/src/client.ts",
    thrownName: "ControlPlaneClientError",
    disposition: "retry",
    why: "CLI transport to the daemon; never inside an activity",
  },
  ControlPlaneCallError: {
    file: "apps/meidoya-node/src/control-plane-client.ts",
    thrownName: "ControlPlaneCallError",
    disposition: "retry",
    why: "node → control plane transport; a reconnect fixes it",
  },
  FrameTooLargeError: {
    file: "packages/protocol/src/envelope.ts",
    thrownName: "FrameTooLargeError",
    disposition: "retry",
    why: "framing on the node link, handled by the transport; not an activity failure",
  },
  WorkspaceIdInParamsError: {
    file: "packages/protocol/src/scope.ts",
    thrownName: "WorkspaceIdInParamsError",
    disposition: "retry",
    why: "a caller-side scoping bug caught while building a request; never returned from an activity",
  },
  ProtocolVersionMismatchError: {
    file: "apps/meidoya-node/src/node.ts",
    thrownName: "ProtocolVersionMismatchError",
    disposition: "retry",
    why: "raised during the node's connect handshake, before any activity is polled for",
  },
  NodeConfigError: {
    file: "packages/execution-native/src/config.ts",
    thrownName: "NodeConfigError",
    disposition: "retry",
    why: "node configuration read at startup; the process does not reach an activity with it",
  },
  ControlPlaneConfigError: {
    file: "apps/meidoyad/src/config.ts",
    thrownName: "ControlPlaneConfigError",
    disposition: "retry",
    why: "daemon configuration read at startup; the process does not reach an activity with it",
  },
  ChatTransportError: {
    file: "packages/chat-vercel/src/errors.ts",
    thrownName: "ChatTransportError",
    disposition: "retry",
    why: "chat transport; the notification publisher retries it on purpose",
  },
  ChatRateLimitError: {
    file: "packages/chat-vercel/src/errors.ts",
    thrownName: "ChatRateLimitError",
    disposition: "retry",
    why: "a rate limit is the definition of retry-after",
  },
  UnknownEmojiError: {
    file: "packages/chat-vercel/src/emoji.ts",
    thrownName: "UnknownEmojiError",
    disposition: "retry",
    why: "chat rendering, outside the task activity path entirely",
  },
  InvalidIngressBindingError: {
    file: "packages/chat-vercel/src/ingress.ts",
    thrownName: "InvalidIngressBindingError",
    disposition: "retry",
    why: "chat ingress configuration, outside the task activity path entirely",
  },
};

/**
 * Spellings that no class in this repository throws today, kept anyway.
 *
 * Two of them are the short forms the list used to carry ALONE, and dropping
 * them now would silently re-retry any failure a peer (or an older node build,
 * which is a different deployable on a different release cadence) still raises
 * under the short name. A superfluous entry costs nothing: it only ever means
 * "do not retry something nobody throws".
 */
export const REFUSAL_ALIASES: readonly string[] = [
  "ScopeViolation",
  "PolicyViolationError",
  "SandboxViolation",
];

/**
 * The types every activity option set declares as non-retryable.
 *
 * Derived, not typed out: a `"refusal"` entry above is in this list by
 * construction, which is the whole point — the list can no longer fall behind
 * the classes.
 *
 * ## Both spellings, and why the CLASS name is the load-bearing one
 *
 * The failure type Temporal compares against is produced by the SDK, not by us.
 * For anything that is not already an `ApplicationFailure` — which is every
 * plain `Error` subclass this repository throws from an activity —
 * `ensureApplicationFailure` (`@temporalio/common`) computes it as
 *
 *     error.constructor?.name ?? error.name
 *
 * so it is the CLASS name that crosses the boundary, and `error.name` is read
 * only when the value has no constructor at all. Listing `name` alone was the
 * fourth instance of this defect and the first the registry itself carried:
 * `BudgetSnapshotUnreadableError`, `VerificationUnavailableError` and
 * `VerificationPolicyError` all set `this.name = "PolicyViolation"`, that string
 * was duly listed, and all three were retried to exhaustion anyway because the
 * server was matching `"BudgetSnapshotUnreadableError"`. `refusals-runtime.test.ts`
 * now runs a real server and counts attempts, so a list that matches nothing is
 * a red test rather than a comment nobody can check.
 *
 * `thrownName` stays in the list beside the class name: a peer that raises an
 * explicit `ApplicationFailure` chooses its own type, and the execution node
 * does exactly that. Listing both costs nothing — an entry only ever means "do
 * not retry something under this type".
 */
export const NON_RETRYABLE_ERROR_TYPES: readonly string[] = [
  ...new Set([
    ...Object.entries(ERROR_CLASSIFICATION)
      .filter(([, entry]) => entry.disposition === "refusal")
      .flatMap(([className, entry]) => [className, entry.thrownName]),
    ...REFUSAL_ALIASES,
  ]),
].sort();
