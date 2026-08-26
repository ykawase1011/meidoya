import { describe, expect, it } from "vitest";
import { ScopeViolationError, sealRunScope } from "@meidoya/node-runtime";
import type { RunRequest } from "@meidoya/node-protocol";
import { derivePermissions } from "@meidoya/model-router";
import { buildCodexArgs, sandboxModeFor } from "@meidoya/runtime-codex";
import { buildClaudeArgs } from "@meidoya/runtime-claude";
import type { WorkerCapability } from "@meidoya/domain";

import { buildWorkerRunScope, intersectCapabilities } from "./run-scope.js";

const local = {
  capabilities: ["repo.read", "repo.write", "shell", "network"],
  projectIds: ["p1"],
  networkPolicy: "restricted",
};

describe("control-plane and node grants intersect", () => {
  it("a control plane granting more than local policy does not escalate", () => {
    const scope = buildWorkerRunScope(
      {
        workspaceId: "work-it",
        // The control plane asks for an effect this node's operator never
        // enabled. 10 section 6: local policy is a hard ceiling.
        capabilities: ["repo.read", "repo.write", "shell", "external-side-effect"],
        projectAccess: [
          { projectId: "p1", mode: "write" },
          { projectId: "not-bound", mode: "write" },
        ],
      },
      local,
    );

    expect(scope.capabilities).not.toContain("external-side-effect");
    expect(scope.sideEffectPolicy).toBe("deny");
    expect(scope.projectAccess.map((p) => p.projectId)).toEqual(["p1"]);
  });

  it("a node claiming more than the control plane granted does not escalate", () => {
    const scope = buildWorkerRunScope(
      {
        workspaceId: "work-it",
        capabilities: ["repo.read"],
        projectAccess: [{ projectId: "p1", mode: "write" }],
      },
      {
        // A compromised or over-eager node config claiming everything.
        capabilities: [
          "repo.read",
          "repo.write",
          "shell",
          "network",
          "external-side-effect",
        ],
        projectIds: ["p1", "p2"],
        networkPolicy: "open",
      },
    );

    expect(scope.capabilities).toEqual(["repo.read"]);
    expect(scope.sideEffectPolicy).toBe("deny");
    // Write mode is not in the grant, so the binding degrades to read.
    expect(scope.projectAccess).toEqual([{ projectId: "p1", mode: "read" }]);
    // No `network` in the grant means no egress, whatever the node config says.
    expect(scope.networkPolicy).toBe("none");
  });

  it("grants only what BOTH sides allow", () => {
    expect(intersectCapabilities(["a", "b", "c"], ["b", "c", "d"])).toEqual(["b", "c"]);
    expect(intersectCapabilities([], ["a"])).toEqual([]);
    expect(intersectCapabilities(["a"], [])).toEqual([]);
  });

  it("refuses a run that carries no control-plane grant", () => {
    // Fail CLOSED: an empty grant used to mean "use whatever the node holds".
    expect(() =>
      buildWorkerRunScope(
        { workspaceId: "work-it", capabilities: [], projectAccess: [] },
        { ...local, capabilities: ["repo.read", "repo.write", "shell"] },
      ),
    ).toThrow(ScopeViolationError);
  });

  it("opens the side-effect policy only when both sides granted it", () => {
    const scope = buildWorkerRunScope(
      {
        workspaceId: "work-it",
        capabilities: ["repo.read", "repo.write", "shell", "network", "external-side-effect"],
        projectAccess: [{ projectId: "p1", mode: "write" }],
      },
      { ...local, capabilities: [...local.capabilities, "external-side-effect"] },
    );

    expect(scope.sideEffectPolicy).toBe("allow");
    expect(scope.networkPolicy).toBe("restricted");
    expect(scope.projectAccess).toEqual([{ projectId: "p1", mode: "write" }]);
  });
});

function request(scope: RunRequest["scope"]): RunRequest {
  return {
    runId: "r1",
    taskId: "t1",
    role: "worker",
    workerProfile: "implementer",
    provider: "codex",
    modelProfile: "standard",
    resolvedModel: "m",
    scope,
    prompt: "p",
  };
}

/** What the vendor CLI is actually told, given a run scope. */
function vendorCapabilities(scope: RunRequest["scope"]): readonly WorkerCapability[] {
  return derivePermissions(
    { role: "worker", profile: "implementer" },
    {
      requested: scope.capabilities.filter((c): c is WorkerCapability =>
        (
          [
            "repo.read",
            "repo.write",
            "shell",
            "network",
            "browser",
            "package-install",
            "external-side-effect",
          ] as string[]
        ).includes(c),
      ),
    },
  ).capabilities;
}

describe("approving the gate changes what the worker may do", () => {
  const denied = buildWorkerRunScope(
    {
      workspaceId: "work-it",
      capabilities: ["repo.read", "repo.write", "shell", "network"],
      projectAccess: [{ projectId: "p1", mode: "write" }],
    },
    local,
  );
  const approved = buildWorkerRunScope(
    {
      workspaceId: "work-it",
      capabilities: ["repo.read", "repo.write", "shell", "network", "external-side-effect"],
      projectAccess: [{ projectId: "p1", mode: "write" }],
    },
    { ...local, capabilities: [...local.capabilities, "external-side-effect"] },
  );

  it("reaches the Codex sandbox flag", () => {
    expect(sandboxModeFor(vendorCapabilities(denied))).toBe("workspace-write");
    expect(sandboxModeFor(vendorCapabilities(approved))).toBe("danger-full-access");

    const args = buildCodexArgs({
      resolvedModel: "m",
      capabilities: vendorCapabilities(denied),
    });
    expect(args).toContain("workspace-write");
    expect(args).not.toContain("danger-full-access");
  });

  it("reaches the Claude tool allowlist", () => {
    const deniedArgs = buildClaudeArgs({
      resolvedModel: "m",
      capabilities: vendorCapabilities(denied),
    });
    const approvedArgs = buildClaudeArgs({
      resolvedModel: "m",
      capabilities: vendorCapabilities(approved),
    });

    const allowed = (args: string[]): string =>
      args[args.indexOf("--allowedTools") + 1] ?? "";
    const disallowed = (args: string[]): string =>
      args[args.indexOf("--disallowedTools") + 1] ?? "";

    expect(allowed(deniedArgs)).not.toContain("WebFetch");
    expect(disallowed(deniedArgs)).toContain("WebFetch");
    expect(allowed(approvedArgs)).toContain("WebFetch");
    expect(disallowed(approvedArgs)).not.toContain("WebFetch");
  });

  it("a worker without external-side-effect cannot get it back by asking", () => {
    // The prompt-injected half: the request claims the capability, the sealed
    // scope is the authoritative one.
    const claimed = {
      ...denied,
      capabilities: [...denied.capabilities, "external-side-effect"],
      sideEffectPolicy: "allow",
    };
    const sealed = sealRunScope(request(claimed), denied);

    expect(sealed.request.scope.capabilities).not.toContain("external-side-effect");
    expect(sealed.request.scope.sideEffectPolicy).toBe("deny");
    expect(sealed.ignoredEscalations.map((e) => e.field)).toContain("capabilities");
    expect(vendorCapabilities(sealed.request.scope)).not.toContain("external-side-effect");
  });
});
