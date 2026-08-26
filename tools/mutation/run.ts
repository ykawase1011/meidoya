/**
 * The mutation gate.
 *
 * Applies one source mutation at a time to a listed security/correctness
 * module, runs that module's declared test subset, and fails the build if the
 * suite stayed green — i.e. if the guard that was just broken has no regression
 * signal behind it.
 *
 * This is the structural answer to a defect this repository has shipped at
 * least eight times: an enforcement check that was correct, load-bearing, and
 * deletable with 1241 tests still passing. Line coverage never caught one of
 * them; every gap sat on a covered line.
 *
 * Run it (Node >= 22; this file is executed through native type stripping):
 *   pnpm mutation                            # everything
 *   pnpm mutation --targets scope,api        # substring match on the file path
 *   pnpm mutation --list                     # generate mutants, run nothing
 *   pnpm mutation --changed-from origin/main # only what a diff could have weakened
 *   pnpm mutation --shard 1/4                # one CI shard
 *   pnpm mutation --ids-from report.json     # re-run a previous run's survivors
 *   pnpm mutation --json report.json         # machine-readable result set
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ALLOWLIST } from "./allowlist.ts";
import { KNOWN_GAPS } from "./known-gaps.ts";
import { applyMutant, generateMutants, type Mutant } from "./mutants.ts";
import { TARGETS, type MutationTarget } from "./targets.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A mutant that hangs must not hang the build, so each run is capped relative
 * to that target's own measured baseline: a mutated loop condition or a mutated
 * retry bound is cut off rather than sitting until the job times out. Ten times
 * the clean run, floor 20s, is far outside the noise on a loaded CI runner while
 * still bounding the worst case at a few minutes per module.
 *
 * A timeout is scored as *killed*. That is the conservative direction for the
 * runner's health and the permissive one for rigour — a guard whose only signal
 * is "breaking it makes the suite slow" is weak evidence. It is rare (5 of the
 * first 1356 mutants) and each one is printed as `timeout`, not `killed`, in the
 * log so it can be looked at.
 */
function timeoutFor(baselineMs: number): number {
  return Math.max(20_000, baselineMs * 10);
}

/* ------------------------------------------------------------------------- */
/* Crash safety and mutual exclusion                                          */
/*                                                                            */
/* This harness edits real files in the real working tree, so "the tree is    */
/* byte-identical when the run ends" has to hold even when the run does not   */
/* end — a CI step timeout, a SIGKILL, a laptop lid.                          */
/*                                                                            */
/* A signal handler is NOT sufficient and must not be relied on: every test   */
/* run goes through `spawnSync`, which blocks the event loop, so a SIGTERM     */
/* arriving mid-run is queued until the child exits and a SIGKILL is never     */
/* delivered to JavaScript at all. That is not a theoretical hole — it is how  */
/* a mutant survived a killed run and was read by another process.            */
/*                                                                            */
/* So the durable record is a journal on disk, written before the first        */
/* mutation and consulted by the NEXT run, plus an exclusive lock so two runs  */
/* can never interleave mutants in one tree.                                   */
/* ------------------------------------------------------------------------- */

const stateDir = join(repoRoot, "node_modules", ".cache", "meidoya-mutation");
const journalPath = join(stateDir, "journal.json");
const lockPath = join(stateDir, "run.lock");

type Journal = { pid: number; startedAt: string; files: { file: string; original: string }[] };

/**
 * Takes an exclusive lock, or fails fast. Two mutation runs in one tree would
 * each restore the other's mutant as "the original" and silently corrupt the
 * working tree; failing is the only safe answer.
 */
function acquireLock(): () => void {
  mkdirSync(stateDir, { recursive: true });
  try {
    closeSync(openSync(lockPath, "wx"));
  } catch {
    throw new Error(
      `another mutation run holds ${lockPath}. Only one may mutate a tree at a time.\n` +
        `If no run is active, delete that file and re-run.`,
    );
  }
  return () => rmSync(lockPath, { force: true });
}

