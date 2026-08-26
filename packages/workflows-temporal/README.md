# @meidoya/workflows-temporal

Temporal workflows and activities for the control plane: `TaskWorkflow`,
`RequestWorkflow`, `CrossWorkspaceWorkflow`, `EnvironmentWorkflow` and the
long-lived `WorkspaceMaidWorkflow` / `HeadMaidWorkflow`.

The pure state machine these workflows drive lives in `@meidoya/task-engine` and
deliberately imports nothing from Temporal. Everything in this document is about
the Temporal side; nothing here belongs in `task-engine`.

## Workflow versioning

### Why this package needs it at all

A Temporal workflow is replayed from its event history on every worker restart,
every failover and every wake-up from a wait. Replay re-runs the workflow
function from the top and checks that it issues **the same commands, in the same
order** as the history records: the same activities, timers, child workflows and
signals. Change the code so the command stream differs and the in-flight
execution fails to replay.

That is not a theoretical risk here:

- `TaskWorkflow` blocks **indefinitely** at a human gate. "Drain before
  deploying" can mean waiting on a person who never answers.
- `WorkspaceMaidWorkflow` and `HeadMaidWorkflow` are permanent; they only trim
  history by Continue-As-New at roughly 24h, so a run started before a deploy is
  routinely still open after it.

So a workflow change is deployed **additively**: the old command sequence stays
in the code, gated, until every execution that could still replay it has closed.

### What counts as replay-visible

Replay-visible (must be gated):

- adding, removing or reordering an activity call, timer, child workflow start
  or external signal;
- moving a call across an `await` that already existed, or introducing a new
  branch that changes which of the above run;
- anything that changes whether a gate is asked for, since a gate is a
  `createCheckpoint` activity plus a `recordTaskStatus` activity.

Not replay-visible (no gate needed):

- activity *arguments* and return handling — Temporal matches on activity type
  and order, not payload;
- the task queue an activity is dispatched to. Moving `runVerification` onto the
  execution node's queue is invisible to replay for the same reason: the
  `-pre-202608` fixtures were recorded while it still went to the control queue
  and they replay green. (It is very visible to the deploy, though — the node's
  workers must be registered for it before the control plane stops serving it.)
- pure computation, log lines, query/signal handler bodies that issue no
  commands, types and comments.

When in doubt, gate it. A superfluous patch costs one marker event.

### Determinism rules for anything under `src/workflows/`

No `Date.now()` substitutes, no `Math.random()`, no `crypto.randomUUID()`, no
`process.env`, no file, network or database access. Use Temporal's deterministic
equivalents: `Date.now()` (Temporal replaces the clock), `uuid4()`,
`sleep()`/`condition()`, and activities for everything that touches the outside
world.

### Patch id convention

```text
<area>-<change>-<yyyymm>
```

- `<area>` — the workflow the change lives in: `task`, `maid`, `head-maid`,
  `request`, `cross-workspace`, `environment`.
- `<change>` — lower-kebab, what moved (`budget-charge`, `step-gate-order`).
- `<yyyymm>` — the month the change was written, so that when several patches are
  in flight the drain order is obvious at a glance.

Every id is declared once, as an exported constant in [`src/patches.ts`](./src/patches.ts),
with a comment saying what the *old* path was. **Ids are never renamed or reused
after a deploy** — the literal is written into the history of every execution
that ran through it. `src/patches.test.ts` pins the exact strings so a rename
shows up as a deliberate diff.

Live ids:

| id | gates |
| --- | --- |
| `task-side-effect-gate-grant-202608` | evaluating the side-effect trigger on the grant a step is ACTUALLY issued (its request widened with the plan's external capabilities) instead of on each planned step's request in isolation |
| `task-side-effect-gate-union-202608` | evaluating that trigger on the grant an acting step of the PIPELINE receives (the plan-wide union plus `BASE_CAPABILITIES`) instead of on the PLAN's own steps — a plan that declares no acting step used to gate nothing while the coding pipeline's `implement` step took the whole grant |

### The old branch is the PREVIOUS RELEASE, not an older idea of it

This is the mistake that cost this package a whole generation of ids. Seven
`task-*-202608` ids were added whose legacy branches reconstructed the code of
the release *before* the one actually deployed. Every in-flight history had been
produced by the deployed release, so it carried no marker for those ids;
`patched()` therefore answered `false` and steered those executions into a branch
that had never produced their command stream. The result is not a caught error —
it is `[TMPRL1100] Nondeterminism error`, a workflow task that Temporal retries
forever, a task that never advances and never completes while holding its budget
and its open checkpoint, and no API call that can unstick it.

Before adding an id, diff against the release the running workers were built
from and gate only what actually differs:

```sh
git show <previous-release>:packages/workflows-temporal/src/workflows/task.ts \
  | diff -u - packages/workflows-temporal/src/workflows/task.ts
```

If the diff is empty for a block, it does not need an id. The seven ids above
were removed rather than "fixed", and are listed in `src/patches.test.ts` as
retired so they can never be revived — reusing an id is only safe because no
execution ever ran through it.

### A mechanism that was removed: the review answer's scope

`reviewGateSatisfied` is set by a human answering a `review-approval` gate and
read again at the completion check. A scoping mechanism existed to discard that
answer once another step had started (`src/review-gate-scope.ts`), on the
grounds that an approval given at step 2 must not answer the completion question
about work steps 3..n changed since.

It was deleted, because on these pipelines it could not fire: the pre-step gate
is skipped for a `review-approval` gate on a `review` step, every other shipped
`review-approval` gate sits on a TERMINAL step, and the gate the Manager's
`gate` decision raises inside a review step either approves straight into
completion or halts. So the answer was always the last thing before completion,
the reset never ran, and deleting the whole block left the suite green — an
enforcement point with no regression signal, which is the failure mode this
package has now hit six times.

What replaced it is the property itself, as a falsifiable test:
`src/pipelines-guard.ts` + `src/pipelines-guard.test.ts` fail the day a pipeline
declares a `review-approval` gate on a non-terminal step. At that moment the
scoping has to come back — and it needs a patch id, because the completion gate
would start asking where it used to stay silent. The same file pins the other
pipeline property `TaskWorkflow` leans on: `coding` is the only pipeline with a
`verify` step, which is what makes the workflow's refusal to run a verification
with zero commands a floor rather than a live path.

### Where the decision is taken

`TaskWorkflow` evaluates **all** of its `patched()` calls once, in a `version`
object at the top of the function, before it issues any command.

This is deliberate. `patched(id)` answers `false` only while replaying history
recorded before the patch existed; once replay catches up to the present it
answers `true`. A decision taken deep in the workflow would therefore come out
`true` for an execution whose earlier, correlated decision came out `false` — and
for the gate patches that means asking a human the same question twice. Deciding
everything at the top means one execution follows one path end to end.

Keep it that way: add new task patches to the `version` object, not to the block
they gate.

**What it costs.** Because the calls are unconditional, every execution records
one `MarkerRecorded` **and** one `UpsertWorkflowSearchAttributes` per live id —
even a quick-lane task that reaches none of the patched code. Each upsert
rewrites the `TemporalChangeVersion` search attribute with the full list of
patch ids taken so far, so the attribute grows with the number of live ids and
the history grows with roughly `2 x <live ids>` events per execution.

Two consequences to respect:

- **Keep the live-id count small.** Temporal's default per-attribute size limit
  is 2 KiB, and `TemporalChangeVersion` is a keyword list whose entries are the
  full `<area>-<change>-<yyyymm>` strings (~30 bytes each). Well over a hundred
  live ids would be needed to reach it, but the events are paid on every
  execution long before that, so treat ~10 live ids as the working ceiling and
  drain rather than accumulate.
- **Deprecation must remove the eager evaluation too.** Step 5 of the lifecycle
  deletes the field from the `version` object, not merely the `deprecatePatch()`
  call; leaving the field behind keeps paying both events for an id nobody
  branches on.

### Lifecycle

1. **Add.** Wrap the change: `if (version.thing) { /* new */ } else { /* the
   PREVIOUS RELEASE's code, verbatim */ }`. Declare the id in `src/patches.ts`
   and add it to `TASK_WORKFLOW_PATCH_IDS`. Do not "fix" anything in the old
   branch — it is not the behaviour you want, it is the behaviour those
   executions already committed to. Then record a pre-patch fixture from the
   previous release's source (recipe at the bottom of `replay.test.ts`) and add
   a pre-patch unit test for anything the branch PASSES to an activity: replay
   sees the command sequence, never the arguments.
2. **Deploy.** Both branches are now live. New executions take the new path; open
   ones keep replaying the old one.
3. **Drain.** Wait until no execution started before the deploy is still open
   (see below).
4. **Deprecate.** Replace `patched(ID)` with `deprecatePatch(ID)`, delete the old
   branch, move the id to `DEPRECATED_PATCH_IDS`, deploy again. This keeps
   accepting histories that contain the marker while writing none.
5. **Remove.** After a second drain, delete the `deprecatePatch(ID)` call, the
   field it fills in the `version` object (see the cost note above), and the
   constant, and re-record the replay fixtures.

Skipping step 4 and deleting the `patched()` call directly is only safe if the
drain in step 3 was complete *and* no history containing the marker will ever be
replayed again — including the fixtures in this package.

## Activity timeouts, heartbeats and refusals

`src/retry-policies.ts` holds one option set per activity class. Two rules there
are load-bearing enough to state here.

**A `heartbeatTimeout` is a promise.** Temporal enforces it: an activity that
declares one and does not call `Context.current().heartbeat()` within it is
killed and retried until its attempts run out, and then the workflow fails. All
three long-running classes once declared one while nothing in the repository
beat, which made every agent run over two minutes and every quality gate over
two minutes impossible to pass. Today the Manager classes beat from
`src/heartbeat.ts` (`withHeartbeat`, every 15s) and the Worker/verification
classes beat from the execution node's runner (every 20s); every declared
timeout is at least three beats wide. `src/retry-policies.test.ts` pins which
sets may declare one at all.

**A refusal is matched by TYPE, which for a plain `Error` subclass is its
`name`.** Keeping that list by hand failed three times in a row — it listed
`ScopeViolation` while the thrown name was `ScopeViolationError`, it carried no
spelling of `SandboxViolationError` at all, and `DB_ACTIVITY_OPTIONS` (which
proxies `db.chargeBudget`, the activity that raises `PolicyViolation` for a
corrupt budget row) declared no `nonRetryableErrorTypes` whatsoever. So the list
is no longer written by hand: `src/refusals.ts` classifies EVERY `Error`
subclass in the repository as a refusal or as retryable, the list is derived
from it, every option set declares it, and `src/refusals.test.ts` walks the
source tree and fails when a class exists that nothing has classified. Adding an
error type anywhere is a red test until someone decides how Temporal should
treat it.

**A heartbeat proves the worker is alive, not the work.** The beat is a timer
that runs for as long as the activity is unsettled (`src/heartbeat.ts`), so a
wedged activity beats exactly like a healthy one and a hang is bounded by
`startToCloseTimeout` alone. Turning it into stall detection needs the agent
runtime's own progress events (10 section 8: the run's phase and session id) fed
into the beat; until that exists, do not describe heartbeating as hang
detection.

