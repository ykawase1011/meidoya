import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packagesRoot = resolve(here, "..", "..");

/** Only this module may know concrete vendor model names, and only via config. */
const CONFIG_MAPPING_LAYER = new Set(["model-mapping.ts"]);

const PACKAGES = ["agent-runtime", "model-router", "runtime-codex", "runtime-claude"];

const CONCRETE_MODEL_PATTERNS: readonly RegExp[] = [
  // Names used by the example `models:` mapping in docs/design/config.example.yaml.
  /\bsol\b/i,
  /\bterra\b/i,
  /\bluna\b/i,
  /\bopus\b/i,
  /\bsonnet\b/i,
  /\bhaiku\b/i,
  // Common real vendor identifiers that must never be hard-coded either.
  /claude-[0-9]/i,
  /\bgpt-[0-9]/i,
  /\bo[0-9]-(mini|preview)\b/i,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

describe("09 section 4: no concrete model names in domain logic", () => {
  it("finds no vendor model string outside the config mapping layer", () => {
    const offenders: string[] = [];
    for (const pkg of PACKAGES) {
      for (const file of sourceFiles(join(packagesRoot, pkg, "src"))) {
        if (CONFIG_MAPPING_LAYER.has(file.split("/").pop() as string)) continue;
        const content = readFileSync(file, "utf8");
        for (const pattern of CONCRETE_MODEL_PATTERNS) {
          const match = pattern.exec(content);
          if (match !== null) offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the mapping layer itself carries no hard-coded names either", () => {
    const content = readFileSync(join(packagesRoot, "model-router", "src", "model-mapping.ts"), "utf8");
    for (const pattern of CONCRETE_MODEL_PATTERNS) {
      expect(pattern.test(content)).toBe(false);
    }
  });
});
