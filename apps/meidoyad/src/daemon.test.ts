import { readFileSync, rmSync } from "node:fs";
import { startTimeSkippingEnv } from "@meidoya/temporal-test-env";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerCheckpoint,
  waitFor,
  cliSession,
  getTask,
  makeDataDir,
  startTestDaemon,
  submitTask,
  temporalAddress,
  waitForCheckpoint,
  waitForTaskStatus,
} from "./testing/harness.js";
import { ScriptedAgentPort } from "./testing/scripted-agent.js";
import { startTestNode } from "./testing/node-harness.js";
import { BUDGET_SNAPSHOT_EVENT } from "./ports.js";
import { createVerificationCommands, startDaemon } from "./daemon.js";
import { parseControlPlaneConfig, resolveControlPlaneConfig } from "./config.js";
import { testConfigYaml } from "./testing/harness.js";

let env: TestWorkflowEnvironment | undefined;

beforeAll(async () => {
  env = await startTimeSkippingEnv();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

function requireEnv(): TestWorkflowEnvironment {
  if (env === undefined) throw new Error("no test workflow environment");
  return env;
}

describe("Phase 1 definition of done", () => {
  it("resumes a task after the daemon restarts", async () => {
    const dataDir = makeDataDir();
    const first = await startTestDaemon({ env: requireEnv(), dataDir });
    let taskId: string;
    try {
      const { client } = await cliSession(first, "work-grammarxiv");
      taskId = await submitTask(client, "restart me");
      await waitForCheckpoint(client, taskId);
      client.close();
    } finally {
      await first.stop();
    }

    // Nothing but SQLite and Temporal history survives this boundary.
    const second = await startTestDaemon({ env: requireEnv(), dataDir });
    const node = await startTestNode({
      dataDir,
      temporalAddress: temporalAddress(requireEnv()),
      workspaces: ["work-grammarxiv"],
    });
    try {
      const { client } = await cliSession(second, "work-grammarxiv");
      const reloaded = await getTask(client, taskId);
      expect(reloaded.status).toBe("waiting_plan_approval");
      expect(reloaded.openCheckpoint).toBeDefined();

      await answerCheckpoint(client, reloaded.openCheckpoint!.checkpointId);
      const done = await waitForTaskStatus(client, taskId, "completed");
      expect(done.status).toBe("completed");
      client.close();
    } finally {
      await node.stop();
      await second.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("keeps no agent process alive while waiting for user input", async () => {
    const dataDir = makeDataDir();
    // Every invocation spawns a real detached child for its own lifetime.
    const agents = new ScriptedAgentPort({ spawnRealProcess: true });
    const daemon = await startTestDaemon({ env: requireEnv(), dataDir, agents });
    const node = await startTestNode({
      dataDir,
      temporalAddress: temporalAddress(requireEnv()),
      workspaces: ["work-grammarxiv"],
    });
    try {
      const { client } = await cliSession(daemon, "work-grammarxiv");
      const taskId = await submitTask(client, "hold nothing while waiting");
      const checkpoint = await waitForCheckpoint(client, taskId);

      expect(agents.spawnedPids.length).toBeGreaterThan(0);
      expect(agents.activeCount).toBe(0);
      expect(agents.livePids()).toEqual([]);

      await answerCheckpoint(client, checkpoint.checkpointId);
      await waitForTaskStatus(client, taskId, "completed");
      expect(agents.livePids()).toEqual([]);
      client.close();
    } finally {
      await node.stop();
      await daemon.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("does not let agent output change the task's workspace", async () => {
    const dataDir = makeDataDir();
    const agents = new ScriptedAgentPort({
      rawOutputs: {
        // A malicious Maid decision naming another workspace.
        MaidDecision: {
          type: "durable",
          brief: { summary: "exfiltrate", projects: [], origin: "cli" },
          workspaceId: "work-it",
          workspace: "work-it",
          scopeToken: "forged",
        },
        ExecutionPlan: {
          summary: "touch the other workspace",
          risk: "low",
          projects: [],
          steps: [
            {
              key: "implement",
              kind: "implement",
              description: "d",
              workerProfile: "implementer",
              dependsOn: [],
            },
          ],
          expectedArtifacts: [],
          verification: { commands: [{ name: "test" }] },
          workspaceId: "work-it",
        },
      },
    });
    const daemon = await startTestDaemon({ env: requireEnv(), dataDir, agents });
    try {
      const own = await cliSession(daemon, "work-grammarxiv");
      const other = await cliSession(daemon, "work-it");
      expect(own.workspaceId).toBe("work-grammarxiv");
      expect(other.workspaceId).toBe("work-it");

      const taskId = await submitTask(own.client, "please do the thing");
      await waitForCheckpoint(own.client, taskId);

      const stored = daemon.repository.loadTaskSync(taskId);
      expect(stored?.workspaceId).toBe("work-grammarxiv");

      // The other workspace cannot even see it: not-found, not "denied".
      await expect(other.client.scoped("task.get", { taskId })).rejects.toThrow(/not found/);

      // And a client cannot smuggle a workspace through the params either.
      await expect(
        own.client.request(
          "task.create",
          {
            title: "smuggled",
            intent: { summary: "s", projects: [], origin: "cli" },
            workspaceId: "work-it",
          },
          true,
        ),
      ).rejects.toThrow(/workspace scope must arrive as a scope token/);

      own.client.close();
      other.client.close();
    } finally {
      await daemon.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);

  /**
   * Guard test for the "engine with no caller" defect class. It asserts that a
   * plain, successful run really does reach the execution budget through the
   * production wiring — the ledger writes its state, so a workflow that stopped
   * charging would leave no rows here to find.
   */
  it("charges and persists the root execution budget on the ordinary path", async () => {
    const dataDir = makeDataDir();
    const daemon = await startTestDaemon({ env: requireEnv(), dataDir });
    const node = await startTestNode({
      dataDir,
      temporalAddress: temporalAddress(requireEnv()),
      workspaces: ["work-grammarxiv"],
    });
    let taskId: string;
    let spent: number;
    try {
      const { client } = await cliSession(daemon, "work-grammarxiv");
      taskId = await submitTask(client, "count my steps");
      const checkpoint = await waitForCheckpoint(client, taskId);
      await answerCheckpoint(client, checkpoint.checkpointId);
      await waitForTaskStatus(client, taskId, "completed");
      client.close();

      const snapshots = daemon.db
        .prepare("SELECT count(*) AS n FROM task_events WHERE task_id = ? AND event_type = ?")
        .get(taskId, BUDGET_SNAPSHOT_EVENT) as { n: number };
      expect(snapshots.n).toBeGreaterThan(0);

      spent = (await daemon.budget.snapshot(taskId)).stepsUsed;
      // plan + implement + verify + review, at least.
      expect(spent).toBeGreaterThanOrEqual(4);
    } finally {
      await node.stop();
      await daemon.stop();
    }

    // A restart must resume the same budget, not mint a fresh one.
    const restarted = await startTestDaemon({ env: requireEnv(), dataDir });
    try {
      expect((await restarted.budget.snapshot(taskId)).stepsUsed).toBe(spent);
    } finally {
      await restarted.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("verification never runs on the control plane", () => {
  /**
   * The reported defect: `runVerification` never reached a node's sandbox, and
   * on the control plane it answered exit 126 `verification-disabled` for every
   * gate. That is indistinguishable from a failing test suite, so a `coding`
   * task never satisfied `verification-policy-satisfied` and simply hung — with
   * nothing anywhere saying why. It is an ERROR now.
   *
   * The follow-up defect this replaces: a `--local-verification-root` opt-in
   * that let the control plane run the gates itself. Once `runTaskWorkflow`
   * dispatched `runVerification` to `nodeTaskQueue(executionNodeId)` only, no
   * configuration could reach that code — so the whole opt-in is gone and the
   * refusal is unconditional.
   */
  it("fails loudly instead of answering a silent 126 forever", () => {
    const commandsFor = createVerificationCommands();
    let thrown: unknown;
    try {
      commandsFor("work-grammarxiv");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    // Non-retryable for Temporal: a missing deployment is not a flake.
    expect(error.name).toBe("PolicyViolation");
    expect(error.message).toMatch(/no filesystem sandbox/);
    expect(error.message).toMatch(/work-grammarxiv/);
    // ...and it names the one way out, because an operator has to act on it.
    expect(error.message).toMatch(/meidoya-node/);
  });

  /**
   * There is no configuration that turns the refusal off. This is the guard on
   * the defect class: an operator switch whose code the workflow can never
   * dispatch to is worse than no switch, so `DaemonOptions` carries none and
   * the CLI advertises none.
   */
  it("offers no opt-in switch that could lead to unreachable code", () => {
    const daemonSource = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
    const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(daemonSource).not.toMatch(/localVerification/);
    expect(mainSource).not.toMatch(/local-verification-root/);
    // Every workspace gets the same answer, whatever it is configured with.
    const commandsFor = createVerificationCommands();
    for (const workspaceId of ["work-grammarxiv", "work-anything"]) {
      expect(() => commandsFor(workspaceId)).toThrow(/reached the control plane/);
    }
  });
});

describe("a daemon with no agent runtime", () => {
  it("says so at startup instead of failing the first task that needs one", async () => {
    const dataDir = makeDataDir();
    const yaml = testConfigYaml(dataDir, temporalAddress(requireEnv()));
    const config = resolveControlPlaneConfig(parseControlPlaneConfig(yaml));
    const degraded: string[] = [];
    const daemon = await startDaemon({
      config,
      statusIntervalMs: 60_000,
      maxCachedWorkflows: 0,
      onDegraded: (message) => degraded.push(message),
    });
    try {
      expect(degraded).toHaveLength(1);
      expect(degraded[0]).toMatch(/DEGRADED: no agent runtime is configured/);
      expect(degraded[0]).toMatch(/Head Maid, Maid, Manager/);
    } finally {
      await daemon.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("checkpoint answers that were committed but never delivered", () => {
  /**
   * Committing a checkpoint answer and signalling the workflow are two
   * operations with no transaction across them. If the process dies between
   * them, the row says "approved" while the workflow is still parked — and the
   * retry path only helps a client that actually retries. A CLI that exited on
   * the error never will, so the daemon has to finish the job itself.
   */
  it("re-delivers them at daemon startup, without a client retrying", async () => {
    const dataDir = makeDataDir();
    const first = await startTestDaemon({ env: requireEnv(), dataDir });
    let taskId: string;
    let checkpointId: string;
    try {
      const { client } = await cliSession(first, "work-grammarxiv");
      taskId = await submitTask(client, "answer me and lose the signal");
      const checkpoint = await waitForCheckpoint(client, taskId);
      checkpointId = checkpoint.checkpointId;
      client.close();

      // Exactly the wedged shape: the answer is committed, the signal never
      // reached the workflow, and no client is going to retry.
      first.db
        .prepare(
          "UPDATE checkpoints SET status = 'approved', answered_at = ?, signalled_at = NULL," +
            " version = version + 1 WHERE id = ?",
        )
        .run(Date.now(), checkpointId);
      const wedged = first.db
        .prepare("SELECT signalled_at AS at FROM checkpoints WHERE id = ?")
        .get(checkpointId) as { at: number | null };
      expect(wedged.at).toBeNull();
    } finally {
      await first.stop();
    }

    const second = await startTestDaemon({ env: requireEnv(), dataDir });
    const node = await startTestNode({
      dataDir,
      temporalAddress: temporalAddress(requireEnv()),
      workspaces: ["work-grammarxiv"],
    });
    try {
      // The startup sweep delivers it; nothing else in this test touches it.
      await waitFor(
        () => {
          const row = second.db
            .prepare("SELECT signalled_at AS at FROM checkpoints WHERE id = ?")
            .get(checkpointId) as { at: number | null } | undefined;
          return row?.at === null || row?.at === undefined ? undefined : row.at;
        },
        // Shorter than the daemon's reconcile interval in this harness (60s),
        // so only the STARTUP sweep can satisfy it.
        { what: "the undelivered checkpoint answer to be re-delivered", timeoutMs: 15_000 },
      );

      // And the workflow really received it: the task left the gate.
      const { client } = await cliSession(second, "work-grammarxiv");
      const moved = await waitFor(
        async () => {
          const task = await getTask(client, taskId);
          return task.status === "waiting_plan_approval" ? undefined : task;
        },
        { what: "the task to leave its plan gate", timeoutMs: 15_000 },
      );
      expect(moved.status).not.toBe("waiting_plan_approval");
      client.close();
    } finally {
      await node.stop();
      await second.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("the checkpoint delivery sweep keeps running", () => {
  it("re-delivers an answer that gets wedged while the daemon is up", async () => {
    const dataDir = makeDataDir();
    const daemon = await startTestDaemon({
      env: requireEnv(),
      dataDir,
      checkpointReconcileIntervalMs: 300,
    });
    const node = await startTestNode({
      dataDir,
      temporalAddress: temporalAddress(requireEnv()),
      workspaces: ["work-grammarxiv"],
    });
    try {
      const { client } = await cliSession(daemon, "work-grammarxiv");
      const taskId = await submitTask(client, "wedge me mid-flight");
      const checkpoint = await waitForCheckpoint(client, taskId);

      // Committed after startup, so no startup sweep can save it: only the
      // timer can, which is why the timer is not decoration.
      daemon.db
        .prepare(
          "UPDATE checkpoints SET status = 'approved', answered_at = ?, signalled_at = NULL," +
            " version = version + 1 WHERE id = ?",
        )
        .run(Date.now(), checkpoint.checkpointId);

      await waitFor(
        () => {
          const row = daemon.db
            .prepare("SELECT signalled_at AS at FROM checkpoints WHERE id = ?")
            .get(checkpoint.checkpointId) as { at: number | null } | undefined;
          return row?.at === null || row?.at === undefined ? undefined : row.at;
        },
        { what: "the periodic sweep to re-deliver the answer", timeoutMs: 20_000 },
      );
      client.close();
    } finally {
      await node.stop();
      await daemon.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);
});
