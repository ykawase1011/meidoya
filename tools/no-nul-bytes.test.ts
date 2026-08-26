import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|sql|json|md|ya?ml)$/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, found);
    } else if (SOURCE_EXTENSIONS.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * A raw U+0000 byte in a source file makes git classify it as binary, so
 * `git diff` and `git show` render no diff at all and `grep` skips it without
 * `-a`. That silently hid a security defect in `apps/meidoyad/src/scope.ts`
 * through an entire review cycle. Write the escape sequence instead; the
 * resulting string value is identical.
 */
describe("source files are text", () => {
  it("contains no raw NUL bytes", () => {
    const offenders: string[] = [];

    for (const path of sourceFiles(repoRoot)) {
      const offset = readFileSync(path).indexOf(0);
      if (offset !== -1) {
        offenders.push(`${relative(repoRoot, path)} @${offset}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
