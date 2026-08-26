/**
 * NOT an allowlist. This is debt.
 *
 * An entry in `tools/mutation/allowlist.ts` claims *no test can kill this
 * mutant*. An entry here admits the opposite: **a test could kill it, and nobody
 * has written it.** Each line is a guard in a gated module that can be deleted
 * today with its suite still green — a shipped defect of exactly the kind this
 * gate exists to stop, recorded rather than hidden.
 *
 * Why record them at all instead of just failing: the first real run of the gate
 * found these already in the tree. Failing the build on pre-existing debt would
 * have meant either disabling the gate or silently exempting the debt as
 * "equivalent", and the second is the failure mode this whole exercise is about.
 * So the gate ratchets: any survivor in neither list fails the build, and this
 * list may only shrink.
 *
 * Deleting an entry is the unit of progress: pick one, run
 * `pnpm mutation --targets <module>`, write the test that kills it, delete the
 * line. Adding one deserves the same review as merging a known vulnerability,
 * because that is what it is.
 */
export type KnownGap = {
  readonly id: string;
  /** What is unguarded, in the reviewer's terms — not a restatement of the id. */
  readonly gap: string;
};

export const KNOWN_GAPS: readonly KnownGap[] = [
  /* --------------------- packages/workflows-temporal/src/plan-capabilities.ts
   *
   * Every entry below is a predicate in the plan-capability intersection with
   * no failing test. Read the module's own caveat before picking one up: its
   * declared evidence set excludes `workflows/task.test.ts`, which stands up a
   * Temporal test server and is out of scope for this gate (see
   * docs/mutation-testing.md). A calibration run with that suite added killed
   * one of three sampled survivors, so a minority of these would already be
   * caught end to end — the gate over-reports here, in the safe direction.
   */
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:stepCapabilities:BooleanLiteral:true=>false#0",
    gap: "plan-capabilities.ts:85 (BooleanLiteral) — a step declaring no capabilities is treated as needing none; the empty-declaration path is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:stepCapabilities.writes:LogicalOperator:||=>&&#0",
    gap: "plan-capabilities.ts:90 (LogicalOperator) — write-mode detection for a step's own projects: no test supplies a read-mode project to distinguish the arms",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:stepCapabilities.writes:LogicalOperator:||=>&&#1",
    gap: "plan-capabilities.ts:91 (LogicalOperator) — same predicate, second project arm: unexercised",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:stepCapabilities:LogicalOperator:||=>&&#0",
    gap: "plan-capabilities.ts:97 (LogicalOperator) — the shell / repo.write implication for an acting step is never asserted on its own",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:stepCapabilities:LogicalOperator:||=>&&#3",
    gap: "plan-capabilities.ts:100 (LogicalOperator) — the network implication for an acting step is never asserted on its own",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:ownStepRequests.writableProjects:EqualityOperator:====>!==#0",
    gap: "plan-capabilities.ts:139 (EqualityOperator) — writable-project filtering compares mode with no test that supplies a read-mode project",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:planCapabilityUnion:ConditionFalse:plan.projects.some((access) => access.mode === \"write\")=>false#0",
    gap: "plan-capabilities.ts:164 (ConditionFalse) — the plan-wide write-mode union is never exercised with a plan that holds no write access",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:planCapabilityUnion:ConditionFalse:plan.verification.commands.length > 0=>false#0",
    gap: "plan-capabilities.ts:168 (ConditionFalse) — the verification-commands union is never exercised with an empty command list",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:widenToPlanExternals:ConditionFalse:!own.includes(\"shell\") && !own.includes(\"repo.write\")=>false#0",
    gap: "plan-capabilities.ts:185 (ConditionFalse) — the 'plan already owns shell or repo.write' short-circuit in widenToPlanExternals is unasserted in both directions",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:widenToPlanExternals:ConditionTrue:!own.includes(\"shell\") && !own.includes(\"repo.write\")=>true#0",
    gap: "plan-capabilities.ts:185 (ConditionTrue) — the 'plan already owns shell or repo.write' short-circuit in widenToPlanExternals is unasserted in both directions",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:widenToPlanExternals:RemoveNegation:!own.includes(\"shell\")=>own.includes(\"shell\")#0",
    gap: "plan-capabilities.ts:185 (RemoveNegation) — the 'plan already owns shell or repo.write' short-circuit in widenToPlanExternals is unasserted in both directions",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:widenToPlanExternals:LogicalOperator:&&=>||#0",
    gap: "plan-capabilities.ts:185 (LogicalOperator) — the 'plan already owns shell or repo.write' short-circuit in widenToPlanExternals is unasserted in both directions",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:widenToPlanExternals:RemoveNegation:!own.includes(\"repo.write\")=>own.includes(\"repo.write\")#0",
    gap: "plan-capabilities.ts:185 (RemoveNegation) — the 'plan already owns shell or repo.write' short-circuit in widenToPlanExternals is unasserted in both directions",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:widenToPlanExternals:ConditionFalse:planWide.includes(capability)=>false#0",
    gap: "plan-capabilities.ts:188 (ConditionFalse) — the plan-wide capability membership test in widenToPlanExternals is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:widenToPlanExternals:ConditionTrue:planWide.includes(capability)=>true#0",
    gap: "plan-capabilities.ts:188 (ConditionTrue) — the plan-wide capability membership test in widenToPlanExternals is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:derivePlanSideEffectCapabilities:ConditionFalse:sideEffectCapabilities(granted).length === 0=>false#0",
    gap: "plan-capabilities.ts:252 (ConditionFalse) — the 'no side effects at all' early return is never taken by a test",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:derivePipelineSideEffectCapabilities.writableProjects:EqualityOperator:====>!==#0",
    gap: "plan-capabilities.ts:311 (EqualityOperator) — pipeline-derived writable projects: the same untested mode comparison as line 139",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:derivePlanSideEffectCapabilitiesPerStepGrant:ConditionTrue:!gates=>true#0",
    gap: "plan-capabilities.ts:353 (ConditionTrue) — the missing-gate-catalog fallback is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:derivePlanSideEffectCapabilitiesPerStepGrant:ConditionFalse:EXTERNAL_CAPABILITIES.includes(capability)=>false#0",
    gap: "plan-capabilities.ts:358 (ConditionFalse) — external-capability membership in the per-step-grant path is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:derivePlanSideEffectCapabilitiesPerStepGrant:ConditionTrue:EXTERNAL_CAPABILITIES.includes(capability)=>true#0",
    gap: "plan-capabilities.ts:358 (ConditionTrue) — external-capability membership in the per-step-grant path is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:derivePlanSideEffectCapabilitiesIsolated:ConditionFalse:!requests.some((request) => sideEffectCapabilities(request.capabilities).leng...=>false#0",
    gap: "plan-capabilities.ts:404 (ConditionFalse) — the 'no request asks for a side effect' short-circuit in the isolated path is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:derivePlanSideEffectCapabilitiesIsolated:ConditionTrue:!requests.some((request) => sideEffectCapabilities(request.capabilities).leng...=>true#0",
    gap: "plan-capabilities.ts:404 (ConditionTrue) — the 'no request asks for a side effect' short-circuit in the isolated path is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:derivePlanSideEffectCapabilitiesIsolated:RemoveNegation:!requests.some((request) => sideEffectCapabilities(request.capabilities).leng...=>requests.some((request) => sideEffectCapabilities(request.capabilities).lengt...#0",
    gap: "plan-capabilities.ts:404 (RemoveNegation) — the 'no request asks for a side effect' short-circuit in the isolated path is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:derivePlanSideEffectCapabilitiesIsolated:ConditionalBoundary:>=><=#0",
    gap: "plan-capabilities.ts:404 (ConditionalBoundary) — the 'no request asks for a side effect' short-circuit in the isolated path is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:derivePlanSideEffectCapabilitiesIsolated:ConditionFalse:EXTERNAL_CAPABILITIES.includes(capability)=>false#0",
    gap: "plan-capabilities.ts:410 (ConditionFalse) — external-capability membership in the isolated path is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:derivePlanSideEffectCapabilitiesIsolated:ConditionTrue:EXTERNAL_CAPABILITIES.includes(capability)=>true#0",
    gap: "plan-capabilities.ts:410 (ConditionTrue) — external-capability membership in the isolated path is unasserted",
  },
  {
    id: "packages/workflows-temporal/src/plan-capabilities.ts:grantForStep:ConditionTrue:granted.includes(capability)=>true#0",
    gap: "plan-capabilities.ts:453 (ConditionTrue) — grantForStep's membership filter is unasserted",
  },
];
