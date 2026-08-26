# Handoff — remaining work

Updated 2026-08-24. Companion repository: `meidoya-yashiki` (see §6).

This is a status and continuation note for whoever picks the work up next. It is
deliberately blunt about what is *not* done and about which claims in this
codebase have been verified against reality versus only against fakes.

---

## 1. Where things stand

| | `meidoya` | `meidoya-yashiki` |
|---|---|---|
| HEAD | `9282e89` on `main`, plus the Phase 7 worktree changes described below | `24830e6` on `main` |
| Tests | 1406 pass / 2 skipped, 107 files (`exit 0`) | 505 pass, 26 files |
| build · typecheck · lint | clean | clean |
| Offline demo | `exit 0` | — |
| Mutation gate | `pnpm mutation` → exit 0, 244/278 killed, 0 unexplained survivors | not present |
| Suite stability | 16 consecutive clean runs incl. under 24- and 48-way CPU load, 0 orphaned processes | — |

The companion repository is clean and pushed. This repository's Phase 7 changes
are intentionally left in the current worktree for review; they are not committed
or pushed by this handoff update.

**Phases 0–7 of the design roadmap are now implemented.** The local production
path is accepted; Phase 8 remains partial for ecosystem integrations and release
automation.

---

## 2. Phase 7 is functional

The coordination ingress is a workspace with `kind: coordination` and a CLI
binding (the shipped example uses profile `global`). `task.create` accepts
`targetWorkspaceIds` only for a Head Maid scope and routes it to the long-lived
`HeadMaidWorkflow`; the CLI exposes this as repeated `--target` flags.

The runtime path is now:

```text
HeadMaidWorkflow → CrossWorkspaceWorkflow
  → production DelegationRegistry check
  → target WorkspaceMaidWorkflow mailbox update
  → RequestWorkflow → target-local TaskWorkflow
  → child completion signal
  → aggregate ExecutionPlan.summary
  → one TaskCompleted event on the originating conversation
```

Evidence for the roadmap Definition of Done:

- **Ungranteds are invisible.** Config capabilities are schema-validated,
  grants are projected to `delegation_grants`, the API and production activity
  both call `DelegationRegistry`, and the test fixture contains a real
  `work-secret` workspace with no grant. It gets the same `not_found` outcome as
  a nonexistent workspace and is absent from Head Maid global status.
- **Head Maid cannot start a Worker.** `TaskWorkflow` still refuses the
  coordination pipeline. `CrossWorkspaceWorkflow` delegates only through each
  target Maid. The Temporal integration test records every Worker call and
  proves the coordination task id is never one of them.
- **Two results become one thread result.** The same integration test runs two
  resident Maids and two child Tasks, waits for both callbacks, passes both
  summaries to the aggregate Manager call, and completes once with the original
  `conversationId`.

The implementation also handles plan/review checkpoints, durable task status and
step projection, duplicate mailbox delivery after a stable child workflow has
completed, and Head Maid active-set cleanup across Continue-As-New. Delegations
now pass through the target Workspace Maid so it selects target-local project ids;
those ids are checked against control-plane configuration. Child agent runs charge
the coordination task's root budget, and the final Worker summaries — not the
original request text — are what the aggregate Manager receives.

---

## 3. Real-integration boundary

Codex and Claude are no longer entirely fake-verified. Direct scratch runs against
the installed vendor binaries exercised new sessions, resume sessions, stdin prompt
delivery, streamed result parsing and structured output. A Claude probe also proved
that its fail-closed sandbox blocks an out-of-workspace write. Those probes exposed
and fixed the Codex `exec resume` argument ordering and removed prompts from both
vendors' process arguments. Coordinating subprocesses now have a finite production
timeout (14 minutes by default, configurable with
`MEIDOYA_CONTROL_AGENT_TIMEOUT_MS`).

The shipped daemon now constructs both runtime adapters when `models:` is present,
and `model_policy:` drives coordinating roles plus Worker/reviewer defaults and
allowlists. Planning and execution prompts carry the full task brief and approved
plan. Review now runs on the execution node with `repo.read`, rather than on the
control host without a checkout.

The complete local production path is now proven. On 2026-08-24 a generated
configuration started `meidoyad` and `meidoya-node` against Temporal Server
1.29.0, passed every `meidoya doctor` check, and completed a real Codex `quick`
task. Temporal history records the Worker activity on
`meidoya/node/acceptance-node`; SQLite records `TaskCompleted`; the target Git
worktree remained clean. See `docs/acceptance.md` for the evidence.

