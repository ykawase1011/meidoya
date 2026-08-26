import { fileURLToPath } from "node:url";

import { startTimeSkippingEnv } from "@meidoya/temporal-test-env";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { ExecutionPlan, WorkspacePolicy } from "@meidoya/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Activities, CompleteTaskInput, DelegationInput } from "../activities.js";
import { CONTROL_TASK_QUEUE, nodeTaskQueue } from "../task-queues.js";
import {
  crossWorkspaceWorkflowId,
  headMaidWorkflowId,
  maidWorkflowId,
} from "../workflow-ids.js";
import {
  HeadMaidWorkflow,
  headMaidStateQuery,
  submitCoordinationUpdate,
} from "./head-maid.js";
import type { CrossWorkspaceResult } from "./cross-workspace.js";
import { submitDelegationUpdate, WorkspaceMaidWorkflow } from "./workspace-maid.js";

const policy: WorkspacePolicy = {
  requestPolicy: { quickSoftDeadlineMs: 1_000, defaultPipeline: "quick" },
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
    maxWallTimeMs: 60_000,
  },
  execution: { preferredProfile: "mac-restricted", fallbackProfiles: [] },
};

const plan = (summary: string, projects: string[] = []): ExecutionPlan => ({
  summary,
  risk: "low",
  projects: projects.map((projectId) => ({ projectId, mode: "write" as const })),
  steps: [],
  expectedArtifacts: [],
  verification: { commands: [] },
});

let env: TestWorkflowEnvironment | undefined;

