import { describe, expect, it } from "vitest";

import { isVacuousVerification, verificationProjectId } from "./verification-scope.js";

describe("verificationProjectId", () => {
  it("names the plan's writable project", () => {
    expect(
      verificationProjectId([
        { projectId: "docs", mode: "read" },
        { projectId: "app", mode: "write" },
      ]),
    ).toBe("app");
  });

  it("names a single read-only project when the plan writes nothing", () => {
    expect(verificationProjectId([{ projectId: "docs", mode: "read" }])).toBe("docs");
  });

  /**
   * The node refuses to guess between two bound projects, and so does this: a
   * wrong project runs the wrong repository's `npm test` inside the sandbox and
   * reports it as the task's evidence.
   */
  it("names nothing when the plan is ambiguous", () => {
    expect(
      verificationProjectId([
        { projectId: "a", mode: "write" },
        { projectId: "b", mode: "write" },
      ]),
    ).toBeUndefined();
    expect(
      verificationProjectId([
        { projectId: "a", mode: "read" },
        { projectId: "b", mode: "read" },
      ]),
    ).toBeUndefined();
    expect(verificationProjectId([])).toBeUndefined();
  });
});

describe("isVacuousVerification", () => {
  /**
   * `runVerification` answers `passed` for an empty command list, so a workflow
   * that substitutes `{ commands: [] }` for a missing plan completes tasks on a
   * quality gate that ran nothing.
   */
  it("is true for a missing plan and for an empty one", () => {
    expect(isVacuousVerification(undefined)).toBe(true);
    expect(isVacuousVerification({ commands: [] })).toBe(true);
  });

  it("is false as soon as there is a command to run", () => {
    expect(isVacuousVerification({ commands: [{ name: "test" }] })).toBe(false);
  });
});
