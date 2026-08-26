import { describe, expect, it } from "vitest";
import { parseModelMapping, resolveModel, runtimeKey } from "./model-mapping.js";
import { parseModelPolicy } from "./policy.js";
import { roleDefaultRuntime } from "./role-defaults.js";
import { validateManagerProposal, type RoutingContext } from "./routing.js";

// Mirrors docs/design/config.example.yaml; concrete names live in config only.
const mapping = parseModelMapping({
  codex: { high: "sol", standard: "terra", economy: "luna" },
  claude: { high: "opus", standard: "sonnet", economy: "haiku" },
});

const policy = parseModelPolicy({
  roles: {
    "head-maid": { provider: "codex", profile: "high" },
    maid: { provider: "codex", profile: "high" },
    manager: { provider: "codex", profile: "high" },
  },
  worker_profiles: {
    researcher: { allowed: ["codex-high", "codex-standard", "claude-high", "claude-standard"] },
    implementer: {
      default: "claude-standard",
      allowed: ["codex-high", "codex-standard", "claude-high", "claude-standard"],
    },
    "mechanical-editor": {
      default: "codex-economy",
      allowed: ["codex-standard", "codex-economy", "claude-standard", "claude-economy"],
    },
    reviewer: { default: "codex-high", allowed: ["codex-high", "claude-high"] },
  },
});

const ctx: RoutingContext = { mapping, policy };

describe("logical profile mapping (09 section 4)", () => {
  it("resolves concrete models only through the config mapping", () => {
    expect(resolveModel(mapping, { provider: "codex", modelProfile: "high" })).toBe("sol");
    expect(resolveModel(mapping, { provider: "claude", modelProfile: "economy" })).toBe("haiku");
  });

  it("round-trips runtime keys", () => {
    expect(runtimeKey({ provider: "claude", modelProfile: "standard" })).toBe("claude-standard");
  });

  it("rejects unknown worker profiles and defaults outside their allowlist", () => {
    expect(() =>
      parseModelPolicy({
        roles: {},
        worker_profiles: { wizard: { allowed: ["codex-high"] } },
      }),
    ).toThrow();
    expect(() =>
      parseModelPolicy({
        roles: {},
        worker_profiles: {
          implementer: { default: "claude-standard", allowed: ["codex-high"] },
        },
      }),
    ).toThrow(/default runtime must also appear in allowed/);
  });
});

describe("role defaults (09 section 5)", () => {
  it("routes coordinating roles to codex high", () => {
    for (const role of ["head-maid", "maid", "manager"] as const) {
      expect(roleDefaultRuntime({ role })).toEqual({ provider: "codex", modelProfile: "high" });
    }
  });

  it("routes worker task classes per the table", () => {
    expect(roleDefaultRuntime({ role: "worker", profile: "implementer" }, "normal-implementation"))
      .toEqual({ provider: "codex", modelProfile: "standard" });
    expect(roleDefaultRuntime({ role: "worker", profile: "mechanical-editor" }, "mechanical-edit"))
      .toEqual({ provider: "codex", modelProfile: "economy" });
    expect(roleDefaultRuntime({ role: "worker", profile: "security-reviewer" }, "security-review"))
      .toEqual({ provider: "codex", modelProfile: "high" });
    expect(roleDefaultRuntime({ role: "worker", profile: "researcher" }, "difficult-design"))
      .toEqual({ provider: "codex", modelProfile: "high" });
  });

  it("falls back to the worker profile default without a task class", () => {
    expect(roleDefaultRuntime({ role: "worker", profile: "mechanical-editor" })).toEqual({
      provider: "codex",
      modelProfile: "economy",
    });
  });
});

describe("manager proposal validation (09 section 6)", () => {
  it("accepts an allowed proposal and resolves the model in the Control Plane", () => {
    const result = validateManagerProposal(
      { workerProfile: "implementer", provider: "claude", modelProfile: "standard" },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.routing.resolvedModel).toBe("sonnet");
      expect(result.routing.runtime).toEqual({ provider: "claude", modelProfile: "standard" });
    }
  });

  it("rejects rather than clamps a proposal outside the allowed list", () => {
    const result = validateManagerProposal(
      { workerProfile: "reviewer", provider: "codex", modelProfile: "economy" },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_allowed_by_policy");
    // No clamped routing is produced at all.
    expect(Object.prototype.hasOwnProperty.call(result, "routing")).toBe(false);
  });

  it("rejects a concrete node path or credential named by the manager", () => {
    for (const field of ["executionNodeId", "nodePath", "credential", "apiKey", "model"]) {
      const result = validateManagerProposal(
        {
          workerProfile: "implementer",
          provider: "codex",
          modelProfile: "standard",
          [field]: "whatever",
        },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("forbidden_field");
        expect(result.offendingFields).toContain(field);
      }
    }
  });

  it("rejects unknown worker profiles and malformed proposals", () => {
    const unknown = validateManagerProposal(
      { workerProfile: "wizard", provider: "codex", modelProfile: "high" },
      ctx,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe("unknown_worker_profile");

    const malformed = validateManagerProposal({ provider: "codex" }, ctx);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.reason).toBe("malformed_proposal");
  });

  it("rejects a worker profile with no policy entry", () => {
    const result = validateManagerProposal(
      { workerProfile: "tester", provider: "codex", modelProfile: "standard" },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_policy_for_worker_profile");
  });

  it("rejects on capability, quota and gate policy", () => {
    const capability = validateManagerProposal(
      { workerProfile: "implementer", provider: "claude", modelProfile: "standard" },
      { ...ctx, capabilities: { supported: { claude: ["high"] } } },
    );
    expect(capability.ok).toBe(false);
    if (!capability.ok) expect(capability.reason).toBe("capability_unsupported");

    const quota = validateManagerProposal(
      { workerProfile: "implementer", provider: "claude", modelProfile: "standard" },
      { ...ctx, quota: { remainingByProvider: { claude: 0 } } },
    );
    expect(quota.ok).toBe(false);
    if (!quota.ok) expect(quota.reason).toBe("quota_exhausted");

    const gated = validateManagerProposal(
      { workerProfile: "implementer", provider: "codex", modelProfile: "high" },
      { ...ctx, gates: { requiresApproval: ["codex-high"] } },
    );
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.reason).toBe("gate_required");

    const approved = validateManagerProposal(
      { workerProfile: "implementer", provider: "codex", modelProfile: "high" },
      { ...ctx, gates: { requiresApproval: ["codex-high"], approvals: ["codex-high"] } },
    );
    expect(approved.ok).toBe(true);
  });
});