That run exposed and fixed three gaps the fake stack could not reveal: the local
launcher omitted the per-node registration token, coordinating Codex runs failed
outside Git, and RequestWorkflow defaulted Worker dispatch to `mac-main` rather
than the configured node.

The remaining real-dependency caveats are:

- **Slack or Discord.** `packages/chat-vercel` implements both transports over an
  injectable client; no real token has ever been used, and the Socket Mode /
  gateway handshakes are unexercised.
- **A Lima VM.** `meidoya-yashiki`'s provider was verified against `limactl --help`
  and documented yq syntax only. In particular the `--set=.mounts = [...]` form
  is reasoned, not observed.
- **The demo** (`apps/meidoyad/src/demo/local-demo.ts`) exits 0 with a fake agent
  runtime, a fake chat transport and a time-skipping server. It proves the wiring,
  not the integrations.

**Suggested order**, cheapest and most informative first:

1. Run the same accepted path with Claude.
2. Provision one Lima node end to end with `meidoya-yashiki`.
3. Slack last — it needs an app, tokens and a workspace.

---

## 4. Open items deliberately not fixed

Carried from the ninth review and the waves that followed. None is believed
critical; all are recorded so they are not rediscovered as if new.

- **Gate residual (stated at the right altitude).** A quality gate on
  `mac-restricted` can still **read any ordinary file on the node** — other
  checkouts, their sources, their `.env`-shaped files. Closing that needs a
  per-node toolchain inventory (a read allowlist), because denying by segment
  breaks mise-managed interpreters; the measurement behind that decision is in
  `packages/execution-native/src/sensitive.ts`. What a gate can no longer reach:
  the operator's credential stores, the daemon's bearer credentials and control
  socket, the operator's login name and home layout, writes outside the checkout,
  and any network address the operator did not name.
- **`.local` is deliberately not a denied segment.** See the same file for why.
- **Checksum amnesty residual.** An operator who deletes the version-8 ledger row
  *and* the meta table can still reset the migration watermark for versions ≤ 7,
  which causes 0008 to re-run. Documented in `packages/store-sqlite/src/migrate.ts`.
- **At-least-once chat delivery.** `ChatTransport` takes no idempotency token and
  the delivery receipt is written after the post returns, so a process killed in
  that window re-posts on restart. Comments now say this rather than implying
  exactly-once.
- **`temporal-test-env` reaping is macOS/Linux-with-`/bin/ps` only**, and is
  skipped when `TMPDIR` contains a space. Losing hygiene was chosen over widening
  a kill predicate.
- **`meidoya admin latch` has no `restore`-side counterpart in yashiki** (§6).

---

## 5. The mutation gate — how to widen it

`pnpm mutation` (`tools/mutation/`, documented in `docs/mutation-testing.md`)
runs on every PR and fails on any survivor that is not fixed or argued for in
writing. It currently gates five modules and **found two real defects on its
first run that nine review rounds had missed**: the scope-token verifier read
only the first two segments, so `${validToken}.junk` verified; and the completion
check's terminal-step predicate could be weakened so a task whose implement step
had *failed* completed.

Nine more modules are **measured and commented out** in `tools/mutation/targets.ts`
with first-run survivor counts (`api.ts` 118/155, `scope.ts` 68/125,
`verification.ts` 51/162, …). **Those are not confirmed gaps.** The daemon numbers
are inflated because the gate excludes the Temporal-backed suites, where the
daemon's real behaviour is actually asserted. Widening means, per module: settle
the honest evidence set, re-measure, then split survivors into fixes, allowlist
entries (each with a written argument) and `known-gaps.ts` entries.

Two structural limits worth knowing:

- **The gate cannot mutate strings.** The SBPL sandbox profile in
  `packages/execution-native/src/gate-confinement.ts` is entirely string literals,
  so the module the OS-boundary theory rests on is outside the gate by
  construction. It is covered instead by tests that spawn a real child through the
  real generated profile and assert reachability as errno.
- **The Temporal-suite exclusion's *flakiness* justification is now obsolete** (the
  suite is reliable). Only the *cost* justification remains (~47s vs ~1.4s per
  mutant). Re-measuring is a real decision, not a freebie.

---

## 6. `meidoya-yashiki`

Only **one** adversarial review, versus nine here, and it found nineteen confirmed
defects — all fixed (`04f28f5`, 505 tests). Expect more; this repository has had
far less scrutiny.

