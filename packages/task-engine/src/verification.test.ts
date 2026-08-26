import { describe, expect, it } from "vitest";

import { FakeArtifactProbe, FakeCommandRunner } from "./fakes.js";
import { runVerification, toCommandGroups } from "./verification.js";

const plan = {
  commands: [
    { name: "test:unit", command: "npm test -- unit" },
    { name: "test:integration", command: "npm test -- integration" },
    { name: "lint", command: "npm run lint" },
    { name: "typecheck", command: "npm run typecheck" },
  ],
};

describe("verification", () => {
  it("groups commands deterministically", () => {
    expect(toCommandGroups(plan).map((g) => g.name)).toEqual(["test", "lint", "typecheck"]);
    expect(toCommandGroups(plan)[0]?.commands).toHaveLength(2);
  });

  it("passes when every command exits 0 and artifacts exist", async () => {
    const result = await runVerification(
      plan,
      { commands: new FakeCommandRunner(), artifacts: new FakeArtifactProbe(new Set(["out.txt"])) },
      { expectedArtifacts: ["out.txt"] },
    );
    expect(result.status).toBe("passed");
    expect(result.failureSignature).toBeUndefined();
    expect(result.groups.map((g) => g.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("fails from command evidence, not judgement, and yields a stable signature", async () => {
    const runner = new FakeCommandRunner({
      "test:integration": { exitCode: 1, failureSignature: "AssertionError@foo.spec.ts:12" },
    });
    const result = await runVerification(plan, {
      commands: runner,
      artifacts: new FakeArtifactProbe(),
    });
    expect(result.status).toBe("failed");
    expect(result.groups.find((g) => g.name === "test")?.status).toBe("failed");
    expect(result.groups.find((g) => g.name === "lint")?.status).toBe("passed");
    expect(result.failureSignature).toBe("test:integration#AssertionError@foo.spec.ts:12");

    const again = await runVerification(plan, {
      commands: new FakeCommandRunner({
        "test:integration": { exitCode: 1, failureSignature: "AssertionError@foo.spec.ts:12" },
      }),
      artifacts: new FakeArtifactProbe(),
    });
    expect(again.failureSignature).toBe(result.failureSignature);
  });

  it("fails when a promised artifact is missing", async () => {
    const result = await runVerification(
      plan,
      { commands: new FakeCommandRunner(), artifacts: new FakeArtifactProbe() },
      { expectedArtifacts: ["report.md"] },
    );
    expect(result.status).toBe("failed");
    expect(result.missingArtifacts).toEqual(["report.md"]);
    expect(result.failureSignature).toContain("missing-artifacts#report.md");
  });

  it("collects evidence and artifacts from executions", async () => {
    const runner = new FakeCommandRunner({
      lint: {
        evidence: { kind: "command-output", artifactId: "a1" },
        artifacts: [{ artifactId: "a1", kind: "log", path: "lint.log", sha256: "x" }],
      },
    });
    const result = await runVerification(plan, {
      commands: runner,
      artifacts: new FakeArtifactProbe(),
    });
    expect(result.evidence).toEqual([{ kind: "command-output", artifactId: "a1" }]);
    expect(result.artifacts).toHaveLength(1);
    expect(runner.calls).toHaveLength(4);
  });

  /**
   * 05 section 7: a verdict is evidence, and an empty command list is none.
   * `passed` for zero commands made "run nothing" the cheapest way to satisfy
   * the quality gate — every caller that substituted an empty plan for a
   * missing one completed tasks on a gate that never ran.
   */
  it("fails a plan with no commands rather than passing it vacuously", async () => {
    const runner = new FakeCommandRunner();
    const result = await runVerification(
      { commands: [] },
      { commands: runner, artifacts: new FakeArtifactProbe() },
    );
    expect(result.status).toBe("failed");
    expect(result.failureSignature).toContain("verification#no-commands");
    expect(runner.calls).toHaveLength(0);
  });
});
