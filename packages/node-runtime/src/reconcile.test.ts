import { describe, expect, it } from "vitest";
import { NODE_PROTOCOL_VERSION, type NodeRegistration } from "@meidoya/node-protocol";
import { buildRegistration, NodeAgent } from "./registration.js";
import {
  canNodeRunWorkspace,
  reconcileRegistration,
  type LocalNodePolicy,
} from "./reconcile.js";
import type { ControlPlanePort } from "./ports.js";

const policy: LocalNodePolicy = {
  nodeId: "mac-main",
  allowedProfiles: ["mac-restricted"],
  allowedCapabilities: ["repo.read", "repo.write", "test"],
  allowedWorkspaces: ["work-it"],
  maxConcurrencyCeiling: 4,
  expectedPlatform: "darwin",
  expectedArch: "arm64",
};

function registration(overrides: Partial<NodeRegistration> = {}): NodeRegistration {
  return {
    nodeId: "mac-main",
    nodeVersion: "0.1.0",
    protocolVersion: NODE_PROTOCOL_VERSION,
    platform: "darwin",
    arch: "arm64",
    profile: "mac-restricted",
    capabilities: ["repo.read", "repo.write"],
    workspaceBindings: ["work-it"],
    maxConcurrency: 4,
    ...overrides,
  };
}

describe("the node self-report is a claim, not a grant", () => {
  it("accepts a registration that matches local policy", () => {
    const result = reconcileRegistration(registration(), [policy]);
    expect(result.accepted).toBe(true);
    expect(result.node?.capabilities).toEqual(["repo.read", "repo.write"]);
    expect(result.node?.allowedWorkspaces).toEqual(["work-it"]);
  });

  it("strips capabilities the node claims beyond local policy", () => {
    const result = reconcileRegistration(
      registration({
        capabilities: ["repo.read", "shell", "network", "external-side-effect"],
      }),
      [policy],
    );
    expect(result.accepted).toBe(true);
    expect(result.grantedCapabilities).toEqual(["repo.read"]);
    expect(result.strippedCapabilities).toEqual([
      "external-side-effect",
      "network",
      "shell",
    ]);
    expect(result.node?.capabilities).not.toContain("shell");
    expect(result.rejections.join(" ")).toContain("shell");
  });

  it("strips workspaces the node claims beyond its bindings", () => {
    const result = reconcileRegistration(
      registration({ workspaceBindings: ["work-it", "work-grammarxiv", "*"] }),
      [policy],
    );
    expect(result.grantedWorkspaces).toEqual(["work-it"]);
    expect(result.strippedWorkspaces).toEqual(["*", "work-grammarxiv"]);
    expect(
      canNodeRunWorkspace(result.node!, "work-grammarxiv"),
    ).toBe(false);
    expect(canNodeRunWorkspace(result.node!, "work-it")).toBe(true);
  });

  it("caps maxConcurrency at the policy ceiling", () => {
    const result = reconcileRegistration(
      registration({ maxConcurrency: 64 }),
      [policy],
    );
    expect(result.maxConcurrency).toBe(4);
    expect(result.node?.maxConcurrency).toBe(4);
  });

  it("rejects an unknown node id", () => {
    const result = reconcileRegistration(
      registration({ nodeId: "rogue-node" }),
      [policy],
    );
    expect(result.accepted).toBe(false);
    expect(result.node).toBeUndefined();
    expect(result.rejections.join(" ")).toContain("unknown node");
  });

  it("rejects a claimed profile upgrade", () => {
    const result = reconcileRegistration(
      registration({ profile: "lima-trusted" }),
      [policy],
    );
    expect(result.accepted).toBe(false);
    expect(result.rejections.join(" ")).toContain("lima-trusted");
  });

  it("rejects platform / arch spoofing and protocol mismatch", () => {
    expect(
      reconcileRegistration(registration({ platform: "linux" }), [policy]).accepted,
    ).toBe(false);
    expect(
      reconcileRegistration(registration({ arch: "x64" }), [policy]).accepted,
    ).toBe(false);
    expect(
      reconcileRegistration(registration({ protocolVersion: 99 }), [policy])
        .accepted,
    ).toBe(false);
  });
});

