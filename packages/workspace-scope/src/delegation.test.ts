import { describe, expect, it } from "vitest";
import { DelegationRegistry } from "./delegation.js";

const registry = new DelegationRegistry([
  {
    source: "global",
    target: "work-grammarxiv",
    capabilities: ["status.read", "task.delegate", "task-summary.read"],
  },
  { source: "global", target: "work-it", capabilities: ["status.read", "task.delegate"] },
]);

describe("delegation grants", () => {
  it("returns the granted capabilities", () => {
    expect(registry.lookup("global", "work-it")).toEqual({
      outcome: "granted",
      capabilities: ["status.read", "task.delegate"],
    });
  });

  it("reports an ungranted workspace as not-found, never as permission-denied", () => {
    const result = registry.lookup("global", "work-secret");
    expect(result).toEqual({ outcome: "not-found" });
    expect(registry.check("global", "work-secret", "status.read")).toEqual({
      outcome: "not-found",
    });
  });

  it("cannot be used to probe for workspace existence", () => {
    const existing = registry.check("work-it", "work-grammarxiv", "status.read");
    const nonExisting = registry.check("work-it", "does-not-exist-at-all", "status.read");
    expect(existing).toEqual(nonExisting);
  });

  it("denies a capability that the grant does not include, once the grant exists", () => {
    expect(registry.check("global", "work-it", "task-summary.read")).toEqual({
      outcome: "capability-denied",
      capability: "task-summary.read",
    });
  });

  it("lists only visible targets", () => {
    expect(registry.visibleTargets("global")).toEqual(["work-grammarxiv", "work-it"]);
    expect(registry.visibleTargets("work-it")).toEqual([]);
  });

  it("treats an empty capability list as no grant", () => {
    const empty = new DelegationRegistry([
      { source: "global", target: "work-empty", capabilities: [] },
    ]);
    expect(empty.lookup("global", "work-empty")).toEqual({ outcome: "not-found" });
    expect(empty.visibleTargets("global")).toEqual([]);
  });
});
