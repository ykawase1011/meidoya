# The mutation gate

## Why this exists

Eight review cycles on this repository produced eight or more confirmed instances of the
same defect: **enforcement with no regression signal.** A security check that was correct,
load-bearing, and could be deleted outright with all 1241 tests still green.

The confirmed list includes the daemon's primary cross-tenant read predicate, the retention
set guarding the budget mint-back path, `.strict()` on the verification schema, the budget
charge verdict, and four separate checks inside the verification floor. Every one was found
by a human directing a mutation by hand, one at a time, after the defect had already
shipped.

Coverage does not find these. **Every one of the eight gaps sat on a covered line.** A test
that executes a guard without asserting on what the guard decides produces exactly the same
coverage number as a test that would fail if the guard vanished. The only measurement that
distinguishes them is to break the guard and see whether anything notices.

That is what this gate does, on every pull request, so the ninth instance fails the build
instead of waiting for a review.

## What it does

For each listed module, `tools/mutation/run.ts`:

1. runs the module's declared test subset once and refuses to continue if it is not green
   (a red baseline reports every mutant as "killed" and turns the gate into a rubber stamp);
2. applies **one** source mutation, runs that subset, restores the file;
3. records the mutant as *killed* if the suite went red, *survived* if it stayed green.

A survivor is a predicate you can delete and ship.

```bash
pnpm mutation                              # every gated module: 278 mutants, ~9 min
pnpm mutation --targets token,run-scope    # substring match on the module path
pnpm mutation --list                       # generate mutants, run nothing
pnpm mutation --changed-from origin/main   # only modules this branch could have weakened
pnpm mutation --ids-from report.json       # re-run a previous run's survivors
pnpm mutation --shard 1/4                  # one CI shard
pnpm mutation --json report.json
```

Requires Node >= 22 (`tools/` runs through native type stripping) and an otherwise idle
working tree — see the concurrency section.

`pnpm mutation --targets <module>` is the loop to use while writing the test that kills a
survivor: one module is one to three minutes.

## Which tool, and why not Stryker

`@stryker-mutator/core` with `@stryker-mutator/vitest-runner` is the obvious candidate and
was evaluated first. It was rejected for this repository, for reasons specific to it:

- **The vitest alias layer.** `vitest.config.ts` rewrites every workspace package specifier
  to `<pkg>/src/index.ts` so a cross-package mutation is visible without a rebuild. Stryker
  works from its own sandbox copy of the project and re-resolves modules inside it; the
  aliases are derived from the on-disk workspace layout at config-load time, and a sandbox
  copy is exactly the situation the alias function is written to throw on. Keeping the two
  resolution models in agreement is ongoing work that buys nothing.
- **The Temporal test server.** Seven suites here stand up a `TestWorkflowEnvironment`.
  Stryker's default is to run a broad test selection per mutant under a concurrency it
  chooses; each concurrent worker that touches those suites spawns its own
  `temporal-test-server-sdk-typescript` process, and an interrupted run leaks it. Under a
  run that deliberately breaks code and kills workers on timeout, that is a runner that
  degrades over its own execution and reports a different score each time.
- **Score stability.** A gate that fails the build has to be deterministic. The harness here
  runs one mutant at a time against a fixed, declared file list, in-process count of nothing
  — the same commit produces the same result set every time.

The hand-rolled harness is ~250 lines, has no dependency beyond the `typescript` package
already in the repo, and is the approach that has actually been used here by hand for eight
cycles. It is also readable, which for a build gate matters more than feature breadth.

What is given up: Stryker's mutator catalogue is larger, and its HTML report is better. Both
are recoverable later; neither is why the eight defects shipped.

## Scope: what is gated

`tools/mutation/targets.ts` is the list, with a one-line rationale per module. The selection
rule is: **a surviving mutant here means a security or correctness boundary is unguarded.**

