import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "@meidoya/domain";

import { PIPELINES } from "@meidoya/task-engine";

import { capabilityGrantedSteps } from "./pipelines-guard.js";
import {
  derivePipelineSideEffectCapabilities,
  derivePlanCapabilities,
  derivePlanSideEffectCapabilities,
  derivePlanSideEffectCapabilitiesPerStepGrant,
  derivePlanStepCapabilities,
  grantForStep,
  planWideGrant,
  planRequestsSideEffects,
  planRequiresSideEffectApproval,
  plannedKindOfPipelineKind,
  sideEffectCapabilities,
  stepCapabilities,
} from "./plan-capabilities.js";

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    summary: "Tidy up the module.",
    risk: "low",
    projects: [{ projectId: "p1", mode: "write" }],
    steps: [
      {
        key: "impl",
        kind: "implement",
        description: "Rename the helper.",
        workerProfile: "implementer",
        dependsOn: [],
      },
    ],
    expectedArtifacts: [],
    verification: { commands: [{ name: "test" }] },
    ...overrides,
  };
}

describe("side-effect trigger is structured, not prose", () => {
  it("does not gate an ordinary implement plan", () => {
    expect(planRequiresSideEffectApproval(plan())).toBe(false);
    expect(derivePlanSideEffectCapabilities(plan())).toEqual([]);
  });

  it("gates a plan that never narrates its side effect", () => {
    // The exact evasion the string detector cannot see.
    const terse = plan({
      summary: "Finish the sync.",
      steps: [
        {
          key: "sync",
          kind: "other",
          description: "Run `scripts/sync.sh` to finish.",
          workerProfile: "researcher",
          dependsOn: [],
        },
      ],
    });

    expect(planRequestsSideEffects(terse)).toBe(false);
    // ...and yet the step it asks for holds shell + network egress.
    expect(planRequiresSideEffectApproval(terse)).toBe(true);
    expect(derivePlanSideEffectCapabilities(terse)).toContain("network");
  });

  /**
   * The ordinary coding plan, and the case the per-step trigger missed: neither
   * step trips it alone, and yet `grantForStep` hands the implementer the
   * researcher's `network` because the plan-wide union carries it. The trigger
   * has to be evaluated on the grant that is actually issued.
   */
  it("gates an ordinary researcher + implementer plan", () => {
    const ordinary = plan({
      steps: [
        {
          key: "look",
          kind: "investigate",
          description: "Read the module.",
          workerProfile: "researcher",
          dependsOn: [],
        },
        {
          key: "impl",
          kind: "implement",
          description: "Rename the helper.",
          workerProfile: "implementer",
          dependsOn: ["look"],
        },
      ],
    });

    // Nothing here narrates anything, and no single step's own request gates.
    expect(planRequestsSideEffects(ordinary)).toBe(false);
    expect(sideEffectCapabilities(["repo.read", "network"])).toEqual([]);
    expect(sideEffectCapabilities(["repo.read", "repo.write", "shell"])).toEqual([]);

    // The grant the implement step is issued does.
    expect(
      grantForStep(derivePlanCapabilities(ordinary), {
        kind: "implement",
        workerProfile: "implementer",
      }),
    ).toContain("network");
    expect(derivePlanSideEffectCapabilities(ordinary)).toEqual(["network"]);
    expect(planRequiresSideEffectApproval(ordinary)).toBe(true);
  });

  it("still gates a plan that does narrate one", () => {
    const narrated = plan({ summary: "deploy the service and open a pull request" });
    expect(planRequestsSideEffects(narrated)).toBe(true);
    expect(derivePlanSideEffectCapabilities(narrated)).toContain("external-side-effect");
  });

  /**
   * This used to assert the opposite, and the assertion was the defect written
   * down: a plan is not a pipeline. Nothing ties a plan whose only step reads
   * documentation to a pipeline that only reads — `input.pipeline` is chosen
   * before planning, so this plan on the coding pipeline hands `repo.write` +
   * `shell` + the plan's `network` to the `implement` step that the plan never
   * mentions. The read-only researcher's network is only free of a gate while
   * nothing that can act holds it, and `BASE_CAPABILITIES` means something
   * always does.
   */
  it("gates a read-only researcher's network, because an acting step gets it", () => {
    const research = plan({
      projects: [{ projectId: "p1", mode: "read" }],
      steps: [
        {
          key: "look",
          kind: "investigate",
          description: "Read the upstream docs.",
          workerProfile: "researcher",
          dependsOn: [],
        },
      ],
      verification: { commands: [] },
    });
    expect(derivePlanCapabilities(research)).toContain("network");
    // The plan itself asks for nothing that can act...
    expect(sideEffectCapabilities(derivePlanCapabilities(research))).toEqual([]);
    // ...but the grant an acting pipeline step receives does.
    expect(planWideGrant(research)).toContain("shell");
    expect(planRequiresSideEffectApproval(research)).toBe(true);
    expect(derivePlanSideEffectCapabilities(research)).toEqual(["network"]);
  });

  /**
   * The round-4 escape, as a plan: no acting step is DECLARED, so every trigger
   * that keys on the plan's own steps sees nothing — and the coding pipeline's
   * fixed `implement` step is handed `repo.read, repo.write, shell, network`
   * with no approval. `kind` and `workerProfile` are authored by the planning
   * agent, so this is the shape an adversarial plan takes.
   */
  it("gates a plan that declares no acting step at all", () => {
    const noActor = plan({
      steps: [
        {
          key: "look",
          kind: "investigate",
          description: "Read the module.",
          workerProfile: "researcher",
          dependsOn: [],
        },
        {
          key: "check",
          kind: "review",
          description: "Check the result.",
          workerProfile: "reviewer",
          dependsOn: ["look"],
        },
      ],
    });

    // Nothing narrates anything, and no PLANNED step's own widened request
    // holds both egress and an ability to act...
    expect(planRequestsSideEffects(noActor)).toBe(false);
    for (const grant of derivePlanStepCapabilities(noActor)) {
      expect(grant.requiresSideEffectApproval).toEqual([]);
    }
    // ...which is exactly what the previous release's trigger asked.
    expect(derivePlanSideEffectCapabilitiesPerStepGrant(noActor)).toEqual([]);

    // The grant the pipeline's `implement` step receives is the escape.
    expect(
      grantForStep(planWideGrant(noActor), {
        kind: "implement",
        workerProfile: "implementer",
      }),
    ).toEqual(["repo.read", "repo.write", "shell", "network"]);
    expect(planRequiresSideEffectApproval(noActor)).toBe(true);
    expect(derivePlanSideEffectCapabilities(noActor)).toEqual(["network"]);
  });

  it("treats every external capability of a gated plan as gated", () => {
    const gated = plan({
      steps: [
        {
          key: "sync",
          kind: "other",
          description: "Run the sync script.",
          workerProfile: "researcher",
          dependsOn: [],
        },
        {
          key: "impl",
          kind: "implement",
          description: "Publish the artefacts.",
          workerProfile: "implementer",
          dependsOn: [],
        },
      ],
    });
    const gating = derivePlanSideEffectCapabilities(gated);
    expect(gating).toContain("network");
    expect(gating).toContain("external-side-effect");
  });
});