describe("NodeAgent", () => {
  it("advertises the protocol version, profile and sorted claims", () => {
    const reg = buildRegistration({
      nodeId: "mac-main",
      nodeVersion: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      profile: "mac-restricted",
      capabilities: ["repo.write", "repo.read", "repo.read"],
      workspaceBindings: ["work-it"],
      maxConcurrency: 4,
    });
    expect(reg.protocolVersion).toBe(NODE_PROTOCOL_VERSION);
    expect(reg.capabilities).toEqual(["repo.read", "repo.write"]);
  });

  it("adopts the Control Plane's grant rather than its own claim", async () => {
    const acknowledgements: number[] = [];
    const controlPlane: ControlPlanePort = {
      registerNode: async () => ({
        accepted: true,
        grantedCapabilities: ["repo.read"],
        grantedWorkspaces: ["work-it"],
        maxConcurrency: 2,
        heartbeatIntervalMs: 1_000,
        rejections: ["capability \"shell\" is not granted by local policy"],
      }),
      heartbeatNode: async () => ({
        acknowledged: true,
        directive: "continue" as const,
      }),
    };
    const agent = new NodeAgent({
      self: {
        nodeId: "mac-main",
        nodeVersion: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        profile: "mac-restricted",
        capabilities: ["repo.read", "shell"],
        workspaceBindings: ["work-it", "work-grammarxiv"],
        maxConcurrency: 8,
      },
      controlPlane,
      activeRunCount: () => 0,
      clock: { now: () => 1_000 },
      onControlPlaneAcknowledged: (at) => acknowledgements.push(at),
    });

    expect(await agent.register()).toBe(true);
    expect(agent.grantedCapabilities).toEqual(["repo.read"]);
    expect(agent.grantedWorkspaces).toEqual(["work-it"]);
    expect(agent.effectiveMaxConcurrency).toBe(2);
    expect(acknowledgements).toEqual([1_000]);
    expect(agent.buildHeartbeat()).toEqual({
      nodeId: "mac-main",
      status: "online",
      activeRunCount: 0,
      timestamp: 1_000,
    });
  });

  it("goes offline when registration is refused", async () => {
    const agent = new NodeAgent({
      self: {
        nodeId: "rogue",
        nodeVersion: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        profile: "mac-restricted",
        capabilities: [],
        workspaceBindings: [],
        maxConcurrency: 1,
      },
      controlPlane: {
        registerNode: async () => ({
          accepted: false,
          grantedCapabilities: [],
          grantedWorkspaces: [],
          maxConcurrency: 0,
          heartbeatIntervalMs: 15_000,
          rejections: ["unknown node"],
        }),
        heartbeatNode: async () => ({
          acknowledged: true,
          directive: "continue" as const,
        }),
      },
      activeRunCount: () => 0,
    });
    expect(await agent.register()).toBe(false);
    expect(agent.nodeStatus).toBe("offline");
    expect(agent.effectiveMaxConcurrency).toBe(0);
  });

  it("drains and re-registers on Control Plane directives", async () => {
    let registrations = 0;
    let directive: "continue" | "drain" | "re-register" = "drain";
    const agent = new NodeAgent({
      self: {
        nodeId: "mac-main",
        nodeVersion: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        profile: "mac-restricted",
        capabilities: [],
        workspaceBindings: [],
        maxConcurrency: 1,
      },
      controlPlane: {
        registerNode: async () => {
          registrations += 1;
          return {
            accepted: true,
            grantedCapabilities: [],
            grantedWorkspaces: [],
            maxConcurrency: 1,
            heartbeatIntervalMs: 1_000,
            rejections: [],
          };
        },
        heartbeatNode: async () => ({ acknowledged: true, directive }),
      },
      activeRunCount: () => 0,
    });
    await agent.register();
    await agent.heartbeatOnce();
    expect(agent.nodeStatus).toBe("draining");

    directive = "re-register";
    await agent.heartbeatOnce();
    expect(registrations).toBe(2);
  });
});