/**
 * Undo whatever a previously killed run left behind, before doing anything else.
 *
 * A file is only rewritten when its current contents are EXACTLY one of the
 * mutants this generator would produce from the journalled original. Anything
 * else — a real edit made since, a hand fix — is left alone and reported, so a
 * stale journal can never eat someone's work.
 */
function recoverFromCrash(): void {
  if (!existsSync(journalPath)) return;
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  const restored: string[] = [];
  const refused: string[] = [];
  for (const { file, original } of journal.files) {
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) continue;
    const current = readFileSync(abs, "utf8");
    if (current === original) continue;
    const isMutantOfOriginal = generateMutants(file, original).some(
      (mutant) => applyMutant(original, mutant) === current,
    );
    if (isMutantOfOriginal) {
      writeFileSync(abs, original);
      restored.push(file);
    } else {
      refused.push(file);
    }
  }
  rmSync(journalPath, { force: true });
  if (restored.length > 0) {
    process.stdout.write(
      `recovered from an interrupted run — restored ${restored.length} file(s):\n` +
        restored.map((f) => `  ${f}\n`).join(""),
    );
  }
  if (refused.length > 0) {
    throw new Error(
      `a previous run was interrupted and these files have since been edited, so ` +
        `this run cannot tell a mutant from a real change:\n` +
        refused.map((f) => `  ${f}\n`).join("") +
        `Inspect them (git diff) and fix by hand before re-running.`,
    );
  }
}

type Outcome = "killed" | "survived" | "timeout";

type Result = {
  mutant: Mutant;
  outcome: Outcome;
  durationMs: number;
};

type Options = {
  changedFrom: string | undefined;
  targetFilter: string[];
  mutatorFilter: string[];
  idFilter: string | undefined;
  /** Re-run exactly the survivors of a previous `--json` report. */
  idsFrom: string | undefined;
  shard: { index: number; total: number } | undefined;
  listOnly: boolean;
  jsonOut: string | undefined;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    changedFrom: undefined,
    targetFilter: [],
    mutatorFilter: [],
    idFilter: undefined,
    idsFrom: undefined,
    shard: undefined,
    listOnly: false,
    jsonOut: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${String(arg)} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--targets":
        options.targetFilter = next().split(",").filter(Boolean);
        break;
      case "--changed-from":
        options.changedFrom = next();
        break;
      case "--mutator":
        options.mutatorFilter = next().split(",").filter(Boolean);
        break;
      case "--id":
        options.idFilter = next();
        break;
      case "--ids-from":
        options.idsFrom = next();
        break;
      case "--shard": {
        const [index, total] = next().split("/");
        if (index === undefined || total === undefined) {
          throw new Error("--shard expects i/n");
        }
        options.shard = { index: Number(index), total: Number(total) };
        break;
      }
      case "--list":
        options.listOnly = true;
        break;
      case "--json":
        options.jsonOut = next();
        break;
      default:
        throw new Error(`unknown flag: ${String(arg)}`);
    }
  }
  if (options.shard !== undefined) {
    const { index, total } = options.shard;
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
      throw new Error(`--shard ${index}/${total} is out of range`);
    }
  }
  return options;
}

/**
 * Targets a diff can plausibly have weakened: the module itself, or any file in
 * its declared evidence set (deleting a test is exactly as dangerous as
 * deleting the guard). A change to the harness re-runs everything, because a
 * mutator or an allowlist edit changes what every other result means.
 *
 * Files outside the curated target list select nothing — that is the
 * documented limit of the per-PR run, and why the full set also runs nightly.
 */
function selectChanged(baseRef: string): MutationTarget[] {
  const diff = spawnSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (diff.status !== 0) {
    throw new Error(`git diff against ${baseRef} failed: ${String(diff.stderr).trim()}`);
  }
  const changed = diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (changed.some((file) => file.startsWith("tools/mutation/"))) return [...TARGETS];
  return TARGETS.filter((target) =>
    changed.some(
      (file) =>
        file === target.file ||
        target.tests.some((test) => (test.endsWith("/") ? file.startsWith(test) : file === test)),
    ),
  );
}

