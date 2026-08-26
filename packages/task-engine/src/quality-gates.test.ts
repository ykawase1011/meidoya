import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUALITY_GATES,
  QualityGateConfigError,
  gateKeyOf,
  parseQualityGateCatalog,
  parseQualityGateCommand,
  resolveQualityGate,
} from "./quality-gates.js";

describe("quality gates", () => {
  it("parses the operator's configured commands into a fixed argv", () => {
    const catalog = parseQualityGateCatalog([
      { name: "test", command: "npm test" },
      { name: "lint", command: "npm run lint" },
      { name: "typecheck", command: "npm run typecheck" },
    ]);
    expect(catalog).toEqual(DEFAULT_QUALITY_GATES);
  });

  it("rejects operator commands that would need a shell to mean what they say", () => {
    for (const bad of [
      "npm test; cat /etc/passwd",
      "npm test && rm -rf /",
      "npm test | tee out",
      "echo $(whoami)",
      "echo `whoami`",
      "npm test\ncat secret",
      "sh -c 'cat secret'",
      "cat secret > /tmp/leak",
    ]) {
      expect(() => parseQualityGateCommand("test", bad)).toThrow(QualityGateConfigError);
    }
  });

  it("rejects duplicate and malformed gate names", () => {
    expect(() =>
      parseQualityGateCatalog([
        { name: "test", command: "npm test" },
        { name: "test", command: "npm run other" },
      ]),
    ).toThrow(QualityGateConfigError);
    expect(() => parseQualityGateCommand("../../evil", "npm test")).toThrow(QualityGateConfigError);
  });

  it("resolves only names the operator configured", () => {
    expect(resolveQualityGate(DEFAULT_QUALITY_GATES, "test")).toEqual({
      ok: true,
      gate: { name: "test", argv: ["npm", "test"] },
    });
    // A group prefix only labels the result group; the gate is still `test`.
    expect(gateKeyOf("quality:test")).toBe("test");
    expect(resolveQualityGate(DEFAULT_QUALITY_GATES, "quality:test")).toEqual({
      ok: true,
      gate: { name: "test", argv: ["npm", "test"] },
    });
    expect(resolveQualityGate(DEFAULT_QUALITY_GATES, "curl")).toEqual({
      ok: false,
      reason: "not-allowlisted",
    });
  });

  it("refuses selectors carrying shell syntax or paths", () => {
    for (const bad of [
      "test; cat /etc/passwd",
      "test && id",
      "test | sh",
      "test$(id)",
      "test`id`",
      "test\nlint",
      "../../bin/sh",
      "/bin/sh",
      "",
    ]) {
      expect(resolveQualityGate(DEFAULT_QUALITY_GATES, bad)).toEqual({
        ok: false,
        reason: "invalid-selector",
      });
    }
  });
});
