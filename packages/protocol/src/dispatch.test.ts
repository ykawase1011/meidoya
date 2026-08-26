import { describe, expect, it } from "vitest";
import { NODE_PROTOCOL_VERSION } from "@meidoya/node-protocol";
import {
  CONTROL_PROTOCOL_VERSION,
  FrameDecoder,
  FrameTooLargeError,
  dispatchRequest,
  encodeFrame,
  type ControlRequest,
  type ResolvedScope,
} from "./index.js";

const scope: ResolvedScope = {
  workspaceId: "work-it",
  role: "maid",
  capabilities: ["task.create", "workspace.status.read"],
};

const options = {
  resolveScope: async (token: string) =>
    token === "valid" ? scope : undefined,
  handlers: {
    "task.create": async (s: ResolvedScope, params: { title: string }) => ({
      task: {
        taskId: "task-1",
        title: params.title,
        status: "received" as const,
        pipeline: "coding" as const,
        createdAt: 1,
        updatedAt: 1,
      },
      temporalWorkflowId: `wf/${s.workspaceId}/task-1`,
    }),
    "node.register": async () => ({
      accepted: true,
      grantedCapabilities: [],
      grantedWorkspaces: [],
      maxConcurrency: 1,
      heartbeatIntervalMs: 15_000,
      rejections: [],
    }),
  },
} as unknown as Parameters<typeof dispatchRequest>[1];

function req(partial: Partial<ControlRequest>): ControlRequest {
  return {
    v: CONTROL_PROTOCOL_VERSION,
    id: "1",
    method: "task.create",
    params: {},
    ...partial,
  };
}

describe("dispatchRequest", () => {
  it("resolves workspace from the scope token", async () => {
    const res = await dispatchRequest(
      req({
        scopeToken: "valid",
        params: {
          title: "do it",
          intent: { summary: "s", projects: [], origin: "cli" },
        },
      }),
      options,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toMatchObject({ temporalWorkflowId: "wf/work-it/task-1" });
    }
  });

  it("rejects a payload carrying workspaceId", async () => {
    const res = await dispatchRequest(
      req({
        scopeToken: "valid",
        params: {
          title: "do it",
          intent: { summary: "s", projects: [], origin: "cli" },
          workspaceId: "other-workspace",
        },
      }),
      options,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("workspace_id_in_params");
  });

  it("rejects a scoped method without a scope token", async () => {
    const res = await dispatchRequest(
      req({ params: { title: "x", intent: { summary: "s", projects: [], origin: "cli" } } }),
      options,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("unauthorized_scope");
  });

  it("rejects an unknown scope token", async () => {
    const res = await dispatchRequest(
      req({ scopeToken: "forged", params: { title: "x", intent: { summary: "s", projects: [], origin: "cli" } } }),
      options,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("unauthorized_scope");
  });

  it("enforces the declared capability", async () => {
    const res = await dispatchRequest(
      req({
        scopeToken: "valid",
        params: { title: "x", intent: { summary: "s", projects: [], origin: "cli" } },
      }),
      { ...options, authorize: () => false },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("capability_denied");
  });

  it("reports unknown methods and invalid params", async () => {
    const unknown = await dispatchRequest(
      req({ method: "task.nuke", scopeToken: "valid" }),
      options,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.kind).toBe("method_not_found");

    const bad = await dispatchRequest(
      req({ scopeToken: "valid", params: { title: "" } }),
      options,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.kind).toBe("invalid_params");
  });

  /**
   * A node holds no ingress binding, so there is no workspace whose scope token
   * it could present: `scoped: false` says the dispatcher must not demand one.
   * It does NOT say the call is unauthenticated — the node's own registration
   * token rides in the params and the handler verifies it before it writes
   * anything (see apps/meidoyad/src/api.ts). What is asserted here is only the
   * dispatcher's half: no scope token demanded, and the credential carried
   * through to the handler intact rather than stripped by the params schema.
   */
  const registration = {
    nodeId: "mac-main",
    nodeVersion: "0.1.0",
    protocolVersion: NODE_PROTOCOL_VERSION,
    platform: "darwin",
    arch: "arm64",
    profile: "mac-restricted",
    capabilities: ["repo.read"],
    workspaceBindings: ["work-it"],
    maxConcurrency: 4,
  };

  it("dispatches unscoped node methods without a scope token", async () => {
    const res = await dispatchRequest(
      req({ method: "node.register", params: registration }),
      options,
    );
    expect(res.ok).toBe(true);
  });

  it("hands the node's credential to the handler instead of stripping it", async () => {
    let seen: unknown;
    const res = await dispatchRequest(
      req({
        method: "node.register",
        params: { ...registration, credential: "node-token" },
      }),
      {
        ...options,
        handlers: {
          "node.register": async (params: { credential?: string }) => {
            seen = params.credential;
            return {
              accepted: true,
              grantedCapabilities: [],
              grantedWorkspaces: [],
              maxConcurrency: 1,
              heartbeatIntervalMs: 15_000,
              rejections: [],
            };
          },
        },
      } as unknown as Parameters<typeof dispatchRequest>[1],
    );
    expect(res.ok).toBe(true);
    expect(seen).toBe("node-token");
  });
});

describe("frame codec", () => {
  it("round-trips newline-delimited frames", () => {
    const decoder = new FrameDecoder();
    const a = encodeFrame(req({ id: "a", scopeToken: "valid" }));
    const b = encodeFrame(req({ id: "b", scopeToken: "valid" }));
    expect(decoder.push(a.slice(0, 5))).toEqual([]);
    const frames = decoder.push(a.slice(5) + b);
    expect(frames).toHaveLength(2);
    expect((frames[0] as ControlRequest).id).toBe("a");
    expect((frames[1] as ControlRequest).id).toBe("b");
  });

  it("fails closed on oversized frames", () => {
    const decoder = new FrameDecoder(64);
    expect(() => decoder.push(`${"x".repeat(200)}\n`)).toThrow(FrameTooLargeError);
  });
});
