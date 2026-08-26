/**
 * Replay guard.
 *
 * `__fixtures__/histories/*.json` are real Temporal histories, recorded from
 * this workflow code by running the scenarios below against the time-skipping
 * test server. This suite replays every one of them against the CURRENT source.
 *
 * That is the regression signal for workflow versioning: any change to the
 * commands `TaskWorkflow` (or the Maid) issues — an activity added or removed,
 * two activities swapped, a gate moved — makes the recorded command sequence
 * stop matching and this suite goes red. The fix is never to re-record; it is
 * to wrap the change in `patched()` (see `../patches.ts` and the README), which
 * keeps the recorded path intact because the fixtures contain no marker for the
 * new patch id and `patched()` therefore answers `false` while replaying them.
 *
 * Re-record ONLY when adding a new scenario, or after a `deprecatePatch()` drain
 * has legitimately retired an old path:
 *
 *   MEIDOYA_RECORD_HISTORIES=1 pnpm vitest run packages/workflows-temporal/src/workflows/replay.test.ts
 *
 * Recording needs the time-skipping test server (already used by the other
 * suites here); replaying needs nothing but the files, so the guard itself is
 * offline and fast.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startTimeSkippingEnv } from "@meidoya/temporal-test-env";
import * as proto from "@temporalio/proto";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import type {
  ExecutionPlan,
  HumanCheckpointKind,
  ManagerDecision,
  WorkspacePolicy,
} from "@meidoya/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Activities, ChargeBudgetInput } from "../activities.js";
import { CONTROL_TASK_QUEUE, nodeTaskQueue } from "../task-queues.js";
import { maidWorkflowId, taskWorkflowId } from "../workflow-ids.js";
import {
  TaskWorkflow,
  taskAnswerCheckpointSignal,
  taskSnapshotQuery,
  type TaskSnapshot,
  type TaskWorkflowInput,
} from "./task.js";
import {
  WorkspaceMaidWorkflow,
  maidRefreshPolicySignal,
  submitMessageUpdate,
} from "./workspace-maid.js";

const RECORDING = process.env["MEIDOYA_RECORD_HISTORIES"] === "1";

const HistoryProto = proto.temporal.api.history.v1.History;

/**
 * Fixtures are stored as protobuf-JSON: long ids as decimal strings, byte
 * payloads as base64, enums by name. `@temporalio/common`'s `historyToJSON`
 * cannot be used — with proto3-json-serializer 2.0.2 it throws on the `bytes`
 * values inside `Payload.metadata` maps — and a protobufjs round-trip is
 * self-consistent, diffable and free of raw control bytes.
 */
function historyToText(history: unknown): string {
  const message = HistoryProto.fromObject(history as Record<string, unknown>);
  const plain = HistoryProto.toObject(message, {
    longs: String,
    bytes: String,
    enums: String,
    defaults: false,
    arrays: false,
    objects: false,
    oneofs: false,
  });
  return `${JSON.stringify(plain, null, 2)}\n`;
}

function historyFromText(text: string): unknown {
  return HistoryProto.fromObject(JSON.parse(text) as Record<string, unknown>);
}

const historiesDir = fileURLToPath(new URL("./__fixtures__/histories/", import.meta.url));
const workflowsPath = fileURLToPath(new URL("./index.ts", import.meta.url));

/**
 * Fixture name -> what it is there to pin down.
 *
 * The pre-patch fixtures are the important ones: they are missing the marker of
 * the patch they precede, so `patched()` answers `false` for it throughout their
 * replay and the legacy branch runs. Each generation is recorded from the source
 * of the release that was actually deployed then — `-pre-202608` from commit
 * 2dedb76 (no markers at all), `-pre-union` from d492edd (the `-grant-` marker
 * and not the `-union-` one) — never from this source with the `version` flags
 * forced off, which would only ever validate itself. They must NEVER be
 * re-recorded — see "recording a pre-patch fixture" at the bottom.
 */
