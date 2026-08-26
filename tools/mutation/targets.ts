/**
 * The modules where a surviving mutant means a security or correctness boundary
 * is unguarded, and the vitest path filters that must fail when one is planted.
 *
 * `tests` is the *whole* evidence set for that module: the gate's claim is
 * "delete any guard in `file` and at least one of `tests` goes red". Listing a
 * broader set costs runtime; listing a narrower one weakens the claim to
 * something the module's own unit test happens to notice. Cross-package suites
 * are included where a module's real enforcement is only observable end to end
 * (the daemon's tenant isolation, for instance, is asserted from
 * `cross-tenant.test.ts`, not from `repository.test.ts`).
 *
 * See `docs/mutation-testing.md` for how to add an entry.
 */
export type MutationTarget = {
  file: string;
  tests: string[];
  /** Why a surviving mutant here is a shipped vulnerability, not a nit. */
  why: string;
};

export const TARGETS: readonly MutationTarget[] = [
  {
    file: "packages/workspace-scope/src/token.ts",
    tests: ["packages/workspace-scope/"],
    why: "Mints and verifies the capability token that authorises every scoped API call.",
  },
  {
    file: "packages/node-runtime/src/run-scope.ts",
    tests: [
      "packages/node-runtime/",
      "apps/meidoya-node/src/run-scope.test.ts",
      "apps/meidoya-node/src/node.test.ts",
    ],
    why: "Seals the authoritative run scope over whatever a worker claims; a survivor is prompt-injected privilege escalation.",
  },
  /* ------------------------------------------------------------------------
   * SURVEYED BUT NOT YET GATED
   *
   * The modules below were measured with this harness and are commented out
   * rather than deleted, so widening the gate starts from data instead of from
   * scratch. First-run survivor counts, with the evidence sets shown:
   *
   *   apps/meidoyad/src/api.ts                118 / 155   (api, cross-tenant, server)
   *   apps/meidoyad/src/scope.ts               68 / 125   (scope, cross-tenant)
   *   apps/meidoya-node/src/verification.ts    51 / 162   (verification, node)
   *   apps/meidoyad/src/repository.ts          47 / 123   (repository, cross-tenant, api)
   *   apps/meidoyad/src/server.ts              37 / 63    (server, api)
   *   apps/meidoyad/src/ports.ts               26 / 124   (ports, api)
   *   apps/meidoyad/src/client-credentials.ts  12 / 46    (client-credentials, server)
   *   packages/notification-outbox/src/{publisher,repository}.ts — not completed
   *
   * These are NOT 359 confirmed gaps, and must not be booked as known-gaps
   * until each is re-measured. The daemon numbers in particular are inflated by
   * this gate's standing exclusion of the Temporal-backed suites: `api.ts` at
   * 76% survival is a statement about `api.test.ts` having six tests while the
   * daemon's real behaviour is asserted from `gates.test.ts` and
   * `daemon.test.ts`, both of which stand up a `TestWorkflowEnvironment`.
   *
   * Widening therefore means, per module: decide the honest evidence set first
   * (a calibration run on `apps/meidoyad/src/scope.ts` with `server.test.ts`
   * and `repository.test.ts` added is queued for exactly this reason), re-run,
   * and only then split the result into fixes, allowlist and known-gaps.
   * ------------------------------------------------------------------------ */

  /*
  {
    file: "apps/meidoyad/src/scope.ts",
    // `server.test.ts` and `repository.test.ts` both stand up a real
    // `ScopeRegistry`, so they are part of this module's honest evidence set,
    // not a bystander suite that happens to import it.
    tests: [
      "apps/meidoyad/src/scope.test.ts",
      "apps/meidoyad/src/cross-tenant.test.ts",
      "apps/meidoyad/src/server.test.ts",
      "apps/meidoyad/src/repository.test.ts",
    ],
    why: "Derives the tenant/workspace scope every repository read is filtered by.",
  },
  {
    file: "apps/meidoyad/src/repository.ts",
    tests: [
      "apps/meidoyad/src/repository.test.ts",
      "apps/meidoyad/src/cross-tenant.test.ts",
      "apps/meidoyad/src/api.test.ts",
    ],
    why: "Holds the cross-tenant read predicate that was once deletable with the suite green.",
  },
  {
    file: "apps/meidoyad/src/api.ts",
    tests: [
      "apps/meidoyad/src/api.test.ts",
      "apps/meidoyad/src/cross-tenant.test.ts",
      "apps/meidoyad/src/server.test.ts",
    ],
    why: "The daemon's authorisation surface: profile binding, workspace binding, request validation.",
  },
  {
    file: "apps/meidoyad/src/ports.ts",
    tests: ["apps/meidoyad/src/ports.test.ts", "apps/meidoyad/src/api.test.ts"],
    why: "Adapts untrusted transport input into domain calls; the budget charge verdict lives here.",
  },
  {
    file: "apps/meidoyad/src/server.ts",
    tests: ["apps/meidoyad/src/server.test.ts", "apps/meidoyad/src/api.test.ts"],
    why: "Socket ingress: peer credential checks and the profile a connection is bound to.",
  },
  {
    file: "apps/meidoyad/src/client-credentials.ts",
    tests: [
      "apps/meidoyad/src/client-credentials.test.ts",
      "apps/meidoyad/src/server.test.ts",
    ],
    why: "Decides which OS peer may speak to the daemon at all.",
  },
  {
    file: "apps/meidoya-node/src/verification.ts",
    tests: ["apps/meidoya-node/src/verification.test.ts", "apps/meidoya-node/src/node.test.ts"],
    why: "The verification floor: four separate checks here were once individually deletable.",
  },
  {
    file: "packages/notification-outbox/src/repository.ts",
    tests: ["packages/notification-outbox/"],
    why: "At-least-once delivery bookkeeping: lease, retry and dedupe predicates.",
  },
  {
    file: "packages/notification-outbox/src/publisher.ts",
    tests: ["packages/notification-outbox/"],
    why: "Publishes to external transports; a survivor leaks or drops a notification.",
  },
  */

  /* -------------------------------------------------------------- GATED --- */

  {
    file: "packages/workflows-temporal/src/refusals.ts",
    tests: ["packages/workflows-temporal/src/refusals.test.ts"],
    why: "Classifies a failure as non-retryable; a survivor turns a hard refusal into an infinite retry.",
  },
  {
    file: "packages/workflows-temporal/src/plan-capabilities.ts",
    tests: [
      "packages/workflows-temporal/src/plan-capabilities.test.ts",
      "packages/workflows-temporal/src/verification-scope.test.ts",
    ],
    why: "Intersects a plan's requested capabilities with what the workspace actually grants.",
  },
  {
    file: "packages/task-engine/src/completion.ts",
    tests: ["packages/task-engine/src/completion.test.ts", "packages/task-engine/src/review.test.ts"],
    why: "Decides a task is done; a survivor completes a task whose review or verification never passed.",
  },
];
