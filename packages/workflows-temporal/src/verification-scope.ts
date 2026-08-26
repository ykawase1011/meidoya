import type { ProjectAccess, VerificationPlan } from "@meidoya/domain";

/**
 * Which project the execution node runs a task's verification commands in.
 *
 * 10 section 3: the node builds ONE sandbox per run, narrowed to one project.
 * It infers that project only when the task's workspace binds exactly one, and
 * raises a non-retryable `PolicyViolation` rather than guess between two — so a
 * workflow that sends no `projectId` cannot verify on any node that binds more
 * than one project, which is the ordinary case for a real workspace.
 *
 * The approved plan is the only authority for the answer, and the answer is the
 * project the plan may WRITE: verification exists to check the change that was
 * made, and the change was made where the plan could write. A plan with no
 * writable project (a research plan) falls back to its single project if it has
 * exactly one.
 *
 * Ambiguity returns `undefined` rather than a guess: the node's refusal is the
 * correct outcome for a plan that spans two writable projects, because nothing
 * here can know which one the commands belong to. Pure and total — it runs
 * inside workflow code.
 */
export function verificationProjectId(
  projects: readonly ProjectAccess[],
): string | undefined {
  const writable = projects.filter((access) => access.mode === "write");
  if (writable.length === 1) return writable[0]?.projectId;
  if (writable.length === 0 && projects.length === 1) return projects[0]?.projectId;
  return undefined;
}

/**
 * True when a verification plan cannot be evidence of anything.
 *
 * The workflow used to substitute `{ commands: [] }` whenever no plan had been
 * recorded, and `runVerification` reported `passed` for it — a missing quality
 * gate became a passing one. Both halves are fixed: `@meidoya/task-engine`'s
 * evaluator now fails an empty plan (`verification#no-commands`), and the
 * workflow does not send one in the first place. Neither replaces the other:
 * the evaluator protects every caller, this protects the operator from a task
 * that spends a verification-group charge to learn it had nothing to run.
 *
 * Plan validation already refuses an empty verification for the coding pipeline
 * (`requireVerification`), so on the pipelines shipped today this floor is not
 * reachable; `pipelines-guard.test.ts` pins the property that makes that true,
 * and this stays the fail-closed answer for the day it stops being.
 */
export function isVacuousVerification(plan: VerificationPlan | undefined): boolean {
  return plan === undefined || plan.commands.length === 0;
}