const SCENARIOS: Record<string, string> = {
  "task-no-gates-complete": "the ordinary path: charge, plan, work, verify, review, complete",
  "task-plan-gate-approved": "the plan gate, asked after the plan exists and approved",
  "task-side-effect-gate-approved": "the capability-derived side-effect gate, approved",
  "task-review-gate-approved": "the completion review gate, asked and approved",
  "task-budget-limit-extension": "a refused charge, the limit gate, and the one extension",
  "task-two-step-plan-side-effect-gate":
    "an ordinary researcher+implementer plan: the implement step would be handed the plan's" +
    " network egress, so the side-effect gate fires (task-side-effect-gate-grant-202608)",
  "task-no-actor-plan-side-effect-gate":
    "a plan that declares NO acting step, on the coding pipeline whose implement step acts" +
    " anyway: the grant an acting step receives gates (task-side-effect-gate-union-202608)",
  "task-research-readonly-side-effect-gate":
    "a read-only research task on the RESEARCH pipeline: both its Worker steps are researchers" +
    " and receive repo.read + network with nothing to act with, so no side-effect gate is asked" +
    " (task-side-effect-gate-pipeline-202608)",
  "task-research-readonly-side-effect-gate-pre-pipeline":
    "the same task on the previous release (4e663ee): the trigger read the plan-wide grant" +
    " WHOLE, BASE_CAPABILITIES included, so it asked for a side-effect approval — and the" +
    " current code must keep asking it for the executions parked on it",
  "task-no-actor-plan-side-effect-gate-pre-union":
    "the same plan on the release before that patch (d492edd): the per-planned-step trigger" +
    " asked for NO gate, and the current code must not invent one for it",
  "task-review-before-complete":
    "review: before-complete — the review step's gate, answered during the terminal step, is" +
    " the completion answer, so the completion check asks nothing further",
  "maid-continue-as-new": "the Maid dispatching a request and rotating on a policy revision",
  "task-no-gates-complete-pre-202608": "an in-flight task from before the 202608 patches",
  "task-plan-gate-approved-pre-202608":
    "an in-flight task parked on the plan gate, answered after the deploy",
  "task-two-step-plan-side-effect-gate-pre-202608":
    "the same ordinary plan before the patch: the isolated trigger asked for NO side-effect" +
    " gate, and the current code must not invent one for it",
  "task-review-before-complete-pre-202608":
    "the same path on the previous release: scoping the review answer to its step changed" +
    " no command here, and this fixture is what proves it",
};

/** Set when recording a variant of the scenarios, e.g. `-pre-202608`. */
const RECORD_SUFFIX = process.env["MEIDOYA_RECORD_SUFFIX"] ?? "";

/**
 * True while recording the pre-patch variant — i.e. while `src/workflows/` holds
 * the PREVIOUS RELEASE's source. Some scenarios legitimately walk a different
 * path there (a gate the old code never asked for cannot be answered), so the
 * recorder has to be told which side it is on.
 */
const PRE_PATCH = RECORD_SUFFIX === "-pre-202608";

/**
 * True while recording against the release before
 * `task-side-effect-gate-union-202608` (commit d492edd), whose trigger read the
 * PLAN's own steps: a plan that declares no acting step asked for no gate there.
 */
const PRE_UNION = RECORD_SUFFIX === "-pre-union";

/**
 * True while recording against the release before
 * `task-side-effect-gate-pipeline-202608` (commit 4e663ee), whose trigger read
 * the plan-wide grant whole: a read-only research task asked for a side-effect
 * approval there, and a gate the old code DID ask has to be answered for the
 * recording to walk the same path.
 */
const PRE_PIPELINE = RECORD_SUFFIX === "-pre-pipeline";

/**
 * Record ONE scenario rather than the whole set: `MEIDOYA_RECORD_ONLY=<name>`.
 *
 * Re-recording a fixture that is not the one being added replaces evidence with
 * whatever today's code does, which is the failure mode this suite exists to
 * catch. Adding a scenario should touch exactly one file.
 */
const RECORD_ONLY = process.env["MEIDOYA_RECORD_ONLY"];

// ---------------------------------------------------------------------------
// Replay — always runs, needs no server.
// ---------------------------------------------------------------------------

describe("recorded histories replay against the current workflow code", () => {
  let bundle: WorkflowBundleWithSourceMap | undefined;

  beforeAll(async () => {
    if (RECORDING) return;
    bundle = await bundleWorkflowCode({ workflowsPath });
  }, 180_000);

  const files = RECORDING
    ? []
    : readdirSync(historiesDir)
        .filter((name) => name.endsWith(".json"))
        .sort();

  it.skipIf(RECORDING)("has a fixture for every declared scenario", () => {
    expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual(
      [...Object.keys(SCENARIOS)].sort(),
    );
  });

  for (const file of files) {
    it(
      `replays ${file}`,
      async () => {
        if (!bundle) throw new Error("no workflow bundle");
        const history = historyFromText(readFileSync(historiesDir + file, "utf8"));
        // Throws DeterminismViolationError when the code no longer produces the
        // command sequence this history recorded.
        await Worker.runReplayHistory(
          { workflowBundle: bundle, replayName: file },
          history,
        );
      },
      180_000,
    );
  }
});