**A step kind the workflow does not implement stops the task.** `runStep`
dispatches by explicit kind; there is no `default:` that sends an unknown kind
to a Worker, because there was, and the whole `cross-workspace` body —
`delegate`, `await-children`, `aggregate`, all declared `control`/`manager` —
went out to an execution node as `implementer` Worker runs. `TaskWorkflow` also
refuses such a pipeline at the top (`stepsTaskWorkflowCannotRun`), and
`src/pipelines-guard.test.ts` pins both the refused set and that every step's
`executor` matches who really runs it. **One-off deploy note:** that refusal
changes the command stream for a `cross-workspace` TaskWorkflow execution, and
is deliberately NOT behind a patch id — the old branch is the wrong-role
dispatch itself, so preserving it would preserve the defect. Before rolling out,
terminate any running TaskWorkflow whose pipeline is `cross-workspace` (the
normal ingress route cannot produce one; only an operator-set `defaultPipeline`
or pipeline hint can).

`CrossWorkspaceWorkflow` is the sole driver for those three coordination step
kinds. It asks the production delegation port to validate `task.delegate` and
`task-summary.read`, create a target-local Task row, and submit a stable mailbox
entry to that target's `WorkspaceMaidWorkflow`. The Maid starts
`RequestWorkflow`, assesses the delegated request against its own project catalog,
and starts the target-local `TaskWorkflow`. Child activities charge the
coordination task's root budget; only the child status and final Worker summary
are signalled back. The integration test
`src/workflows/cross-workspace.test.ts` runs two resident Maids and two child
Tasks, asserts that no Worker activity receives the coordination task id, and
completes one aggregate on the originating conversation.

**Phase 7 deploy note:** the old production delegation port always threw, so no
production `CrossWorkspaceWorkflow` could pass `delegate`. This release changes
its command stream without a patch id. Before rollout, terminate any manually
started `CrossWorkspaceWorkflow` execution; there should be none capable of
useful progress on the previous release.

**A failed activity stops the task.** `runTaskWorkflow` catches anything thrown
by a step and pauses into `needs_attention` with the failure's message, instead
of letting it fail the workflow execution. A failed workflow was re-dispatched
by the daemon, which turned one non-retryable refusal into the same error logged
forever with no human ever asked. Cancellation is re-raised rather than caught.

