import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";
import { migrate } from "./migrate.js";
import { migrations } from "./migrations/index.js";
import { openDatabase } from "./db.js";

/**
 * F20, second half: `MAX(version)` was read OUTSIDE any transaction.
 *
 * Two daemons booting on one database both took a read lock, both saw an empty
 * ledger, both computed the same pending list, and the loser died part-way
 * through 0001 with `table environments already exists`. It failed CLOSED — no
 * half-migrated database — but on an error that says nothing true about what
 * happened, and on a machine where the daemon is supervised that is a boot loop
 * with a misleading log line. Ten barrier-synchronised processes over three
 * rounds reproduced it five times.
 *
 * This has to be REAL processes: better-sqlite3 is synchronous, so two
 * connections in one thread cannot interleave, and two connections that cannot
 * interleave cannot race. The child runs the actual `src/` files, transpiled
 * here rather than taken from `dist/`, so a stale build cannot make this pass.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROCESSES = 10;
const ROUNDS = 3;

let workdir: string;
let children: ChildProcess[] = [];

function transpile(file: string, rewrite: (source: string) => string = (s) => s): string {
  const source = ts.sys.readFile(file);
  if (source === undefined) throw new Error(`unreadable: ${file}`);
  return ts.transpileModule(rewrite(source), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;
}

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "meidoya-migrate-race-"));
  mkdirSync(join(workdir, "migrations"));

  const sqliteUrl = pathToFileURL(
    createRequire(import.meta.url).resolve("better-sqlite3"),
  ).href;

  writeFileSync(join(workdir, "migrate.mjs"), transpile(join(HERE, "migrate.ts")));
  // The real `openDatabase`, so the pragma sequence under test is the one the
  // daemon runs rather than a copy of it that can drift.
  writeFileSync(
    join(workdir, "db.mjs"),
    transpile(join(HERE, "db.ts"), (src) =>
      src.replace('from "better-sqlite3"', `from ${JSON.stringify(sqliteUrl)}`),
    ),
  );
  writeFileSync(
    join(workdir, "migrations", "index.mjs"),
    transpile(join(HERE, "migrations", "index.ts"), (s) =>
      s.replace('from "../migrate.js"', 'from "../migrate.mjs"'),
    ),
  );
  cpSync(join(HERE, "migrations"), join(workdir, "migrations"), {
    recursive: true,
    filter: (src) => !src.endsWith(".ts"),
  });

  writeFileSync(
    join(workdir, "child.mjs"),
    `import { openDatabase } from "./db.mjs";
import { migrate } from "./migrate.mjs";
import { migrations } from "./migrations/index.mjs";

process.on("message", (message) => {
  if (message.type !== "go") return;
  let db;
  try {
    db = openDatabase(message.path);
    migrate(db, migrations);
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
    process.send({ type: "done", version });
  } catch (error) {
    process.send({ type: "failed", message: String((error && error.message) || error) });
  } finally {
    if (db !== undefined) db.close();
  }
});
process.send({ type: "ready" });
`,
  );

  children = Array.from({ length: PROCESSES }, () => fork(join(workdir, "child.mjs")));
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once("message", () => {
            resolve();
          });
        }),
    ),
  );
}, 60_000);

afterAll(() => {
  for (const child of children) child.kill();
  if (workdir !== undefined) rmSync(workdir, { recursive: true, force: true });
});

type Result = { type: "done"; version: number } | { type: "failed"; message: string };

/** One barrier-synchronised round: every child migrates the same fresh file. */
function round(path: string): Promise<Result[]> {
  const results = children.map(
    (child) =>
      new Promise<Result>((resolve) => {
        child.once("message", (message) => {
          resolve(message as Result);
        });
      }),
  );
  for (const child of children) child.send({ type: "go", path });
  return Promise.all(results);
}

describe("F20: ten processes migrating one database at once", () => {
  function assertAllReached(results: Result[], version: number, label: string): void {
    const failures = results.filter(
      (r): r is Extract<Result, { type: "failed" }> => r.type === "failed",
    );
    expect(
      failures.map((f) => f.message),
      `${label}: ${String(failures.length)} of ${String(PROCESSES)} processes failed`,
    ).toEqual([]);
    expect(results.map((r) => (r.type === "done" ? r.version : -1))).toEqual(
      Array.from({ length: PROCESSES }, () => version),
    );
  }

  /**
   * The sharper case, and the one the deferred read really loses: an EXISTING
   * database being upgraded. On a fresh file the very first thing the runner
   * does is write, so it takes the write lock before it reads whether it likes
   * it or not. On an upgrade the ledger already exists and there is nothing to
   * write first, so a deferred transaction reads `MAX(version)` under a shared
   * lock, ten processes all decide the same migrations are pending, and the
   * losers re-apply one — `duplicate column name: signalled_at` — which is a
   * true statement about nothing the operator can act on.
   */
  it("upgrades an existing database exactly once, however many processes try", async () => {
    for (let n = 0; n < ROUNDS; n += 1) {
      const path = join(workdir, `upgrade-${String(n)}.db`);
      const seed = openDatabase(path);
      migrate(seed, migrations.slice(0, 4));
      seed.close();

      assertAllReached(await round(path), 8, `upgrade round ${String(n)}`);
    }
  }, 120_000);

  it("all succeed on a fresh file, and every one of them ends at the same version", async () => {
    for (let n = 0; n < ROUNDS; n += 1) {
      const path = join(workdir, `round-${String(n)}.db`);
      const results = await round(path);

      const failures = results.filter((r): r is Extract<Result, { type: "failed" }> =>
        r.type === "failed",
      );
      expect(
        failures.map((f) => f.message),
        `round ${String(n)}: ${String(failures.length)} of ${String(PROCESSES)} processes failed`,
      ).toEqual([]);
      expect(results.map((r) => (r.type === "done" ? r.version : -1))).toEqual(
        Array.from({ length: PROCESSES }, () => 8),
      );
    }
  }, 120_000);
});