// ---------------------------------------------------------------------------
// Recording — opt-in.
// ---------------------------------------------------------------------------

const policy: WorkspacePolicy = {
  requestPolicy: { quickSoftDeadlineMs: 120_000, defaultPipeline: "coding" },
  humanGates: { clarification: "never", plan: "always", review: "never", sideEffect: "policy" },
  limits: {
    maxSteps: 24,
    maxStepVisits: 5,
    maxFixRounds: 3,
    maxReviewRounds: 3,
    maxNoProgressRounds: 2,
    maxParallelWorkers: 3,
    maxModelEscalations: 2,
    maxConsecutiveFailures: 3,
    maxWallTimeMs: 4 * 60 * 60 * 1000,
  },
  execution: { preferredProfile: "codex-standard", fallbackProfiles: [] },
};

const PLAN: ExecutionPlan = {
  summary: "s",
  risk: "low",
  projects: [{ projectId: "p1", mode: "write" }],
  steps: [
    {
      key: "impl",
      kind: "implement",
      description: "d",
      workerProfile: "implementer",
      dependsOn: [],
    },
  ],
  expectedArtifacts: [],
  verification: { commands: [{ name: "test" }] },
};

/**
 * The shape of an ordinary coding plan: someone reads, someone writes. No step
 * asks for anything alarming on its own — and yet the plan-wide grant carries
 * the researcher's `network` into the implementer's `repo.write` + `shell`.
 */
const TWO_STEP_PLAN: ExecutionPlan = {
  ...PLAN,
  steps: [
    {
      key: "look",
      kind: "investigate",
      description: "Read the module.",
      workerProfile: "researcher",
      dependsOn: [],
    },
    {
      key: "impl",
      kind: "implement",
      description: "Rename the helper.",
      workerProfile: "implementer",
      dependsOn: ["look"],
    },
  ],
};

/**
 * A plan that declares NO step able to act — the round-4 escape. The pipeline's
 * `implement` step runs regardless, and the plan-wide grant is what it gets.
 */
const NO_ACTOR_PLAN: ExecutionPlan = {
  ...PLAN,
  steps: [
    {
      key: "look",
      kind: "investigate",
      description: "Read the module.",
      workerProfile: "researcher",
      dependsOn: [],
    },
    {
      key: "check",
      kind: "review",
      description: "Check the result.",
      workerProfile: "reviewer",
      dependsOn: ["look"],
    },
  ],
};

/**
 * A read-only research task: one `investigate` step by a researcher, a project
 * opened for READING and no verification commands. On the research pipeline
 * nothing that runs it can act.
 */
const READ_ONLY_RESEARCH_PLAN: ExecutionPlan = {
  summary: "Read the docs and write up what we found.",
  risk: "low",
  projects: [{ projectId: "p1", mode: "read" }],
  steps: [
    {
      key: "look",
      kind: "investigate",
      description: "Read the module.",
      workerProfile: "researcher",
      dependsOn: [],
    },
  ],
  expectedArtifacts: [],
  verification: { commands: [] },
};

type RecordingOptions = {
  /** The pipeline to run; `coding` when unset, as `taskInput` declares. */
  pipeline?: TaskWorkflowInput["pipeline"];
  plan?: ExecutionPlan;
  requiredGates?: HumanCheckpointKind[];
  effectiveGates?: WorkspacePolicy["humanGates"];
  managerDecision?: ManagerDecision;
  denyBudget?: (input: ChargeBudgetInput) => boolean;
};

/**
 * Control-plane stand-ins. Deliberately simple: the fixture records the SHAPE of
 * the workflow's command stream, so what the activities return only has to be
 * enough to walk the scenario.
 */