| module | boundary | first-run result |
| --- | --- | --- |
| `packages/workspace-scope/src/token.ts` | mints and verifies the capability token behind every scoped call | 121 mutants, **30 survivors** — 23 fixed, 7 argued equivalent |
| `packages/node-runtime/src/run-scope.ts` | seals the authoritative run scope over what a worker claims | 27 mutants, 0 survivors |
| `packages/workflows-temporal/src/refusals.ts` | retryable vs. non-retryable classification | 1 mutant, 0 survivors |
| `packages/workflows-temporal/src/plan-capabilities.ts` | plan capability ∩ workspace grant | 76 mutants, **27 survivors**, all carried as known gaps |
| `packages/task-engine/src/completion.ts` | the decision that a task is done | 53 mutants, **3 survivors** — all 3 fixed |

**278 mutants, 9m19s, 244 killed (87.8%).** Of the 34 survivors: 7 argued equivalent, 27
booked as debt, 0 unexplained.

This list is deliberately smaller than the set of modules that deserve gating. Nine more were
measured with this harness and are recorded, commented out with their survivor counts, at the
top of `targets.ts` — including the whole `apps/meidoyad` daemon surface and
`apps/meidoya-node/src/verification.ts`. They are not gated yet because their honest evidence
sets have not been settled: `api.ts` shows 118 survivors out of 155, which is mostly a
statement about `api.test.ts` having six tests while the daemon's real behaviour is asserted
from the Temporal-backed suites this gate excludes. Booking 359 unvalidated survivors as debt
would have made the ratchet meaningless. Widening is per-module work: settle the evidence
set, re-run, then split the result into fixes, allowlist and known-gaps.

Each target also declares its **evidence set** — the vitest filters that must go red. This is
deliberately the module's own tests plus the small number of suites where its enforcement is
only observable end to end. It is *not* the whole suite. The claim the gate makes is
"breaking this guard is caught **nearby**", which is the property that survives a refactor;
a guard whose only signal is three packages away is a guard that will lose its signal.

## Scope: what is deliberately NOT gated

Say this out loud, because a gate whose limits are unstated gets read as a guarantee.

- **Everything outside `targets.ts`.** Five modules are gated; nine more are measured but
  not yet gated (see above), and the rest of the repository is unmeasured. Adding one is a
  four-line diff (below) and is the right response to any new enforcement code.
- **The Temporal-backed suites.** No target's evidence set includes
  `workflows/*.test.ts`, `refusals-runtime.test.ts`, `daemon.test.ts`, `gates.test.ts` or
  `checkpoint-redelivery.test.ts`. Those need a `TestWorkflowEnvironment`, which costs tens
  of seconds per mutant and leaks a `temporal-test-server-sdk-typescript` process when a
  run is killed on timeout. The harness therefore never spawns one. **Consequence: a guard
  whose only enforcement is observable through a real workflow execution is invisible to
  this gate.** `refusals.ts` is the sharpest case — its retry dispositions are a data table,
  which generates one mutant, and the thing that actually validates them
  (`refusals-runtime.test.ts`, which throws each refusal at a real server and counts the
  attempts) is out of scope here on purpose.
- **Data and configuration.** The gate mutates operators and conditions. A wrong string in a
  lookup table, a missing entry in a retention set, or a schema field that should have been
  required but is a plain `z.string()` are not expressible as mutants of the kinds
  generated. `RemoveGuardCall` covers the specific `.strict()` family and nothing more.

  **AND A SECURITY BOUNDARY CAN BE MADE OF DATA, which is the part this section used to
  leave for the reader to work out.** `packages/execution-native/src/gate-confinement.ts`
  generates the SBPL profile that every quality gate on a `mac-restricted` node runs under —
  the writes allowlist, the credential denials, the daemon's data dir, `(deny network*)`.
  Every one of those rules is a string literal, so the module is outside this gate **by
  construction**: mutate it and nothing changes, because there is nothing here that mutates
  a string. It is also the module the whole "the OS boundary carries the weight" argument
  rests on, and a round of review found that boundary open on reads and open on network
  while the suite was green — the tests asserted that the GENERATOR emitted a line, never
  that the kernel did anything with it.

  The rule that follows from that, and it is not optional: **a boundary made of data is
  bound by EXECUTED BEHAVIOUR or it is not bound at all.** `gate-confinement.test.ts`'s
  "the generated profile, as the kernel applies it" block spawns a real child through the
  real `/usr/bin/sandbox-exec` and the real generated profile and asserts what that child
  could and could not reach — a planted credential, the daemon's socket, a TCP listener the
  test itself started so a refusal is EPERM from the kernel and not a connection failing for
  want of a server. Deleting any one rule from the profile turns a named test red. That is
  the substitute for a mutation score here, and any new rule in that file needs the same
  treatment rather than an `expect(profile).toContain(…)`.
