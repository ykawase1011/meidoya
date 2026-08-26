import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ALLOWLIST } from "./allowlist.ts";
import { KNOWN_GAPS } from "./known-gaps.ts";
import { applyMutant, generateMutants } from "./mutants.ts";
import { TARGETS } from "./targets.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The mutation gate is itself enforcement with a failure mode: a generator that
 * quietly stops producing mutants for a construct turns the gate green without
 * checking anything. These tests are the gate's own regression signal.
 */
describe("mutant generation", () => {
  it("mutates the operator, not the surrounding expression", () => {
    const source = `export function f(a: number, b: number) { return a < b; }\n`;
    const mutants = generateMutants("f.ts", source).filter(
      (m) => m.mutator === "ConditionalBoundary",
    );
    expect(mutants).toHaveLength(1);
    expect(applyMutant(source, mutants[0]!)).toContain("a >= b");
  });

  it("forces both directions of an if condition", () => {
    const source = `export function f(x: string) { if (x !== "a") { throw new Error("no"); } }\n`;
    const forced = generateMutants("f.ts", source)
      .filter((m) => m.mutator.startsWith("Condition") && m.mutator !== "ConditionalBoundary")
      .map((m) => applyMutant(source, m));
    expect(forced).toContain(`export function f(x: string) { if (false) { throw new Error("no"); } }\n`);
    expect(forced).toContain(`export function f(x: string) { if (true) { throw new Error("no"); } }\n`);
  });

  it("removes a zero-argument schema guard such as .strict()", () => {
    const source = `const S = z.object({ a: z.string() }).strict();\n`;
    const mutants = generateMutants("s.ts", source).filter((m) => m.mutator === "RemoveGuardCall");
    expect(mutants).toHaveLength(1);
    expect(applyMutant(source, mutants[0]!)).toBe(`const S = z.object({ a: z.string() });\n`);
  });

  it("never mutates text inside a string, a comment, or a type", () => {
    const source = [
      `// if (a === b) return true;`,
      `const message = "a === b && c";`,
      `type T = { flag: true };`,
      ``,
    ].join("\n");
    expect(generateMutants("t.ts", source)).toEqual([]);
  });

  it("does not force a while condition true, which would hang the run", () => {
    const source = `export function f(n: number) { while (n > 0) { n -= 1; } }\n`;
    const forced = generateMutants("f.ts", source).map((m) => m.mutator);
    expect(forced).toContain("ConditionFalse");
    expect(forced).not.toContain("ConditionTrue");
  });

  it("gives two identical mutations in one scope distinct ids", () => {
    const source = `export function f(a: string, b: string) { return a === b || b === a; }\n`;
    const ids = generateMutants("f.ts", source)
      .filter((m) => m.mutator === "EqualityOperator")
      .map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps ids free of line numbers, so an edit above a guard cannot re-point an allowlist entry", () => {
    const guard = `export function f(x: string) { if (x !== "a") { throw new Error("no"); } }\n`;
    const before = generateMutants("f.ts", guard).map((m) => m.id);
    const after = generateMutants("f.ts", `// a new comment\n\n${guard}`).map((m) => m.id);
    expect(after).toEqual(before);
  });
});

describe("mutation targets", () => {
  it("names files that exist and produce at least one mutant", () => {
    for (const target of TARGETS) {
      const text = readFileSync(join(repoRoot, target.file), "utf8");
      expect(generateMutants(target.file, text).length, target.file).toBeGreaterThan(0);
    }
  });

  it("declares a non-empty evidence set and a rationale for every target", () => {
    for (const target of TARGETS) {
      expect(target.tests.length, target.file).toBeGreaterThan(0);
      expect(target.why.length, target.file).toBeGreaterThan(20);
    }
  });

  it("lists no module twice", () => {
    expect(new Set(TARGETS.map((t) => t.file)).size).toBe(TARGETS.length);
  });
});

describe("the equivalent-mutant allowlist", () => {
  it("carries a real argument on every entry, not a bare assertion", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, entry.id).toBeGreaterThan(30);
    }
  });

  it("lists no id twice", () => {
    expect(new Set(ALLOWLIST.map((e) => e.id)).size).toBe(ALLOWLIST.length);
  });

  it("refers only to mutants the generator can still produce", () => {
    for (const entry of ALLOWLIST) {
      expect(generatedIds().has(entry.id), `orphaned allowlist entry: ${entry.id}`).toBe(true);
    }
  });
});

function generatedIds(): Set<string> {
  return new Set(
    TARGETS.flatMap((target) =>
      generateMutants(target.file, readFileSync(join(repoRoot, target.file), "utf8")).map(
        (m) => m.id,
      ),
    ),
  );
}

/**
 * The known-gaps list is debt, and debt that can quietly be reclassified as
 * "equivalent" is not debt. These keep the two lists from blurring.
 */
describe("the known-gaps ratchet", () => {
  it("never overlaps the equivalent-mutant allowlist", () => {
    const allowed = new Set(ALLOWLIST.map((e) => e.id));
    for (const gap of KNOWN_GAPS) {
      expect(allowed.has(gap.id), `${gap.id} is booked as both equivalent and unguarded`).toBe(
        false,
      );
    }
  });

  it("lists no id twice", () => {
    expect(new Set(KNOWN_GAPS.map((e) => e.id)).size).toBe(KNOWN_GAPS.length);
  });

  it("says what is unguarded on every entry", () => {
    for (const entry of KNOWN_GAPS) {
      expect(entry.gap.length, entry.id).toBeGreaterThan(20);
    }
  });

  it("refers only to mutants the generator can still produce", () => {
    const known = generatedIds();
    for (const entry of KNOWN_GAPS) {
      expect(known.has(entry.id), `orphaned known-gap entry: ${entry.id}`).toBe(true);
    }
  });
});