function recordingActivities(options: RecordingOptions = {}): Activities {
  let version = 0;
  let checkpointSeq = 0;
  let steps = 0;
  let extended = false;
  const requiredGates = options.requiredGates ?? [];
  let denied = false;

  return {
    async loadTaskContext() {
      throw new Error("unused");
    },
    async assessRequest() {
      return { type: "administrative", command: { kind: "task.list" } };
    },
    async executeAdministrativeCommand() {
      return { summary: "unused" };
    },
    async finalizeIntakeRequest() {},
    async materializeScheduledRequest() {
      return { taskId: "unused", pipeline: "scheduled" };
    },
    async loadGatePolicy() {
      return {
        mandatoryGates: {},
        effectiveGates: options.effectiveGates ?? policy.humanGates,
        qualityGates: [{ name: "test", argv: ["npm", "test"] }],
      };
    },
    async recordStepOutcome() {},
    async chargeBudget(input) {
      if (!denied && options.denyBudget?.(input) === true) {
        denied = true;
        return { allowed: false, limit: "max_steps", stepsUsed: steps };
      }
      steps += 1;
      return { allowed: true, stepsUsed: steps };
    },
    async extendBudget() {
      if (extended) return { ok: false, reason: "already-extended" };
      extended = true;
      return { ok: true, maxSteps: policy.limits.maxSteps * 2 };
    },
    async planTask() {
      return { status: "planned" as const, plan: options.plan ?? PLAN };
    },
    async runWorkerStep() {
      return { type: "completed" as const, summary: "done", artifacts: [], evidence: [] };
    },
    async runVerification() {
      return {
        status: "passed" as const,
        groups: [],
        missingArtifacts: [],
        artifacts: [],
        evidence: [],
      };
    },
    async runReview() {
      return { findings: [] };
    },
    async decideNextAction() {
      return options.managerDecision ?? ({ type: "complete" } as ManagerDecision);
    },
    async resolveWorkerRuntime() {
      return {
        runtime: { provider: "codex", modelProfile: "standard" },
        allowedRuntimes: [{ provider: "codex", modelProfile: "standard" }],
      };
    },
    async recordTaskStatus() {
      version += 1;
      return { applied: true, version };
    },
    async createCheckpoint(input) {
      const required = input.kind === "limit-exceeded" || requiredGates.includes(input.kind);
      checkpointSeq += 1;
      return {
        checkpointId: required ? `cp-${input.kind}-${checkpointSeq}` : "",
        version: input.version,
        required,
      };
    },
    async emitDomainEvent() {},
    async completeTask() {
      return { status: "completed" as const };
    },
    async createDelegation() {
      throw new Error("unused");
    },
    async compareWithPreviousResult() {
      return { changed: true };
    },
    async loadWorkspacePolicy() {
      return { policy, revision: 1 };
    },
  };
}

const taskInput: TaskWorkflowInput = {
  taskId: "t-replay",
  workspaceId: "work-it",
  environmentId: "home",
  pipeline: "coding",
  lane: "durable",
  brief: { summary: "add feature", projects: ["p1"], origin: "chat" },
  policy,
  executionNodeId: "mac-main",
  taskVersion: 0,
};