## Operator deploy procedure

Deploying a change to anything under `src/workflows/`:

1. **Before merging** — `pnpm -r build && pnpm test`. The replay suite
   (`src/workflows/replay.test.ts`) must be green against the committed
   histories. If it is red, the change is replay-visible and needs a patch id;
   re-recording the fixtures instead of gating the change is the failure mode
   this suite exists to catch.
2. **Snapshot the fleet before rollout.** Record the moment you deploy; every
   execution started before it is a candidate for the old path.

   ```sh
   temporal workflow count --query 'ExecutionStatus="Running"'
   ```

3. **Roll out the workers — nodes FIRST.** The patch gate is inside the
   workflow, not in the worker version, so *replay* is order-independent. Task
   *queue ownership* is not: see
   [Verification is a node activity](#verification-is-a-node-activity-deploy-ordering)
   below. Upgrade every execution node before the control plane.
4. **Watch for non-determinism.** A workflow task that fails to replay is
   retried, not failed, so it shows up as a stuck execution rather than an error:

   ```sh
   temporal workflow list --query 'ExecutionStatus="Running"' \
     --fields WorkflowId,StartTime,ExecutionTime
   ```

   and in the worker logs as `[TMPRL1100] Nondeterminism error`. Any occurrence
   means a replay-visible change went out ungated: roll back the workers, which
   restores the old command sequence and lets the stuck tasks continue.
5. **Confirm the drain before deprecating.** A patch may be retired only when no
   execution that predates its deploy is still open:

   ```sh
   # anything still running that started before the deploy
   temporal workflow list \
     --query 'ExecutionStatus="Running" AND StartTime < "2026-08-18T00:00:00Z"'
   ```

   Two long tails dominate that list:

   - **`meidoya/task/*` parked on a human gate.** Query the task snapshot to see
     what it is waiting for — a `pendingCheckpointId` means a human, not the
     system, is the blocker. Chase the answer, or cancel the task
     (`cancelTask` signal); do not deprecate the patch around it.
   - **`meidoya/maid/*` and `meidoya/head-maid/*`.** These never finish. They
     rotate by Continue-As-New at ~24h, on a policy-revision bump, or when
     Temporal suggests it — and each rotation starts a fresh run whose history
     contains no pre-deploy events. Bumping the workspace policy revision forces
     the rotation immediately; otherwise waiting a full day is enough. Check
     with `temporal workflow describe --workflow-id meidoya/maid/<env>/<ws>` and
     compare the run's start time against the deploy.

   Only once both are clear does step 4 of the lifecycle become safe.

### Verification is a node activity (deploy ordering)

`runTaskWorkflow` dispatches `runVerification` to
`nodeTaskQueue(input.executionNodeId)` — the same queue as every Worker step —
and **never** to `meidoya/control`. Quality gates spawn processes, so they
belong inside the execution node's `FilesystemSandbox`, narrowed to the project
under test (design 10 §§1-3). The control plane deliberately has no local
executor at all: `createVerificationCommands()` in `apps/meidoyad` throws a
non-retryable `PolicyViolation` for any verification that reaches it, and there
is no flag to turn that into a local run. A `--local-verification-root` opt-in
existed briefly and was removed — once the dispatch moved to the node queue, no
configuration of the control plane could ever reach that code.

Two consequences for a rollout:

- **Upgrade node workers before the control plane.** A node running an older
  build may not register `runVerification` on its queue. Once the new workflow
  code is live, every verify step is scheduled there and there alone, so a node
  that does not serve it leaves the activity with no poller. Confirm each node
  is serving before the control-plane worker restarts:

  ```sh
  temporal task-queue describe --task-queue meidoya/node/<node-id> \
    --task-queue-type activity
  ```

  It must list a poller per node. There is **no fallback**: the control plane
  will not pick these up, by design.
- **A verify step with no node is parked, not lost.** Temporal holds the
  activity task until a poller appears; when the node comes back it runs, and
  the task continues from where it stopped. Nothing needs to be replayed or
  re-signalled. This is the correct behaviour — the alternative was running an
  operator's `npm test` unsandboxed next to the daemon's SQLite database and
  client credentials — but it is silent from Temporal's side, so:

  ```sh
  # activity tasks waiting with nobody polling
  temporal task-queue describe --task-queue meidoya/node/<node-id> \
    --task-queue-type activity   # empty poller list == parked
  ```

  and, for the operator-facing view, STATUS.md prints a
  `PARKED — waiting for an execution node` banner above a workspace's active
  tasks whenever no node bound to that workspace is `online`, naming each bound
  node and its status. That banner is what distinguishes "queued until a node
  returns" from "stuck": a parked task needs a node started, not a human answer,
  and it never appears under *Waiting on a human*.

## Tests

| file | what it holds |
| --- | --- |
| `src/workflows/task.test.ts` | the behaviour of the current path — budget enforcement, gate policy, capability grants — and, in its last describe block, the LEGACY path driven directly |
| `src/workflows/pre-patch-workflows.ts` | test-only workflow entry: `TaskWorkflow` with every `patched()` answer forced to `false`. Not exported from `index.ts`; no production worker registers it |
| `src/workflows/replay.test.ts` | recorded histories replayed against the current code: the regression signal for versioning |
| `src/patches.test.ts` | patch ids exist, are gating something, are spelled as deployed, and none is a revived retired id |
| `src/pipelines-guard.test.ts` | the pipeline properties `TaskWorkflow` relies on: `review-approval` gates only on terminal steps, `verify` steps only where plans must carry commands, no step of a kind the workflow does not implement, and `executor` agreeing with who really runs the step |
| `src/refusals.test.ts` | every `Error` subclass in the repository is classified, and every option set refuses to retry the refusals |
| `src/heartbeat.test.ts` | that the activities declaring a `heartbeatTimeout` actually beat — Temporal kills the ones that do not |
| `src/retry-policies.test.ts` | which option sets may declare a `heartbeatTimeout` at all |
| `src/verification-scope.test.ts` | which project verification runs in, and the refusal to treat an empty command list as a pass |

`replay.test.ts` carries two kinds of fixture:

- **current-path fixtures** (`task-*.json`, `maid-*.json`) — recorded from the
  code as it stands. They fail the moment a replay-visible change ships without
  a patch id, and they fail if a `patched()` call is deleted, because the marker
  sequence they recorded no longer matches.
- **pre-patch fixtures** — recorded from the source of the release that was
  deployed BEFORE the patch they precede, never from today's. They are the
  executions that were in flight when the deploy went out, and they are what
  proves the *old* branches still replay. Delete or misremember an old branch
  and only these go red. There are two generations:

  - `*-pre-202608.json` — commit `2dedb76`, before
    `task-side-effect-gate-grant-202608`. They contain no patch markers at all.
  - `*-pre-union.json` — commit `d492edd`, before
    `task-side-effect-gate-union-202608`. They carry the `-grant-` marker and
    not the `-union-` one, so replaying them runs
    `derivePlanSideEffectCapabilitiesPerStepGrant`, the trigger that read the
    PLAN's steps. `task-no-actor-plan-side-effect-gate-pre-union.json` is the
    one that matters: on that release the plan with no acting step asked for no
    side-effect gate, and today's code must not invent one for it.

  They are never recorded from today's source with the `version` flags hard-coded
  to `false`: that records the legacy branch as *written* rather than as
  *deployed*, so the fixture validates the invention instead of the history. That
  is precisely how seven ids whose old branches reconstructed the wrong
  generation replayed green.

Replay checks the sequence of activity **invocations** and nothing about their
**arguments**, so it cannot see a legacy branch handing out a capability nobody
approved or satisfying a gate nobody answered. That half is covered by driving
`TaskWorkflowPrePatch` directly in `task.test.ts`; anything a legacy branch
passes to an activity needs an assertion there.

### Re-recording the replay fixtures

`src/workflows/__fixtures__/histories/*.json` are real histories captured from
the time-skipping test server. Regenerate them only when adding a scenario or
after a legitimate `deprecatePatch()` drain:

```sh
MEIDOYA_RECORD_HISTORIES=1 pnpm vitest run \
  packages/workflows-temporal/src/workflows/replay.test.ts
```

Adding one scenario should touch one file, so name it and leave the rest alone:

```sh
MEIDOYA_RECORD_HISTORIES=1 MEIDOYA_RECORD_ONLY=<scenario> pnpm vitest run \
  packages/workflows-temporal/src/workflows/replay.test.ts
```

Re-recording to make a red replay test green is never the right fix. It deletes
the only evidence that in-flight executions would have broken.

A pre-patch fixture is recorded once and never again. The procedure — restore the
previous release's `src/workflows/task.ts` into the tree, record with
`MEIDOYA_RECORD_SUFFIX`, put the current source back — is written out at the
bottom of `replay.test.ts`, together with what must never be done instead.
