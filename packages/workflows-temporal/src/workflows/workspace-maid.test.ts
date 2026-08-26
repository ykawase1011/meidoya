import { fileURLToPath } from "node:url";

import { startTimeSkippingEnv } from "@meidoya/temporal-test-env";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { WorkspacePolicy } from "@meidoya/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Activities } from "../activities.js";
import { CONTROL_TASK_QUEUE } from "../task-queues.js";
import { maidWorkflowId } from "../workflow-ids.js";
import {
  WorkspaceMaidWorkflow,
  maidRefreshPolicySignal,
  maidStateQuery,
  submitMessageUpdate,
} from "./workspace-maid.js";
import { RequestWorkflow } from "./request.js";

const policy: WorkspacePolicy = {
  requestPolicy: { quickSoftDeadlineMs: 1_000, defaultPipeline: "coding" },
  humanGates: {
    clarification: "never",
    plan: "never",
    review: "never",
    sideEffect: "policy",
  },
  limits: {
    maxSteps: 24,
    maxStepVisits: 5,
    maxFixRounds: 3,
    maxReviewRounds: 3,
    maxNoProgressRounds: 2,
    maxParallelWorkers: 3,
    maxModelEscalations: 2,
    maxConsecutiveFailures: 3,
    maxWallTimeMs: 1000,
  },
  execution: { preferredProfile: "codex-standard", fallbackProfiles: [] },
};

const activities: Partial<Activities> = {
  async loadWorkspacePolicy() {
    return { policy, revision: 1 };
  },
  async assessRequest() {
    return { type: "administrative", command: { kind: "task.list" } };
  },
  async executeAdministrativeCommand() {
    return { summary: "listed" };
  },
  async finalizeIntakeRequest() {},
  async materializeScheduledRequest() {
    return { taskId: "unused", pipeline: "scheduled" };
  },
};

let env: TestWorkflowEnvironment | undefined;

