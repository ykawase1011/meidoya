import { describe, expect, it } from "vitest";
import { asScopeToken, type ControlPlaneApi } from "./index.js";
import { CONTROL_METHODS } from "./methods.js";
import { assertNoWorkspaceSelector, WorkspaceIdInParamsError } from "./scope.js";

const scope = asScopeToken("scope-token-abc");

/** Type-level test: verified by `tsc --noEmit`, not by the runtime assertions. */
describe("workspace-scoped params cannot carry a workspaceId", () => {
  it("rejects workspaceId at the type level", () => {
    const api = {} as ControlPlaneApi;
    const ok = () =>
      api.createTask(scope, {
        title: "t",
        intent: { summary: "s", projects: [], origin: "cli" },
      });
    const escalate = () =>
      api.createTask(scope, {
        title: "t",
        intent: { summary: "s", projects: [], origin: "cli" },
        // @ts-expect-error workspace scope must come from the scope token
        workspaceId: "other-workspace",
      });
    expect(typeof ok).toBe("function");
    expect(typeof escalate).toBe("function");
  });

  it("rejects workspace aliases at the type level", () => {
    const api = {} as ControlPlaneApi;
    const fn = () =>
      // @ts-expect-error `workspace` is also not a parameter
      api.listTasks(scope, { limit: 10, workspace: "other" });
    expect(typeof fn).toBe("function");
  });
});

describe("runtime rejection of smuggled workspace selectors", () => {
  it.each(["workspaceId", "workspace", "workspace_id", "scopeToken"])(
    "throws for %s",
    (key) => {
      expect(() => assertNoWorkspaceSelector({ [key]: "x" })).toThrow(
        WorkspaceIdInParamsError,
      );
    },
  );

  it("allows params without a workspace selector", () => {
    expect(() => assertNoWorkspaceSelector({ taskId: "t1" })).not.toThrow();
  });

  it("makes every scoped method schema reject workspaceId", () => {
    for (const [name, spec] of Object.entries(CONTROL_METHODS)) {
      if (!spec.scoped) continue;
      const result = spec.params.safeParse({ workspaceId: "other" });
      expect(result.success, `${name} accepted workspaceId`).toBe(false);
    }
  });

  it("strips unknown params via strict object schemas", () => {
    const result = CONTROL_METHODS["task.cancel"].params.safeParse({
      taskId: "t1",
      surprise: true,
    });
    expect(result.success).toBe(false);
  });
});