describe.runIf(RECORDING)("record histories", () => {
  let env: TestWorkflowEnvironment | undefined;

  beforeAll(async () => {
    env = await startTimeSkippingEnv();
    mkdirSync(historiesDir, { recursive: true });
  }, 180_000);

  afterAll(async () => {
    await env?.teardown();
  });

  function requireEnv(): TestWorkflowEnvironment {
    if (!env) throw new Error("no test environment");
    return env;
  }

  async function withWorkers(
    activities: Activities,
    body: (client: TestWorkflowEnvironment["client"]) => Promise<void>,
  ): Promise<void> {
    const testEnv = requireEnv();
    const control = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: CONTROL_TASK_QUEUE,
      workflowsPath,
      activities,
    });
    const node = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: nodeTaskQueue("mac-main"),
      activities,
    });
    await control.runUntil(node.runUntil(body(testEnv.client)));
  }

  async function waitFor(
    handle: { query: (q: typeof taskSnapshotQuery) => Promise<TaskSnapshot> },
    predicate: (snapshot: TaskSnapshot) => boolean,
    what: string,
  ): Promise<TaskSnapshot> {
    for (let i = 0; i < 400; i += 1) {
      const snapshot = await handle.query(taskSnapshotQuery);
      if (predicate(snapshot)) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  function save(name: string, history: unknown): void {
    writeFileSync(`${historiesDir}${name}.json`, historyToText(history), "utf8");
  }

  /** Runs a task to completion, answering `gateCount` gates, and saves it. */
  async function recordTask(
    baseName: string,
    options: RecordingOptions & { gate?: HumanCheckpointKind; gateCount?: number },
  ): Promise<void> {
    const name = `${baseName}${RECORD_SUFFIX}`;
    // A variant only re-records the scenarios declared for it.
    if (!(name in SCENARIOS)) return;
    if (RECORD_ONLY !== undefined && RECORD_ONLY !== baseName && RECORD_ONLY !== name) return;
    const workflowId = taskWorkflowId(name);
    await withWorkers(recordingActivities(options), async (client) => {
      const handle = await client.workflow.start(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId,
        args: [
          {
            ...taskInput,
            taskId: name,
            ...(options.pipeline === undefined ? {} : { pipeline: options.pipeline }),
          },
        ],
      });
      if (options.gate !== undefined) {
        let answered: string | undefined;
        for (let i = 0; i < (options.gateCount ?? 1); i += 1) {
          const waiting = await waitFor(
            handle,
            (s) => s.pendingCheckpointId !== undefined && s.pendingCheckpointId !== answered,
            `${options.gate} gate ${i + 1}`,
          );
          answered = waiting.pendingCheckpointId!;
          await handle.signal(taskAnswerCheckpointSignal, {
            checkpointId: answered,
            answer: "approved",
          });
        }
      }
      await handle.result();
      save(name, await handle.fetchHistory());
    });
  }

  it("records the task scenarios", async () => {
    await recordTask("task-no-gates-complete", { requiredGates: [] });
    await recordTask("task-plan-gate-approved", {
      requiredGates: ["plan-approval"],
      gate: "plan-approval",
    });
    await recordTask("task-side-effect-gate-approved", {
      plan: {
        ...PLAN,
        summary: "Finish the sync.",
        steps: [
          {
            key: "sync",
            kind: "other",
            description: "Run `scripts/sync.sh` to finish.",
            workerProfile: "researcher",
            dependsOn: [],
          },
        ],
      },
      requiredGates: ["side-effect-approval"],
      gate: "side-effect-approval",
    });
    await recordTask("task-review-gate-approved", {
      requiredGates: ["review-approval"],
      effectiveGates: { ...policy.humanGates, review: "on-findings" },
      gate: "review-approval",
    });
    await recordTask("task-budget-limit-extension", {
      requiredGates: [],
      denyBudget: (charge) => charge.kind === "agent-run" && charge.stepKey === "implement",
      gate: "limit-exceeded",
    });
    // The ordinary coding plan. Before task-side-effect-gate-grant-202608 this
    // asked for NO gate at all, which is exactly what the pre-patch fixture has
    // to record; afterwards the implement step's grant carries the plan's
    // network egress, so it gates.
    await recordTask("task-two-step-plan-side-effect-gate", {
      plan: TWO_STEP_PLAN,
      requiredGates: ["side-effect-approval"],
      ...(PRE_PATCH ? {} : { gate: "side-effect-approval" as const }),
    });
    // A plan that declares no acting step: an `investigate` and a `review`,
    // with a writable project and verification commands. Before
    // task-side-effect-gate-union-202608 nothing gated — the trigger read the
    // PLAN's steps — while the coding pipeline's `implement` step was handed
    // the whole plan-wide grant, network included. Afterwards the grant an
    // acting step receives is what the trigger reads, so it gates.
    await recordTask("task-no-actor-plan-side-effect-gate", {
      plan: NO_ACTOR_PLAN,
      requiredGates: ["side-effect-approval"],
      ...(PRE_UNION ? {} : { gate: "side-effect-approval" as const }),
    });
    // A read-only research task on the research pipeline. Before
    // task-side-effect-gate-pipeline-202608 the trigger read the plan-wide
    // grant whole — BASE_CAPABILITIES puts repo.write + shell in it — so the
    // researcher's `network` tripped it and a human was asked to approve a side
    // effect no step of that pipeline could perform. Afterwards the trigger
    // reads what each step is actually issued, and nothing gates.
    await recordTask("task-research-readonly-side-effect-gate", {
      pipeline: "research",
      plan: READ_ONLY_RESEARCH_PLAN,
      requiredGates: ["side-effect-approval"],
      ...(PRE_PIPELINE ? { gate: "side-effect-approval" as const } : {}),
    });
    // The review step's gate IS the completion answer: it is given during the
    // terminal step, so the completion check accepts it and the
    // completion check asks nothing further. One gate, before and after.
    await recordTask("task-review-before-complete", {
      requiredGates: ["review-approval"],
      effectiveGates: { ...policy.humanGates, review: "before-complete" },
      gate: "review-approval",
    });
  }, 600_000);

  it.skipIf(RECORD_SUFFIX !== "" || RECORD_ONLY !== undefined)(
    "records the Maid rotation",
    async () => {
    const testEnv = requireEnv();
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: CONTROL_TASK_QUEUE,
      workflowsPath,
      activities: recordingActivities(),
    });
    const workflowId = maidWorkflowId("home", "work-replay");

    await worker.runUntil(
      (async () => {
        const handle = await testEnv.client.workflow.start(WorkspaceMaidWorkflow, {
          taskQueue: CONTROL_TASK_QUEUE,
          workflowId,
          args: [{ environmentId: "home", workspaceId: "work-replay", policyRevision: 1 }],
        });
        const firstRunId = (await handle.describe()).runId;
        await handle.executeUpdate(submitMessageUpdate, {
          args: [{ requestKey: "req-1", origin: "chat", messageRef: "msg:123" }],
        });
        await handle.signal(maidRefreshPolicySignal, 2);

        let runId = firstRunId;
        for (let i = 0; i < 200 && runId === firstRunId; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          runId = (await handle.describe()).runId;
        }
        if (runId === firstRunId) throw new Error("the Maid never rotated");

        const firstRun = testEnv.client.workflow.getHandle(workflowId, firstRunId);
        save("maid-continue-as-new", await firstRun.fetchHistory());
        await handle.terminate("recorded");
      })(),
    );
    },
    600_000,
  );
});