describe("per-step capability derivation", () => {
  it("assumes a shell for an unclassified step", () => {
    expect(stepCapabilities({ kind: "other", workerProfile: "reviewer" })).toContain("shell");
  });

  it("withholds repo.write when no project is writable", () => {
    const caps = stepCapabilities(
      { kind: "implement", workerProfile: "implementer" },
      { writableProjects: false },
    );
    expect(caps).not.toContain("repo.write");
  });

  it("is pure and deterministic", () => {
    const p = plan();
    expect(derivePlanStepCapabilities(p)).toEqual(derivePlanStepCapabilities(p));
  });

  it("flags exec plus egress as side-effect capable", () => {
    expect(sideEffectCapabilities(["repo.read", "shell", "network"])).toEqual(["network"]);
    expect(sideEffectCapabilities(["repo.read", "network"])).toEqual([]);
    expect(sideEffectCapabilities(["repo.read", "package-install"])).toEqual(["package-install"]);
  });
});

describe("grantForStep", () => {
  const granted = ["repo.read", "repo.write", "shell", "external-side-effect"] as const;

  it("does not let a review step inherit an approved external effect", () => {
    expect(grantForStep([...granted], { kind: "review", workerProfile: "reviewer" })).toEqual([
      "repo.read",
    ]);
  });

  it("hands the approved effect to the step that can act", () => {
    expect(
      grantForStep([...granted], { kind: "implement", workerProfile: "implementer" }),
    ).toContain("external-side-effect");
  });

  it("never widens beyond what was granted", () => {
    expect(
      grantForStep(["repo.read"], { kind: "implement", workerProfile: "implementer" }),
    ).toEqual(["repo.read"]);
  });

  it("maps unknown pipeline kinds to the narrowest planned kind", () => {
    expect(plannedKindOfPipelineKind("aggregate")).toBe("investigate");
    expect(plannedKindOfPipelineKind("fix")).toBe("implement");
  });
});