- **Whole-statement deletion.** No mutator deletes a statement, so a missing side effect (an
  audit log line, a revocation write) is not measured. Forcing an enclosing condition false
  is the closest approximation and only applies where there is an enclosing condition.
- **Type-level enforcement.** Mutants are applied to source and run through vitest's esbuild
  transform, which strips types without checking them. A guard that exists only in the type
  system is unmeasurable here by construction — `pnpm typecheck` is its gate.
- **Equivalence detection.** The harness cannot tell an equivalent mutant from an unguarded
  one. That judgement is human, and it is recorded in the allowlist with an argument.

## Cadence

**The whole gated set, on every pull request.** 278 mutants in 9m19s measured locally; a
hosted runner lands well inside the job's 45-minute timeout. It is cheap enough that there is
no reason to defer it to a nightly and let a guard with no signal merge in the meantime — the
entire point is that the ninth instance must not merge.

It is a separate job from `test`, so a slow mutation run never delays typecheck/lint/test
feedback.

Two mechanisms exist for when the target list outgrows that budget, and are wired but not
currently used by CI:

- `--changed-from <ref>` restricts the run to gated modules the diff could have weakened —
  the module itself, or any test in its declared evidence set (deleting a test is exactly as
  dangerous as deleting the guard); a change to `tools/mutation/**` re-runs everything.
- `--shard i/n` splits the mutant list across runners. Sharding is across *runners*, never
  within one: see the concurrency section below.

## Concurrency: this harness owns the tree

The harness edits real source files in the real working tree. That is what makes it simple
and what makes it dangerous, and both need saying plainly.

**Nothing else may touch the repository while it runs.** During the ~2 second window that a
mutant is applied, any other process reading those files sees broken code — a `tsc --watch`,
a second test run, another agent. On the first long run of this gate that is exactly what
happened: mutants in `ports.ts`, `server.ts` and `verification.ts` were captured mid-flight by
a concurrent process and one transiently broke `pnpm build`.

Three things address it:

- **An exclusive lock.** `node_modules/.cache/meidoya-mutation/run.lock` is taken with
  `O_EXCL`. A second `pnpm mutation` fails immediately rather than interleaving mutants with
  the first — two runs would each restore the other's mutant as "the original" and corrupt
  the tree.
- **A crash journal, not a signal handler.** Every test run goes through `spawnSync`, which
  blocks the event loop: a `SIGTERM` arriving mid-run is queued until the child exits, and a
  `SIGKILL` never reaches JavaScript at all. A trap therefore cannot be the safety property,
  and relying on one is how a mutant survived a killed run here. Instead the original text of
  every target is journalled to disk before the first mutation, and the *next* run restores
  from it. To avoid eating someone's real work, a file is only rewritten when its current
  contents are exactly one of the mutants this generator would produce from the journalled
  original; anything else is reported and the run refuses to start.
- **A tree check on both ends of every mutant.** `withMutation` refuses to write if the file
  is not the text this run cached, and refuses to restore if the file was written while the
  mutant was applied.

In CI the isolation is real rather than assumed: the job has its own checkout, and the
workflow ends with `git diff --exit-code` as a belt-and-braces assertion that the tree came
back byte-identical.

A git worktree would be stronger still — the harness would own a private checkout outright —
and is the right next step if `pnpm mutation` is ever run routinely alongside other work.

## Adding a module

Append to `TARGETS` in `tools/mutation/targets.ts`:

```ts
{
  file: "packages/x/src/guard.ts",
  tests: ["packages/x/src/guard.test.ts"],
  why: "One line: what a surviving mutant here would let an attacker or a bug do.",
},
```

Then run `pnpm mutation --targets guard` and drive it to zero survivors before merging. Two
rules:

- Keep `tests` as tight as it can be while still being the honest evidence set. Every added
  filter costs runtime on every mutant of that module.
- Do not add a module whose evidence set needs a `TestWorkflowEnvironment`. See the
  exclusions above.

## Adding an allowlist entry

`tools/mutation/allowlist.ts` exempts mutants that are **equivalent**: the mutated program
has the same observable behaviour as the original, so no test can distinguish them and none
should be written.

**The standard of proof is an argument, not an assertion.** "This is hard to test" is a
missing test, not an equivalent mutant. "This is defensive" is a missing test. A reason must
name the invariant that makes the difference unobservable, in a form a reviewer can check
without re-deriving it. Real examples that meet the bar:

- *"An unfalsifiable bound: `MAX_INFLATED_BYTES` is larger than the largest payload the
  framing layer will admit, so the comparison cannot go the other way."* — names the
  upstream invariant.
- *"The `__proto__` guard fails closed either way: with the check removed the assignment
  lands on the prototype and the subsequent `ownProperty` read still misses."* — names the
  downstream check that makes both paths equal.
- *"Shadowed: the map is created with `Object.create(null)`, so `ownProperty` and `in` agree
  on every key."* — names the construction that collapses the two branches.

And a reason that does **not** meet the bar: *"equivalent"*, *"defensive check"*, *"can't
happen"*, *"covered elsewhere"* (if it is covered elsewhere, add that filter to `tests` and
the mutant dies).

Entries are keyed by `Mutant.id`, which encodes file, enclosing scope, mutator and the
mutated source text — and **deliberately no line number**, so an unrelated edit above a
guard cannot silently re-point an exemption at a different guard. Editing the guard itself
changes the id, which orphans the entry, which fails the build until the argument is
rewritten against the new code.

Three ways the gate rejects a stale exemption:

- **unexplained survivor** — a mutant survived and is in neither list. Build fails.
- **stale entry** — an allowlisted mutant is now killed. A test was written that makes the
  exemption wrong. Build fails; delete the entry.
- **orphaned entry** — the id no longer generates at all, so the guard was rewritten and
  nobody revisited the argument. Build fails; re-argue or delete.

`tools/mutation/mutants.test.ts` additionally holds every entry to a minimum-length reason
and to referring to a mutant the generator can still produce, so those failures also show
up in the fast `pnpm test` job.

## Known gaps (the ratchet)

`tools/mutation/known-gaps.ts` is **not** an allowlist. It holds the first real run's 27
confirmed survivors in `plan-capabilities.ts` that have not yet been fixed: guards that genuinely have no regression signal, in
gated modules, recorded as debt.

The distinction matters and must not blur:

- an **allowlist** entry claims *no test can kill this mutant*;
- a **known-gaps** entry admits *a test could kill this mutant, and nobody has written it*.

The gate fails on any survivor in neither list, so the debt can only shrink or be argued
into the allowlist. Deleting an entry is the unit of progress: pick one, write the test,
delete the line. Adding one requires the same review scrutiny as merging a known
vulnerability, because that is what it is.

## The mutators

| mutator | what it does | the defect it models |
| --- | --- | --- |
| `ConditionFalse` | forces an `if`/ternary/loop condition to `false` | the guard was deleted |
| `ConditionTrue` | forces it to `true` | the guard fires unconditionally (fail-open vs fail-closed) |
| `EqualityOperator` | `===`↔`!==`, `==`↔`!=` | the comparison was inverted |
| `ConditionalBoundary` | `<`↔`>=`, `<=`↔`>`, … | off-by-one on a bound |
| `LogicalOperator` | `&&`↔`\|\|` | a compound predicate lost a conjunct |
| `RemoveNegation` | `!x` → `x` | the sense of a check was flipped |
| `BooleanLiteral` | `true`↔`false` | a verdict was inverted |
| `RemoveGuardCall` | `x.strict()` → `x` | a zero-argument validator was dropped |

`ConditionTrue` is deliberately not generated for `while`/`do` conditions: it is a
guaranteed hang, not information. Mutations are produced from the TypeScript AST, never by
regex, so a replacement can never land inside a string, a comment or a type annotation —
`tools/mutation/mutants.test.ts` pins that.
