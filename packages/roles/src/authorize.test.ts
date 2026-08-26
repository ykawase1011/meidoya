import { describe, expect, it } from "vitest";
import type { Role } from "@meidoya/domain";
import { assertAuthorized, authorize } from "./authorize.js";
import { ROLE_CAPABILITY_MATRIX, type AuthorizationContext, type Capability } from "./capabilities.js";

const base: AuthorizationContext = { actorWorkspaceId: "work-it" };

const ALL_ROLES: readonly Role[] = ["head-maid", "maid", "manager", "worker"];

describe("explicit denials", () => {
  it("denies head maid and maid dispatching a worker", () => {
    for (const role of ["head-maid", "maid"] as const) {
      const decision = authorize(role, "worker.dispatch", base);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe("capability-not-in-role");
      }
    }
  });

  it("allows only the manager to dispatch a worker", () => {
    expect(authorize("manager", "worker.dispatch", base)).toEqual({
      allowed: true,
      qualifier: "yes",
    });
    expect(authorize("worker", "worker.dispatch", base).allowed).toBe(false);
  });

  it("denies workspace scope change to every role, manager included", () => {
    for (const role of ALL_ROLES) {
      const decision = authorize(role, "workspace.scope.change", base);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe("capability-forbidden-for-everyone");
      }
    }
  });

  it("denies shell and repository access to every non-worker role", () => {
    const capabilities: Capability[] = ["shell", "repository.read", "repository.write"];
    for (const role of ["head-maid", "maid", "manager"] as const) {
      for (const capability of capabilities) {
        expect(authorize(role, capability, base).allowed).toBe(false);
      }
    }
  });

  it("denies checkpoint.request to workers", () => {
    expect(authorize("worker", "checkpoint.request", base).allowed).toBe(false);
    for (const role of ["head-maid", "maid", "manager"] as const) {
      expect(authorize(role, "checkpoint.request", base).allowed).toBe(true);
    }
  });
});

describe("scope qualifiers", () => {
  it("head maid status read requires a delegation grant", () => {
    expect(
      authorize("head-maid", "workspace.status.read", {
        ...base,
        targetWorkspaceId: "work-grammarxiv",
      }).allowed,
    ).toBe(false);
    expect(
      authorize("head-maid", "workspace.status.read", {
        ...base,
        targetWorkspaceId: "work-grammarxiv",
        delegationGranted: true,
      }),
    ).toEqual({ allowed: true, qualifier: "grant" });
  });

  it("maid and manager status read is limited to their own workspace", () => {
    for (const role of ["maid", "manager"] as const) {
      expect(
        authorize(role, "workspace.status.read", { ...base, targetWorkspaceId: "work-it" }).allowed,
      ).toBe(true);
      const other = authorize(role, "workspace.status.read", {
        ...base,
        targetWorkspaceId: "work-grammarxiv",
        delegationGranted: true,
      });
      expect(other.allowed).toBe(false);
      if (!other.allowed) {
        expect(other.reason).toBe("target-workspace-not-own");
      }
    }
  });

  it("head maid may only create coordination tasks", () => {
    expect(authorize("head-maid", "task.create", { ...base, taskScope: "own" }).allowed).toBe(
      false,
    );
    expect(
      authorize("head-maid", "task.create", { ...base, taskScope: "coordination" }),
    ).toEqual({ allowed: true, qualifier: "coordination" });
  });

  it("manager may only create child step tasks with a parent", () => {
    expect(authorize("manager", "task.create", { ...base, taskScope: "own" }).allowed).toBe(false);
    const noParent = authorize("manager", "task.create", { ...base, taskScope: "child-step" });
    expect(noParent.allowed).toBe(false);
    if (!noParent.allowed) {
      expect(noParent.reason).toBe("parent-task-required");
    }
    expect(
      authorize("manager", "task.create", {
        ...base,
        taskScope: "child-step",
        parentTaskId: "task-1",
      }),
    ).toEqual({ allowed: true, qualifier: "child-step-only" });
  });

  it("manager may only answer its own request", () => {
    expect(authorize("manager", "task.answer", { ...base, answerScope: "own" }).allowed).toBe(
      false,
    );
    expect(authorize("manager", "task.answer", { ...base, answerScope: "request" }).allowed).toBe(
      true,
    );
  });

  it("schedule.manage follows grant / own / no", () => {
    expect(
      authorize("head-maid", "schedule.manage", { ...base, delegationGranted: true }).allowed,
    ).toBe(true);
    expect(authorize("maid", "schedule.manage", base).allowed).toBe(true);
    expect(authorize("manager", "schedule.manage", base).allowed).toBe(false);
    expect(authorize("worker", "schedule.manage", base).allowed).toBe(false);
  });

  it("restricts artifact detail by role", () => {
    for (const role of ["head-maid", "maid"] as const) {
      expect(authorize(role, "artifact.read", { ...base, artifactDetail: "summary" }).allowed).toBe(
        true,
      );
      expect(authorize(role, "artifact.read", { ...base, artifactDetail: "full" }).allowed).toBe(
        false,
      );
    }
    expect(authorize("manager", "artifact.read", { ...base, artifactDetail: "full" }).allowed).toBe(
      true,
    );
  });
});

