import { describe, expect, it } from "vitest";
import type { ActorSpec, WorkerCapability } from "@meidoya/domain";
import { derivePermissions, maxCapabilitiesFor } from "./permissions.js";

const ALL_CAPABILITIES: readonly WorkerCapability[] = [
  "repo.read",
  "repo.write",
  "shell",
  "network",
  "browser",
  "package-install",
  "external-side-effect",
];

describe("coordinating roles (09 section 9)", () => {
  const coordinating: ActorSpec[] = [{ role: "head-maid" }, { role: "maid" }, { role: "manager" }];

  it("never grants shell, filesystem write or repository access", () => {
    for (const actor of coordinating) {
      const derived = derivePermissions(actor, { requested: ALL_CAPABILITIES });
      expect(derived.capabilities).toEqual([]);
      expect(derived.shell).toBe(false);
      expect(derived.filesystemWrite).toBe(false);
      expect(derived.repositoryAccess).toBe("none");
      expect(derived.denied).toEqual(ALL_CAPABILITIES);
    }
  });

  it("a manager can never obtain shell however it asks", () => {
    const attempts: StepRequest[] = [
      { requested: ["shell"] },
      { requested: ["shell", "repo.read"] },
      { requested: ["repo.write", "shell", "package-install"] },
      { requested: [] },
    ];
    for (const attempt of attempts) {
      const derived = derivePermissions({ role: "manager" }, attempt);
      expect(derived.capabilities.includes("shell")).toBe(false);
      expect(derived.shell).toBe(false);
    }
    expect(maxCapabilitiesFor({ role: "manager" })).toEqual([]);
  });

  it("still exposes scoped Control Plane tools only", () => {
    const derived = derivePermissions({ role: "manager" });
    expect(derived.controlPlaneTools.length).toBeGreaterThan(0);
    for (const tool of derived.controlPlaneTools) {
      expect(tool).not.toContain("shell:unscoped");
    }
  });
});

type StepRequest = { readonly requested: readonly WorkerCapability[] };

describe("worker capabilities", () => {
  it("intersects the WorkerProfile maximum with the step request", () => {
    const derived = derivePermissions(
      { role: "worker", profile: "tester" },
      { stepKey: "s1", requested: ["repo.read", "repo.write", "shell"] },
    );
    expect(derived.capabilities).toEqual(["repo.read", "shell"]);
    expect(derived.denied).toEqual(["repo.write"]);
    expect(derived.repositoryAccess).toBe("read");
    expect(derived.shell).toBe(true);
  });

  /**
   * This assertion used to read the other way round: it expected an
   * implementer's `external-side-effect` request to be DENIED, which is
   * precisely the bug — a human approving the side-effect gate handed the
   * capability to a filter that threw it away. The gate decides whether the
   * capability is in the run scope; this function only enforces the profile
   * maximum, and `external-side-effect` is inside the implementer's.
   */
  it("passes an approved external-side-effect grant through to the worker", () => {
    const derived = derivePermissions(
      { role: "worker", profile: "implementer" },
      { stepKey: "s1", requested: ["repo.read", "repo.write", "shell", "external-side-effect"] },
    );
    expect(derived.capabilities).toContain("external-side-effect");
    expect(derived.externalSideEffect).toBe(true);
    expect(derived.denied).toEqual([]);
  });

  it("contains external reach when no side effect was approved", () => {
    const contained = derivePermissions(
      { role: "worker", profile: "implementer" },
      { requested: ["repo.read", "repo.write", "shell", "network", "package-install"] },
    );
    expect(contained.capabilities).toEqual(["repo.read", "repo.write", "shell"]);
    expect(contained.network).toBe(false);
    expect(contained.denied).toEqual(["network", "package-install"]);

    const approved = derivePermissions(
      { role: "worker", profile: "implementer" },
      {
        requested: [
          "repo.read",
          "repo.write",
          "shell",
          "network",
          "package-install",
          "external-side-effect",
        ],
      },
    );
    expect(approved.network).toBe(true);
    expect(approved.capabilities).toContain("package-install");
  });

  it("leaves a read-only researcher its network", () => {
    const derived = derivePermissions(
      { role: "worker", profile: "researcher" },
      { requested: ["repo.read", "network"] },
    );
    // Fetching a document is not the side effect 06 section 1.4 gates.
    expect(derived.capabilities).toEqual(["repo.read", "network"]);
    expect(derived.network).toBe(true);
    expect(derived.externalSideEffect).toBe(false);
  });

  it("keeps read-only profiles read-only", () => {
    for (const profile of ["reviewer", "security-reviewer"] as const) {
      const derived = derivePermissions(
        { role: "worker", profile },
        { requested: ALL_CAPABILITIES },
      );
      expect(derived.capabilities).toEqual(["repo.read"]);
      expect(derived.shell).toBe(false);
      expect(derived.filesystemWrite).toBe(false);
      expect(derived.repositoryAccess).toBe("read");
    }
  });

  it("grants nothing the step did not request", () => {
    const derived = derivePermissions({ role: "worker", profile: "implementer" }, { requested: [] });
    expect(derived.capabilities).toEqual([]);
    expect(derived.repositoryAccess).toBe("none");
  });

  it("never grants a capability outside the profile maximum", () => {
    const derived = derivePermissions(
      { role: "worker", profile: "mechanical-editor" },
      { requested: ALL_CAPABILITIES },
    );
    expect(derived.capabilities).toEqual(["repo.read", "repo.write"]);
    expect(derived.shell).toBe(false);
  });
});