function runTests(target: MutationTarget, timeout: number): { ok: boolean; timedOut: boolean; diagnostics: string } {
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", ...target.tests, "--reporter=dot", "--silent"],
    {
      cwd: repoRoot,
      timeout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // `CI` keeps vitest strictly non-interactive: a mutant that trips a
      // prompt would otherwise sit until the timeout and be scored as killed
      // for the wrong reason. Nothing in the suite branches on it (checked).
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    },
  );
  const timedOut = result.signal !== null || result.error !== undefined;
  const diagnostics = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-8_000);
  return { ok: !timedOut && result.status === 0, timedOut, diagnostics };
}

/**
 * Applies a mutation, runs `body`, restores the file — and refuses to write at
 * all if the file on disk is not the text this run cached.
 *
 * The harness edits real source files in the real working tree, so a concurrent
 * editor (another agent, a running `tsc --watch`, a human) would otherwise have
 * their change silently reverted by the restore: the cached original is written
 * back over it. Both ends are checked, so the worst case is a clear abort
 * instead of lost work. This is not hypothetical — it happened on the first
 * long run of this gate.
 */
function withMutation<T>(absPath: string, original: string, mutated: string, body: () => T): T {
  const onDisk = readFileSync(absPath, "utf8");
  if (onDisk !== original) {
    throw new Error(
      `${absPath} changed under the run — refusing to overwrite it. ` +
        `Re-run the gate on a settled working tree.`,
    );
  }
  writeFileSync(absPath, mutated);
  try {
    return body();
  } finally {
    if (readFileSync(absPath, "utf8") !== mutated) {
      throw new Error(
        `${absPath} was written while a mutant was applied — the mutation, not ` +
          `the original, is what is on disk now. Restore it by hand: this run ` +
          `will not guess which text to keep.`,
      );
    }
    writeFileSync(absPath, original);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.listOnly) {
    listOnly(options);
    return;
  }
  const releaseLock = acquireLock();
  try {
    recoverFromCrash();
    gate(options);
  } finally {
    rmSync(journalPath, { force: true });
    releaseLock();
  }
}

function listOnly(options: Options): void {
  for (const target of TARGETS) {
    if (
      options.targetFilter.length > 0 &&
      !options.targetFilter.some((needle) => target.file.includes(needle))
    ) {
      continue;
    }
    for (const mutant of generateMutants(
      target.file,
      readFileSync(join(repoRoot, target.file), "utf8"),
    )) {
      process.stdout.write(`${mutant.file}:${mutant.line}  ${mutant.mutator}  ${mutant.id}\n`);
    }
  }
}