describe("worker scoped access", () => {
  const workerContext: AuthorizationContext = {
    actorWorkspaceId: "work-it",
    stepScope: { stepId: "step-1", workspaceId: "work-it", projectId: "product-a" },
    allowedProjects: ["product-a"],
    repositoryAccess: "read",
    shellAllowed: false,
  };

  it("allows repo read inside the step scope", () => {
    expect(authorize("worker", "repository.read", workerContext)).toEqual({
      allowed: true,
      qualifier: "scoped",
    });
  });

  it("denies repo write without write permission", () => {
    const decision = authorize("worker", "repository.write", workerContext);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("repository-permission-missing");
    }
    expect(
      authorize("worker", "repository.write", { ...workerContext, repositoryAccess: "write" })
        .allowed,
    ).toBe(true);
  });

  it("denies shell unless explicitly enabled", () => {
    expect(authorize("worker", "shell", workerContext).allowed).toBe(false);
    expect(authorize("worker", "shell", { ...workerContext, shellAllowed: true }).allowed).toBe(
      true,
    );
  });

  it("denies projects outside the allowed set and steps in another workspace", () => {
    const otherProject = authorize("worker", "repository.read", {
      ...workerContext,
      allowedProjects: ["product-b"],
    });
    expect(otherProject.allowed).toBe(false);
    if (!otherProject.allowed) {
      expect(otherProject.reason).toBe("project-not-allowed");
    }

    const otherWorkspace = authorize("worker", "repository.read", {
      ...workerContext,
      stepScope: { stepId: "step-1", workspaceId: "work-grammarxiv", projectId: "product-a" },
    });
    expect(otherWorkspace.allowed).toBe(false);
    if (!otherWorkspace.allowed) {
      expect(otherWorkspace.reason).toBe("step-workspace-mismatch");
    }
  });

  it("requires a step scope for worker artifact reads", () => {
    expect(authorize("worker", "artifact.read", base).allowed).toBe(false);
    expect(authorize("worker", "artifact.read", workerContext).allowed).toBe(true);
  });
});

describe("matrix coverage", () => {
  it("has an entry for every role on every capability", () => {
    for (const capability of Object.keys(ROLE_CAPABILITY_MATRIX) as Capability[]) {
      for (const role of ALL_ROLES) {
        expect(ROLE_CAPABILITY_MATRIX[capability][role]).toBeTypeOf("string");
      }
    }
  });

  it("assertAuthorized throws on denial", () => {
    expect(() => {
      assertAuthorized("maid", "worker.dispatch", base);
    }).toThrow(/worker\.dispatch/);
    expect(() => {
      assertAuthorized("manager", "worker.dispatch", base);
    }).not.toThrow();
  });
});
