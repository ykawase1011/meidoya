import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEPRECATED_PATCH_IDS,
  TASK_WORKFLOW_PATCH_IDS,
} from "./patches.js";

const patchesSource = readFileSync(fileURLToPath(new URL("./patches.ts", import.meta.url)), "utf8");
const taskSource = readFileSync(
  fileURLToPath(new URL("./workflows/task.ts", import.meta.url)),
  "utf8",
);

/** The constant whose value is `id`, e.g. `TASK_BUDGET_CHARGE`. */
function constantNameOf(id: string): string {
  const match = new RegExp(`export const ([A-Z0-9_]+) = "${id}";`).exec(patchesSource);
  if (!match?.[1]) throw new Error(`no exported constant declares the patch id ${id}`);
  return match[1];
}

/**
 * The weak half of the versioning guard. `workflows/replay.test.ts` is the real
 * one — it replays recorded histories, so it fails on a replay-visible change
 * whether or not anyone remembered to declare a patch id. This file only makes
 * the failure legible: it says which id went missing, and it holds the naming
 * convention that keeps the ids sortable and unambiguous.
 */
describe("workflow patch ids", () => {
  it("follow the <area>-<change>-<yyyymm> convention", () => {
    for (const id of [...TASK_WORKFLOW_PATCH_IDS, ...DEPRECATED_PATCH_IDS]) {
      expect(id, `${id} is not <area>-<change>-<yyyymm>`).toMatch(
        /^[a-z][a-z0-9]*(-[a-z0-9]+)+-\d{6}$/,
      );
    }
  });

  it("are unique and never both live and deprecated", () => {
    const live = [...TASK_WORKFLOW_PATCH_IDS];
    expect(new Set(live).size).toBe(live.length);
    for (const id of DEPRECATED_PATCH_IDS) expect(live).not.toContain(id);
  });

  /**
   * Deleting a `patched()` call without draining the old executions first is
   * exactly the mistake this package exists to prevent, so every declared id has
   * to still be gating something.
   */
  it("are each still gating a block of TaskWorkflow", () => {
    for (const id of TASK_WORKFLOW_PATCH_IDS) {
      const constant = constantNameOf(id);
      expect(taskSource, `${id} (${constant}) is declared but never passed to patched()`).toContain(
        `patched(${constant})`,
      );
    }
  });

  /**
   * The other direction, which nothing checked: every `patched()` /
   * `deprecatePatch()` call in `TaskWorkflow` must name a DECLARED id.
   *
   * An inline `patched("something-i-made-up")` compiles, runs, writes a marker
   * into every history and appears in no list — so nobody knows to drain it,
   * `patches.ts` cannot say what its old branch was, and the id can never be
   * retired safely. It also silently breaks the rule that all the decisions are
   * taken in one place, since an inline call is by definition not in the
   * `version` object. Add `patched("unregistered-id")` anywhere in `task.ts`
   * and this goes red naming it.
   */
  it("are the only ids TaskWorkflow ever passes to patched()", () => {
    const declared = new Set(
      [...TASK_WORKFLOW_PATCH_IDS, ...DEPRECATED_PATCH_IDS].map(constantNameOf),
    );
    // Comments talk ABOUT `patched()`; only code calls it.
    const code = taskSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const calls = [...code.matchAll(/\b(?:patched|deprecatePatch)\(\s*([^\s)]+)\s*\)/g)];
    expect(calls.length, "TaskWorkflow calls patched() nowhere").toBeGreaterThan(0);
    for (const call of calls) {
      const argument = call[1] ?? "";
      expect(
        declared.has(argument),
        `patched(${argument}) names no id declared in patches.ts; declare it (and its legacy ` +
          "branch) there, or the marker it writes can never be drained",
      ).toBe(true);
    }
  });

  /**
   * And that they are all taken in the `version` object at the top, which is
   * what keeps one execution on one path end to end (README § Where the
   * decision is taken).
   */
  it("are all evaluated in TaskWorkflow's version object", () => {
    const versionBlock = /return runTaskWorkflow\(input, \{([\s\S]*?)\}\);/.exec(taskSource);
    expect(versionBlock, "TaskWorkflow no longer builds its version object in one place")
      .not.toBeNull();
    const inVersionBlock = [
      ...(versionBlock?.[1] ?? "").matchAll(/\bpatched\(\s*([^)]*?)\s*\)/g),
    ].map((m) => m[1]);
    expect(inVersionBlock.sort()).toEqual([...TASK_WORKFLOW_PATCH_IDS].map(constantNameOf).sort());
  });

  it("keep deprecated ids on deprecatePatch until they are removed", () => {
    for (const id of DEPRECATED_PATCH_IDS) {
      expect(taskSource).toContain(`deprecatePatch(${constantNameOf(id)})`);
    }
  });

  /**
   * A patch id is written into the history of every execution that runs through
   * it, so the literal may never be edited once deployed — only added or, after
   * a drain, removed. Spelling each one out here makes a silent rename a diff.
   */
  it("still spell the deployed ids exactly", () => {
    expect([...TASK_WORKFLOW_PATCH_IDS]).toEqual([
      "task-side-effect-gate-grant-202608",
      "task-side-effect-gate-union-202608",
      "task-side-effect-gate-pipeline-202608",
      "task-model-policy-routing-202608",
    ]);
  });

  /**
   * The mistake that produced the seven ids this file used to list: their legacy
   * branches reconstructed a release TWO generations back, so against the
   * release actually deployed they gated no difference — and `patched()`,
   * answering `false` for every in-flight history, steered those executions into
   * a branch that had never produced their command stream.
   *
   * There is no way to assert "the legacy branch equals the previous release"
   * from inside the suite; what can be asserted is that nobody re-adds an id
   * whose old path was already retired. The `-pre-<id-month>` fixtures in
   * `workflows/__fixtures__/histories/` are the real check: they are recorded
   * from the previous release's source, not from this one with the flags forced
   * off.
   */
  it("declares no id whose legacy branch predates the previous release", () => {
    for (const id of [...TASK_WORKFLOW_PATCH_IDS, ...DEPRECATED_PATCH_IDS]) {
      expect(
        RETIRED_PATCH_IDS,
        `${id} was retired as gating nothing against the deployed release; reusing it would ` +
          "write a marker no history can match",
      ).not.toContain(id);
    }
  });
});

/**
 * Ids that were written, found to gate no difference against the release that
 * was actually deployed, and removed before they ever reached a history. They
 * are listed so they can never be revived: an id is only ever safe to reuse if
 * no execution ever ran through it, and this list is the record of that claim.
 */
const RETIRED_PATCH_IDS: readonly string[] = [
  "task-gate-policy-load-202608",
  "task-budget-charge-202608",
  "task-step-outcome-202608",
  "task-step-gate-order-202608",
  "task-side-effect-gate-202608",
  "task-review-gate-always-202608",
  "task-gate-run-202608",
];