beforeAll(async () => {
  env = await startTimeSkippingEnv();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

describe("CrossWorkspaceWorkflow", () => {
  it("delegates through each Maid and aggregates two child summaries into one completion", async () => {
    if (!env) throw new Error("no test environment");
    const versions = new Map<string, number>();
    const delegations: DelegationInput[] = [];
    const workerTaskIds: string[] = [];
    const workerProjects: string[][] = [];
    const completions: CompleteTaskInput[] = [];
    const budgetCharges: Parameters<Activities["chargeBudget"]>[0][] = [];

    const activities: Partial<Activities> = {
      async loadWorkspacePolicy() {
        return { policy, revision: 1 };
      },
      async loadGatePolicy() {
        return { mandatoryGates: {}, effectiveGates: policy.humanGates };
      },
      async assessRequest(input) {
        return {
          type: "durable",
          brief: {
            summary: `work in ${input.workspaceId}`,
            projects: [`${input.workspaceId}-project`],
            origin: input.origin,
          },
        };
      },
      async planTask(input) {
        return {
          status: "planned",
          plan: plan(
            input.delegationResults === undefined
              ? "delegate to both workspaces"
              : input.delegationResults.map((child) => child.summary).join(" + "),
            input.delegationResults === undefined ? input.brief.projects : [],
          ),
        };
      },
      async createCheckpoint() {
        return { checkpointId: "unused", version: 1, required: false };
      },
      async recordTaskStatus(input) {
        const version = (versions.get(input.taskId) ?? 0) + 1;
        versions.set(input.taskId, version);
        return { applied: true, version };
      },
      async recordStepOutcome() {},
      async chargeBudget(input) {
        budgetCharges.push(input);
        return { allowed: true, stepsUsed: 1 };
      },
      async resolveWorkerRuntime() {
        return {
          runtime: { provider: "codex", modelProfile: "standard" },
          allowedRuntimes: [{ provider: "codex", modelProfile: "standard" }],
        };
      },
      async runWorkerStep(input) {
        workerTaskIds.push(input.taskId);
        workerProjects.push(input.projectAccess.map((project) => project.projectId));
        return { type: "completed", summary: `done in ${input.workspaceId}`, artifacts: [], evidence: [] };
      },
      async completeTask(input) {
        completions.push(input);
        return { status: "completed" };
      },
      async createDelegation(input) {
        delegations.push(input);
        const requestKey = `delegated-${input.targetWorkspaceId}`;
        const childTaskId = `child-${input.targetWorkspaceId}`;
        const workflowId = maidWorkflowId(input.environmentId, input.targetWorkspaceId);
        await env!.client.workflow.getHandle(workflowId).executeUpdate(submitDelegationUpdate, {
          args: [
            {
              requestKey,
              origin: "delegation",
              messageRef: `task_event:${requestKey}`,
              delegation: {
                brief: input.brief,
                childTaskId,
                rootTaskId: input.parentTaskId,
                coordinationWorkflowId: input.coordinationWorkflowId,
              },
            },
          ],
        });
        return { childTaskId, maidWorkflowId: workflowId };
      },
    };

    const workflowsPath = fileURLToPath(new URL("./index.ts", import.meta.url));
    const controlWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: CONTROL_TASK_QUEUE,
      workflowsPath,
      activities,
    });
    const nodeWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: nodeTaskQueue("mac-main"),
      workflowsPath,
      activities,
    });
    const nodeRun = nodeWorker.run();

    try {
      await controlWorker.runUntil(
        (async () => {
          for (const workspaceId of ["work-a", "work-b"]) {
            await env!.client.workflow.start(WorkspaceMaidWorkflow, {
              taskQueue: CONTROL_TASK_QUEUE,
              workflowId: maidWorkflowId("home", workspaceId),
              args: [{ environmentId: "home", workspaceId, policyRevision: 1 }],
            });
          }

          const headMaid = await env!.client.workflow.start(HeadMaidWorkflow, {
            taskQueue: CONTROL_TASK_QUEUE,
            workflowId: headMaidWorkflowId("home"),
            args: [
              {
                environmentId: "home",
                coordinationWorkspaceId: "head-maid",
                policyRevision: 1,
              },
            ],
          });
          await headMaid.executeUpdate(submitCoordinationUpdate, {
            args: [
              {
                taskId: "coord-1",
                brief: { summary: "compare", projects: [], origin: "cli" },
                targetWorkspaceIds: ["work-a", "work-b"],
                conversationId: "thread-1",
              },
            ],
          });
          const coordination = env!.client.workflow.getHandle(
            crossWorkspaceWorkflowId("coord-1"),
          );
          let result: CrossWorkspaceResult | undefined;
          for (let attempt = 0; attempt < 100 && result === undefined; attempt += 1) {
            result = await coordination.result().catch(() => undefined);
            if (result === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (result === undefined) throw new Error("coordination workflow did not complete");

          expect(result.status).toBe("completed");
          expect(result.children).toEqual([
            expect.objectContaining({ workspaceId: "work-a", childTaskId: "child-work-a" }),
            expect.objectContaining({ workspaceId: "work-b", childTaskId: "child-work-b" }),
          ]);
          expect(delegations.map((input) => input.targetWorkspaceId)).toEqual([
            "work-a",
            "work-b",
          ]);
          expect(workerTaskIds.sort()).toEqual(["child-work-a", "child-work-b"]);
          expect(workerTaskIds).not.toContain("coord-1");
          expect(workerProjects).toEqual(
            expect.arrayContaining([["work-a-project"], ["work-b-project"]]),
          );
          expect(budgetCharges).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ taskId: "coord-1", stepKey: "plan" }),
              expect.objectContaining({ taskId: "coord-1", stepKey: "aggregate" }),
              expect.objectContaining({ taskId: "child-work-a", rootTaskId: "coord-1" }),
              expect.objectContaining({ taskId: "child-work-b", rootTaskId: "coord-1" }),
            ]),
          );
          expect(completions).toContainEqual(
            expect.objectContaining({
              taskId: "coord-1",
              workspaceId: "head-maid",
              conversationId: "thread-1",
              summary: "done in work-a + done in work-b",
            }),
          );

          for (let attempt = 0; attempt < 100; attempt += 1) {
            const state = await headMaid.query(headMaidStateQuery);
            if (state.activeCoordinationTaskIds.length === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect((await headMaid.query(headMaidStateQuery)).activeCoordinationTaskIds).toEqual([]);
          await headMaid.terminate("test done");

          for (const workspaceId of ["work-a", "work-b"]) {
            await env!.client.workflow
              .getHandle(maidWorkflowId("home", workspaceId))
              .terminate("test done")
              .catch(() => undefined);
          }
        })(),
      );
    } finally {
      nodeWorker.shutdown();
      await nodeRun.catch(() => undefined);
    }
  }, 120_000);
});