beforeAll(async () => {
  env = await startTimeSkippingEnv();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

describe("WorkspaceMaidWorkflow", () => {
  it("gives every triggered schedule run a workflow-run-scoped task key", async () => {
    if (!env) throw new Error("no test environment");
    const workflowsPath = fileURLToPath(new URL("./index.ts", import.meta.url));
    const materialized: string[] = [];
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: CONTROL_TASK_QUEUE,
      workflowsPath,
      activities: {
        async materializeScheduledRequest(input) {
          materialized.push(input.requestKey);
          return { taskId: `task-${input.requestKey}`, pipeline: "scheduled" };
        },
        async loadWorkspacePolicy() {
          return { policy, revision: 1 };
        },
        async assessRequest() {
          return { type: "out_of_scope", reason: "stop after materialization" };
        },
        async finalizeIntakeRequest() {},
      } satisfies Partial<Activities>,
    });

    await worker.runUntil(
      (async () => {
        const handle = await env!.client.workflow.start(RequestWorkflow, {
          taskQueue: CONTROL_TASK_QUEUE,
          workflowId: "request-scheduled-materialization",
          args: [
            {
              environmentId: "home",
              workspaceId: "work-it",
              requestKey: "weekday-readme",
              origin: "schedule",
              messageRef: "schedule:schedule/work-it/weekday-readme",
            },
          ],
        });
        const result = await handle.result();
        expect(result.taskId).toBe(`task-${materialized[0]}`);
      })(),
    );

    expect(materialized).toHaveLength(1);
    expect(materialized[0]).toMatch(/^weekday-readme-[0-9a-f-]{36}$/);
  }, 120_000);

  it("executes and finalizes a schedule command classified from an ordinary prompt", async () => {
    if (!env) throw new Error("no test environment");
    const workflowsPath = fileURLToPath(new URL("./index.ts", import.meta.url));
    const commands: string[] = [];
    const finalizations: string[] = [];
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: CONTROL_TASK_QUEUE,
      workflowsPath,
      activities: {
        async loadWorkspacePolicy() {
          return { policy, revision: 1 };
        },
        async assessRequest() {
          return {
            type: "administrative",
            command: {
              kind: "schedule.create",
              name: "weekday-readme",
              cron: "0 9 * * 1-5",
              timezone: "Asia/Tokyo",
              title: "README check",
              summary: "README.mdを確認して要点を報告する",
              projects: [],
              delivery: "on-change",
              overlap: "skip",
              enabled: true,
            },
          };
        },
        async executeAdministrativeCommand(input) {
          commands.push(input.command.kind);
          return { summary: "created" };
        },
        async finalizeIntakeRequest(input) {
          finalizations.push(input.status);
        },
      } satisfies Partial<Activities>,
    });

    await worker.runUntil(
      (async () => {
        const handle = await env!.client.workflow.start(RequestWorkflow, {
          taskQueue: CONTROL_TASK_QUEUE,
          workflowId: "request-natural-schedule",
          args: [
            {
              environmentId: "home",
              workspaceId: "work-it",
              requestKey: "natural-schedule",
              origin: "cli",
              messageRef: "msg:natural-schedule",
            },
          ],
        });
        await expect(handle.result()).resolves.toEqual({
          outcome: "administrative",
          taskId: "task-natural-schedule",
        });
      })(),
    );

    expect(commands).toEqual(["schedule.create"]);
    expect(finalizations).toEqual(["completed"]);
  }, 120_000);

  it("keeps only ids and refs, and continues-as-new on a policy revision change", async () => {
    if (!env) throw new Error("no test environment");
    const workflowsPath = fileURLToPath(new URL("./index.ts", import.meta.url));
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: CONTROL_TASK_QUEUE,
      workflowsPath,
      activities,
    });

    await worker.runUntil(
      (async () => {
        const handle = await env!.client.workflow.start(WorkspaceMaidWorkflow, {
          taskQueue: CONTROL_TASK_QUEUE,
          workflowId: maidWorkflowId("home", "work-it"),
          args: [{ environmentId: "home", workspaceId: "work-it", policyRevision: 1 }],
        });
        const firstRunId = (await handle.describe()).runId;

        const requestKey = await handle.executeUpdate(submitMessageUpdate, {
          args: [{ requestKey: "req-1", origin: "chat", messageRef: "msg:123" }],
        });
        expect(requestKey).toBe("req-1");

        const state = await handle.query(maidStateQuery);
        expect(state.workspaceId).toBe("work-it");
        expect(state.policyRevision).toBe(1);
        // Only references — no message bodies or task details.
        expect(Object.keys(state).sort()).toEqual([
          "activeRequestKeys",
          "activeTaskIds",
          "environmentId",
          "mailboxDepth",
          "policyRevision",
          "workspaceId",
        ]);

        await handle.signal(maidRefreshPolicySignal, 2);

        let runId = firstRunId;
        for (let i = 0; i < 100 && runId === firstRunId; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          runId = (await handle.describe()).runId;
        }
        expect(runId).not.toBe(firstRunId);
        expect((await handle.query(maidStateQuery)).policyRevision).toBe(2);

        await handle.terminate("test done");
      })(),
    );
  }, 120_000);

  it("survives a replayed mailbox update after its stable Request workflow completed", async () => {
    if (!env) throw new Error("no test environment");
    const workflowsPath = fileURLToPath(new URL("./index.ts", import.meta.url));
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: CONTROL_TASK_QUEUE,
      workflowsPath,
      activities,
    });

    await worker.runUntil(
      (async () => {
        const handle = await env!.client.workflow.start(WorkspaceMaidWorkflow, {
          taskQueue: CONTROL_TASK_QUEUE,
          workflowId: maidWorkflowId("home", "work-retry"),
          args: [{ environmentId: "home", workspaceId: "work-retry", policyRevision: 1 }],
        });
        const entry = { requestKey: "same-request", origin: "chat" as const, messageRef: "msg:1" };
        await handle.executeUpdate(submitMessageUpdate, { args: [entry] });

        for (let attempt = 0; attempt < 100; attempt += 1) {
          const state = await handle.query(maidStateQuery);
          if (state.activeRequestKeys.length === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await handle.executeUpdate(submitMessageUpdate, { args: [entry] });

        for (let attempt = 0; attempt < 100; attempt += 1) {
          const state = await handle.query(maidStateQuery);
          if (state.activeRequestKeys.length === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect((await handle.query(maidStateQuery)).activeRequestKeys).toEqual([]);
        await handle.terminate("test done");
      })(),
    );
  }, 120_000);
});
