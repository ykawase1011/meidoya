/**
 * Mutants that survive because they are *equivalent* — the mutated program has
 * the same observable behaviour as the original, so no test can distinguish
 * them and none should be written.
 *
 * The standard of proof is an ARGUMENT, not an assertion. "This is hard to
 * test" is not an equivalent mutant, it is a missing test. A reason must say
 * why the mutated program cannot be observed to differ, naming the invariant
 * that makes it so. A reviewer who cannot reconstruct the argument from the
 * one-liner should reject the entry.
 *
 * Entries are keyed by `Mutant.id`, which encodes file, enclosing scope,
 * mutator and the mutated source text — but deliberately no line number, so an
 * edit elsewhere in the file does not silently re-point an entry at a different
 * guard. If the guard itself is edited the id changes, the entry goes stale,
 * and `tools/mutation/run.ts` fails the build until it is re-argued.
 *
 * A stale entry (allowlisted but now killed) is also a build failure: it means
 * a real test now covers the mutant and the exemption must be deleted.
 */
export type AllowlistEntry = {
  readonly id: string;
  /** One line. Why no test can tell the mutant from the original. */
  readonly reason: string;
};

export const ALLOWLIST: readonly AllowlistEntry[] = [
  /* ------------------------------- packages/workspace-scope/src/token.ts */

  {
    id: "packages/workspace-scope/src/token.ts:peekVersion:ConditionFalse:typeof parsed !== \"object\" || parsed === null=>false#0",
    reason:
      "Shadowed by the enclosing try/catch: with the guard gone, `null[\"v\"]` throws and is caught, and every non-object reads `[\"v\"]` as undefined — both paths return undefined, exactly as the guard does.",
  },
  {
    id: "packages/workspace-scope/src/token.ts:peekVersion:LogicalOperator:||=>&&#0",
    reason:
      "`typeof x !== \"object\" && x === null` is unsatisfiable — `typeof null` IS \"object\" — so the mutant is the no-guard case, which the try/catch already makes indistinguishable (see the entry above).",
  },
  {
    id: "packages/workspace-scope/src/token.ts:verifyScopeToken:LogicalOperator:||=>&&#0",
    reason:
      "Both operands are dead: the `parts.length !== 2` return two lines above means `body` and `mac` are never undefined at runtime, so `(A && B)` and `(A || B)` are both constant false and the surviving `body === \"\" || mac === \"\"` decides identically.",
  },
  {
    id: "packages/workspace-scope/src/token.ts:verifyScopeToken:LogicalOperator:||=>&&#1",
    reason:
      "Collapses the chain to `mac === \"\"`, dropping only the `body === \"\"` arm — and an empty body cannot decode to JSON, so `parsePayload` returns undefined and the same `\"malformed\"` is returned nine lines later.",
  },
  {
    id: "packages/workspace-scope/src/token.ts:verifyScopeToken:ConditionFalse:payload.v !== TOKEN_VERSION=>false#0",
    reason:
      "Unreachable: `parsePayload` only returns when `v` is a number, and `peekVersion` reads that same field from the same bytes and has already returned \"unsupported-version\" for any number but TOKEN_VERSION.",
  },
  {
    id: "packages/workspace-scope/src/token.ts:verifyScopeToken:BooleanLiteral:false=>true#4",
    reason:
      "The `ok` field of the return inside that same unreachable version branch — no input reaches the statement, for the reason argued directly above.",
  },
  {
    id: "packages/workspace-scope/src/token.ts:verifyScopeToken:BooleanLiteral:false=>true#6",
    reason:
      "Sits in a catch that cannot run: `Buffer.from(s, \"base64url\")` never throws for any string — Node's decoder skips characters outside the alphabet rather than rejecting them — so the catch body is dead code kept as defence against a future decoder.",
  },
];