function gate(options: Options): void {

  const pool =
    options.changedFrom === undefined ? [...TARGETS] : selectChanged(options.changedFrom);
  if (options.changedFrom !== undefined && pool.length === 0) {
    process.stdout.write(
      `mutation gate: no gated module or its tests changed since ${options.changedFrom}; nothing to do.\n` +
        `(The full set still runs on the nightly schedule.)\n`,
    );
    return;
  }

  const selected = pool.filter(
    (target) =>
      options.targetFilter.length === 0 ||
      options.targetFilter.some((needle) => target.file.includes(needle)),
  );
  if (selected.length === 0) {
    throw new Error(`--targets matched nothing (known: ${TARGETS.map((t) => t.file).join(", ")})`);
  }

  const replayIds =
    options.idsFrom === undefined
      ? undefined
      : new Set(
          (
            JSON.parse(readFileSync(resolve(repoRoot, options.idsFrom), "utf8")) as {
              survivors: { id: string }[];
            }
          ).survivors.map((s) => s.id),
        );

  // Sources are read once, up front. Every mutation is applied to this text and
  // the same text is written back, so a crashed run cannot leave a half-mutant
  // behind that a later run would build on.
  const sources = new Map<string, string>();
  const plan: { target: MutationTarget; mutant: Mutant }[] = [];
  for (const target of selected) {
    const abs = join(repoRoot, target.file);
    const text = readFileSync(abs, "utf8");
    sources.set(target.file, text);
    for (const mutant of generateMutants(target.file, text)) {
      if (
        options.mutatorFilter.length > 0 &&
        !options.mutatorFilter.includes(mutant.mutator)
      ) {
        continue;
      }
      if (options.idFilter !== undefined && !mutant.id.includes(options.idFilter)) continue;
      if (replayIds !== undefined && !replayIds.has(mutant.id)) continue;
      plan.push({ target, mutant });
    }
  }

  const shard = options.shard;
  const work =
    shard === undefined
      ? plan
      : plan.filter((_, index) => index % shard.total === shard.index - 1);

  // The durable undo record. Written before the first mutation, deleted on a
  // clean exit; a next run that finds it left behind restores from it.
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    journalPath,
    JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        files: [...sources].map(([file, original]) => ({ file, original })),
      } satisfies Journal,
      null,
      2,
    ),
  );

  process.stdout.write(
    `mutation gate: ${work.length} mutants across ${selected.length} modules` +
      `${shard === undefined ? "" : ` (shard ${shard.index}/${shard.total})`}\n\n`,
  );

  // A best-effort fast path for Ctrl-C between two `spawnSync` calls. It is NOT
  // the safety property — see the journal comment at the top of this file: a
  // signal that lands while a test run is in flight cannot be handled at all,
  // which is why the journal exists and why this handler leaves it in place for
  // the next run to act on.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      process.stdout.write(`\n${signal}: the next run will restore from the journal.\n`);
      process.exit(130);
    });
  }

  // Baseline. A red baseline would report every mutant as killed and turn the
  // gate into a rubber stamp, so it is checked before a single mutation.
  const targetsInWork = new Set(work.map(({ target }) => target.file));
  const budget = new Map<string, number>();
  for (const target of selected) {
    if (!targetsInWork.has(target.file)) continue;
    const started = Date.now();
    const { ok, diagnostics } = runTests(target, 300_000);
    if (!ok) {
      throw new Error(
        `baseline is red for ${target.file} (${target.tests.join(" ")}) — ` +
          `every mutant would look killed; fix the suite before gating` +
          (diagnostics === "" ? "" : `\n${diagnostics}`),
      );
    }
    const baselineMs = Date.now() - started;
    budget.set(target.file, timeoutFor(baselineMs));
    process.stdout.write(`  baseline ok  ${target.file}  ${baselineMs}ms\n`);
  }
  process.stdout.write("\n");

  const results: Result[] = [];
  const startedAll = Date.now();
  for (const [index, { target, mutant }] of work.entries()) {
    const abs = join(repoRoot, target.file);
    const original = sources.get(target.file);
    if (original === undefined) throw new Error(`no source cached for ${target.file}`);
    const started = Date.now();
    const { ok, timedOut } = withMutation(abs, original, applyMutant(original, mutant), () =>
      runTests(target, budget.get(target.file) ?? timeoutFor(0)),
    );
    const durationMs = Date.now() - started;
    const outcome: Outcome = timedOut ? "timeout" : ok ? "survived" : "killed";
    results.push({ mutant, outcome, durationMs });
    const mark = outcome === "survived" ? "SURVIVED" : outcome === "timeout" ? "timeout " : "killed  ";
    process.stdout.write(
      `[${String(index + 1).padStart(4)}/${work.length}] ${mark} ${mutant.file}:${mutant.line} ` +
        `${mutant.mutator} ${mutant.label} => ${mutant.replacement.slice(0, 40)} (${durationMs}ms)\n`,
    );
  }
  const elapsedMs = Date.now() - startedAll;

  const allowed = new Map(ALLOWLIST.map((entry) => [entry.id, entry.reason]));
  const debt = new Map(KNOWN_GAPS.map((entry) => [entry.id, entry.gap]));
  const survivors = results.filter((r) => r.outcome === "survived");
  const unexplained = survivors.filter(
    (r) => !allowed.has(r.mutant.id) && !debt.has(r.mutant.id),
  );
  const equivalent = survivors.filter((r) => allowed.has(r.mutant.id));
  const carried = survivors.filter((r) => debt.has(r.mutant.id) && !allowed.has(r.mutant.id));

  // A stale entry means someone wrote the test that kills a mutant we had
  // declared untestable (or had booked as debt). The entry must go, or the next
  // real gap in that guard is pre-approved.
  const surviving = new Set(survivors.map((r) => r.mutant.id));
  const generatedIds = new Set(work.map(({ mutant }) => mutant.id));
  const stale = [...ALLOWLIST, ...KNOWN_GAPS].filter(
    (entry) => generatedIds.has(entry.id) && !surviving.has(entry.id),
  );

  // An entry whose id no longer generates at all is a dangling exemption: the
  // guard it argued about was rewritten or deleted, and the argument was never
  // revisited. Only checkable when nothing narrowed the mutant universe.
  const universeIsComplete =
    options.changedFrom === undefined &&
    options.targetFilter.length === 0 &&
    options.mutatorFilter.length === 0 &&
    options.idFilter === undefined &&
    options.idsFrom === undefined;
  const orphaned = universeIsComplete
    ? (() => {
        const all = new Set(
          TARGETS.flatMap((target) =>
            generateMutants(target.file, readFileSync(join(repoRoot, target.file), "utf8")).map(
              (m) => m.id,
            ),
          ),
        );
        return [...ALLOWLIST, ...KNOWN_GAPS].filter((entry) => !all.has(entry.id));
      })()
    : [];

  const killed = results.filter((r) => r.outcome !== "survived").length;
  const score = results.length === 0 ? 100 : (killed / results.length) * 100;

  process.stdout.write(
    `\n${killed}/${results.length} mutants killed (${score.toFixed(1)}%) in ` +
      `${(elapsedMs / 1000).toFixed(0)}s\n` +
      `  ${equivalent.length} allowlisted equivalent, ${carried.length} carried as known gaps, ` +
      `${unexplained.length} unexplained\n`,
  );

  if (options.jsonOut !== undefined) {
    const out = resolve(repoRoot, options.jsonOut);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          elapsedMs,
          total: results.length,
          killed,
          survivors: survivors.map((r) => ({
            ...r.mutant,
            allowlisted: allowed.get(r.mutant.id),
            knownGap: debt.get(r.mutant.id),
          })),
        },
        null,
        2,
      )}\n`,
    );
  }

  if (equivalent.length > 0) {
    process.stdout.write(`\n${equivalent.length} allowlisted equivalent mutant(s):\n`);
    for (const r of equivalent) {
      process.stdout.write(`  ${r.mutant.id}\n      ${String(allowed.get(r.mutant.id))}\n`);
    }
  }

  if (carried.length > 0) {
    process.stdout.write(
      `\n${carried.length} known gap(s) still unguarded — this list may only shrink:\n`,
    );
    for (const r of carried) {
      process.stdout.write(
        `  ${r.mutant.file}:${r.mutant.line}  ${r.mutant.mutator}  ${r.mutant.label}\n` +
          `      ${String(debt.get(r.mutant.id))}\n`,
      );
    }
  }

  if (stale.length > 0) {
    process.stdout.write(`\nSTALE ENTRIES (now killed — delete them):\n`);
    for (const entry of stale) process.stdout.write(`  ${entry.id}\n`);
  }

  if (orphaned.length > 0) {
    process.stdout.write(
      `\nORPHANED ALLOWLIST ENTRIES (no such mutant exists any more — the guard was\n` +
        `rewritten; delete the entry, or re-argue it against the new code):\n`,
    );
    for (const entry of orphaned) process.stdout.write(`  ${entry.id}\n`);
  }

  if (unexplained.length > 0) {
    process.stdout.write(
      `\nUNGUARDED: ${unexplained.length} mutant(s) survived with no failing test.\n` +
        `Each one is a predicate you can delete and ship. Write the test that kills it.\n` +
        `Only if no test CAN kill it, add an argued entry to tools/mutation/allowlist.ts.\n\n`,
    );
    for (const r of unexplained) {
      process.stdout.write(
        `  ${r.mutant.file}:${r.mutant.line}  ${r.mutant.mutator}\n` +
          `    ${r.mutant.label}  =>  ${r.mutant.replacement}\n` +
          `    id: ${r.mutant.id}\n`,
      );
    }
  }

  if (unexplained.length > 0 || stale.length > 0 || orphaned.length > 0) process.exitCode = 1;
}

main();