/*
 * Recording a pre-patch fixture
 * -----------------------------
 * A `-<suffix>` fixture captures the path an execution took BEFORE a patch
 * existed, which is the path `patched()` has to keep replaying. It is recorded
 * by CHECKING OUT THE PREVIOUS RELEASE and running the recorder against it:
 *
 *   1. find the commit the running workers were built from (the previous
 *      release — `-pre-202608` is commit 2dedb76);
 *   2. restore that release's workflow source into the tree, keeping this file
 *      and `plan-capabilities.ts`/`patches.ts` as they are:
 *
 *        git show <release>:packages/workflows-temporal/src/workflows/task.ts \
 *          > packages/workflows-temporal/src/workflows/task.ts
 *
 *      If the old source calls a helper the current one has renamed or
 *      corrected, point it at the FROZEN copy of that helper (for 2dedb76:
 *      `derivePlanSideEffectCapabilitiesIsolated`). Never point it at the
 *      corrected one — the fixture would then record today's behaviour;
 *   3. declare the fixture names in SCENARIOS above, and give the recorder the
 *      path the OLD code actually walks (see `PRE_PATCH`): a gate the old code
 *      never asked for cannot be answered;
 *   4. MEIDOYA_RECORD_HISTORIES=1 MEIDOYA_RECORD_SUFFIX=-pre-202608 \
 *        MEIDOYA_RECORD_ONLY=<scenario> \
 *        pnpm vitest run packages/workflows-temporal/src/workflows/replay.test.ts
 *
 *      `MEIDOYA_RECORD_ONLY` keeps the other fixtures as they are: re-recording
 *      one that is not being added replaces evidence with today's behaviour.
 *   5. `git checkout` the workflow source back and run the suite normally; the
 *      new fixtures must replay green, because they carry no marker for any
 *      patch id and the legacy branches reproduce that release exactly.
 *
 * What must NOT be done — it is how this guard was lost once already: recording
 * the fixture from TODAY's source with the `version` flags hard-coded to
 * `false`. That records the legacy branch as written rather than as deployed, so
 * the fixture validates the invention instead of the history, and a legacy
 * branch that reconstructs the wrong generation replays green all the way to
 * production, where every in-flight execution wedges on a workflow-task failure
 * Temporal retries forever.
 *
 * Never repeat step 1-4 for an existing pre-patch fixture. It is a historical
 * record; re-recording it against changed code is how the guard gets lost.
 */