Specifically not done there:

- **No mutation gate.** Porting `tools/mutation/` is the single highest-value
  addition.
- **No `restore` command.** `recover()` has no production caller. The
  backup/recovery keying mismatch and the encryption gap are fixed and a round
  trip is proven in tests, but wiring a CLI command means deciding what "restore"
  does to a live node — product design, not a defect fix.
- **`applyResourceConfig` is a provisioner option wired at the composition root**
  rather than a method on the `NodeProvider` interface, because
  `packages/yashiki-core/src/provider.ts` was outside that agent's scope. Worth
  revisiting.

---

## 7. Process notes — read before continuing

These cost real time to learn. They are not optional advice.

**A passing test is not evidence.** Across nine rounds this codebase produced
**eight-plus instances of enforcement with no regression signal** — correct,
load-bearing security checks that could be deleted with the entire suite still
green — and **twenty-two tests that asserted the bug they should have caught**
(a leak test that only inspected one event, a token test that minted with no
credential, a fixture carrying the unsafe shape, an opener stubbed so the real
path never ran, two whose `String.replace` had silently stopped matching). The
only technique that reliably worked: **delete the enforcement, confirm the suite
goes red naming a specific test, restore.** Require that for every fix.

**Ask whether the thing asserted is the thing the runtime consumes.** The worst
single defect found — a refusal registry whose declaration tests were all green
while listing strings Temporal never reads (the SDK derives the failure type from
the constructor name, not `name`) — survived until someone ran a real activity
against a real server and counted attempts. The same shape recurred repeatedly:
`mount.target` validated and never passed to `limactl`; `profile` enum-checked and
never branched on; a mode bounded then re-rendered in a different base.

**Watch for inert fields.** Three separate defects were created by a field that
was declared, plumbed, and not read — until something started reading it
(`parentTaskId` became a cross-tenant budget hijack the moment `rootTaskIdOf`
walked it). If you find one, either wire it fully or delete it; do not land two
thirds of it.

**Run agents in isolated worktrees.** A mutation harness by definition rewrites
shared source; running one alongside other agents contaminated four separate
verification runs before this was noticed. Also: `git worktree` inherits the
shell's working directory, so a review was once handed a worktree of the *wrong
repository* and spent its whole budget there. **Verify `pwd` and `ls apps/` before
trusting an agent's location.**

**Environment gotchas.**
- Node is pinned to 22.20.0 via `.mise.toml`; run tooling as `mise x -- …`.
  `better-sqlite3` needs a matching ABI, so a stale `node_modules` from another
  Node version fails confusingly.
- Interrupting a vitest run used to orphan a Temporal test server that kept
  listening and degraded later runs. That is now reclaimed automatically, but if
  something looks flaky, check `pgrep -f temporal-test-server`.
- `vitest.config.ts` aliases workspace packages to `src`. Before that existed, the
  suite validated stale `dist` and cross-package mutations reported false passes.
  Both repositories now have it; do not remove it.
- Do not write raw NUL bytes into source. Three files once contained them, which
  made git treat them as binary and hide their diffs entirely — that is how a
  security defect stayed invisible through a whole review cycle.
  `tools/no-nul-bytes.test.ts` guards it.

**Deployment prerequisite.** `packages/workflows-temporal` uses patch ids
(`patches.ts`, procedure in that package's README). Step ordering has changed
several times. A workflow in flight across a deploy replays through the patch
gates, but **nodes must be registered for both `runVerification` and `runReview`
before the control plane restarts**, and any new command-stream change needs a patch id plus a
pre-patch fixture recorded from the *previous release's source* — never by
forcing `patched()` false, which produces a fixture that validates the invented
branch against itself.

---

## 8. Suggested next steps, in order

1. **Full real task through Temporal and an execution node** — direct Codex/Claude
   runs are verified, but the complete production path is not (§3).
2. **Port the mutation gate to `meidoya-yashiki`** (§6).
3. **Widen the gate in `meidoya`**, one module at a time, from the measured data
   already in `targets.ts` (§5).
4. **Real Lima provisioning**, then Slack.

A tenth adversarial review of `meidoya` is *not* top of this list. Returns have
been diminishing and the structural controls now in place — the mutation gate, the
two-workspace negative fixture, executed-behaviour tests for the sandbox profile —
catch more per unit of effort than another read-through. A second review of
`meidoya-yashiki`, which has had only one, is better value.