/**
 * The trigger evaluated on what the RUNNING pipeline's steps are granted.
 *
 * `planWideGrant` unions `BASE_CAPABILITIES` in, so reading it whole made every
 * plan with a researcher step gate on every pipeline — a read-only research task
 * included. Narrowing it must not reopen either escape that was demonstrated
 * before, so each is pinned here beside the case it is meant to relax.
 */
describe("the side-effect trigger, per running pipeline", () => {
  const steps = (name: keyof typeof PIPELINES): ReturnType<typeof capabilityGrantedSteps> =>
    capabilityGrantedSteps(PIPELINES[name]!);

  const RESEARCH_PLAN: ExecutionPlan = {
    summary: "Read the docs and write up what we found.",
    risk: "low",
    projects: [{ projectId: "p1", mode: "read" }],
    steps: [
      {
        key: "look",
        kind: "investigate",
        description: "Read the module.",
        workerProfile: "researcher",
        dependsOn: [],
      },
    ],
    expectedArtifacts: [],
    verification: { commands: [] },
  };

  it("does not gate a read-only research task on the research pipeline", () => {
    // Both Worker steps are researchers on an `investigate` kind: `repo.read` +
    // `network`, no shell and no repo.write. Egress with nothing to act with.
    expect(derivePipelineSideEffectCapabilities(RESEARCH_PLAN, steps("research"))).toEqual([]);
    // The old trigger asked all the same, which is the alert fatigue this fixes.
    expect(derivePlanSideEffectCapabilities(RESEARCH_PLAN)).toContain("network");
  });

  it("still gates that very plan on the coding pipeline", () => {
    // The round-4 escape: the plan declares no acting step, and the coding
    // pipeline's fixed `implement` step acts anyway with the whole grant.
    expect(derivePipelineSideEffectCapabilities(RESEARCH_PLAN, steps("coding"))).toContain(
      "network",
    );
  });

  it("still gates an ordinary researcher + implementer plan on coding", () => {
    const twoStep = plan({
      projects: [{ projectId: "p1", mode: "write" }],
      steps: [
        {
          key: "look",
          kind: "investigate",
          description: "Read the module.",
          workerProfile: "researcher",
          dependsOn: [],
        },
        {
          key: "impl",
          kind: "implement",
          description: "Rename the helper.",
          workerProfile: "implementer",
          dependsOn: ["look"],
        },
      ],
    });
    expect(derivePipelineSideEffectCapabilities(twoStep, steps("coding"))).toContain("network");
  });

  /**
   * A narrated external effect on the research pipeline asks nobody — and the
   * reason is not "we decided to trust it": it is that no step of that pipeline
   * is HANDED the capability. `grantForStep` widens the plan's externals into a
   * step only when that step can act (`shell` or `repo.write`), and a researcher
   * on an `investigate` kind can do neither, so `external-side-effect` reaches
   * no run scope and the execution node denies the effect outright.
   *
   * The second half of this test is the load-bearing half: widen `grantForStep`
   * and it goes red, because then the gate really would be missing.
   */
  it("asks nothing for an external effect no step of the pipeline can receive", () => {
    const narrated: ExecutionPlan = {
      ...RESEARCH_PLAN,
      summary: "Read the docs, then send a message to Slack with the summary.",
    };
    expect(derivePlanCapabilities(narrated)).toContain("external-side-effect");
    expect(derivePipelineSideEffectCapabilities(narrated, steps("research"))).toEqual([]);

    for (const step of steps("research")) {
      expect(
        grantForStep(
          planWideGrant(narrated),
          {
            kind: plannedKindOfPipelineKind(step.kind),
            workerProfile: step.workerProfile ?? "implementer",
          },
          { writableProjects: false },
        ),
        `${step.key} would be handed an external effect nobody approved`,
      ).not.toContain("external-side-effect");
    }
  });

  it("gates a narrated external effect on a pipeline whose steps can act", () => {
    const narrated: ExecutionPlan = {
      ...RESEARCH_PLAN,
      summary: "Read the docs, then send a message to Slack with the summary.",
    };
    expect(derivePipelineSideEffectCapabilities(narrated, steps("coding"))).toContain(
      "external-side-effect",
    );
  });

  it("counts only the steps that are handed a grant", () => {
    // A pipeline of nothing but control/manager steps grants nothing, so it
    // cannot gate however alarming the plan is.
    expect(derivePipelineSideEffectCapabilities(plan(), [])).toEqual([]);
  });

  it("treats a worker step with no declared profile as an implementer", () => {
    const anonymous = derivePipelineSideEffectCapabilities(RESEARCH_PLAN, [{ kind: "work" }]);
    expect(anonymous).toContain("network");
  });
});
