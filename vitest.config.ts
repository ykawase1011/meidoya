import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type AliasOptions } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Map every workspace package to its TypeScript source entrypoint.
 *
 * Without this, `main: "./dist/index.js"` makes the suite validate the last
 * build instead of the current sources: editing `packages/X/src` has no effect
 * on any test outside package X until `pnpm -r build` runs. Tests must exercise
 * `src/`, so cross-package regressions surface immediately.
 *
 * The list is derived from the filesystem so a newly added workspace package is
 * covered automatically; a hardcoded list would silently reintroduce the bug.
 *
 * Only production `main`/`exports` stay on `dist` — this alias affects vitest
 * resolution exclusively. The `find` patterns are anchored RegExps so bare
 * specifiers are redirected while explicit subpath imports
 * (e.g. `@meidoya/workflows-temporal/dist/workflows/index.js`, which the
 * Temporal replay tests use on purpose) keep resolving to the built artifact.
 */
function workspaceSourceAliases(): AliasOptions {
  const aliases: { find: RegExp; replacement: string }[] = [];
  for (const group of ["packages", "apps"]) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(groupDir, entry.name);
      const manifestPath = join(pkgDir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name?: string;
        exports?: unknown;
      };
      const name = manifest.name;
      if (name === undefined) continue;
      if (manifest.exports !== undefined) {
        // A package with an `exports` map may expose entrypoints other than
        // `src/index.ts`; refuse to guess rather than mis-resolve it.
        throw new Error(
          `vitest.config.ts: ${name} declares "exports"; add an explicit source alias for it.`
        );
      }
      const entryPoint = join(pkgDir, "src", "index.ts");
      if (!existsSync(entryPoint)) {
        throw new Error(
          `vitest.config.ts: ${name} has no src/index.ts; tests would silently fall back to dist/.`
        );
      }
      aliases.push({
        find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        replacement: entryPoint,
      });
    }
  }
  return aliases;
}

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases(),
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tools/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: [
      join(root, "packages", "temporal-test-env", "src", "runtime-setup.ts"),
    ],
    /**
     * Reclaims ephemeral Temporal servers left behind by a run that was killed
     * before it could tear its own down, and does it again on the way out. A run
     * that dies to SIGKILL executes no JavaScript, so the only thing that can
     * clean up after it is the next run — see the module for the full argument.
     *
     * It reclaims only servers on ports THIS repo's test helper reserved and
     * journalled, whose reserving process is gone. A server nobody journalled,
     * or one a concurrently running process still owns, is never touched.
     */
    globalSetup: [join(root, "packages", "temporal-test-env", "src", "global-setup.ts")],
  },
});
