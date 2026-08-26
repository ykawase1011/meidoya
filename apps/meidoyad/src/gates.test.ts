import { rmSync } from "node:fs";
import { startTimeSkippingEnv } from "@meidoya/temporal-test-env";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionPlan } from "@meidoya/domain";
import {
  answerCheckpoint,
  checkpointKinds,
  chooseCheckpoint,
  cliSession,
  FAILING_QUALITY_GATE,
  FAILING_QUALITY_GATE_NAME,
  makeDataDir,
  startTestDaemon,
  submitTask,
  temporalAddress,
  waitForCheckpoint,
  waitForTaskStatus,
  type TestDaemon,
  type TestWorkspaceOptions,
} from "./testing/harness.js";
import {
  DEFAULT_PLAN,
  ScriptedAgentPort,
  type ScriptedAgentOptions,
} from "./testing/scripted-agent.js";
import { startTestNode } from "./testing/node-harness.js";

/**
 * Every gate mode of 06 section 1, exercised on the production path: a real
 * daemon, the real checkpoint policy port, the real TaskWorkflow, a real
 * execution node. The engines behind these gates were all correct in isolation;
 * what was missing was any caller — which is exactly what a test that pokes an
 * engine directly cannot notice.
 *
 * One daemon hosts every scenario, each in its own workspace with its own gate
 * policy and its own scripted agent. The workspace is the isolation boundary the
 * product already has, so the suite uses it instead of booting a control plane
 * per assertion.
 */

type Scenario = {
  workspace: TestWorkspaceOptions;
  agent?: Omit<ScriptedAgentOptions, "workspaces">;
};

const planWith = (overrides: Partial<ExecutionPlan>): ExecutionPlan => ({
  ...DEFAULT_PLAN,
  ...overrides,
});

const SCENARIOS: Record<string, Scenario> = {
  "gate-clarify-always": {
    workspace: { human_gates: { clarification: "always", plan: "never" } },
  },
  "gate-clarify-never": {
    workspace: { human_gates: { clarification: "never", plan: "always" } },
  },
  "gate-clarify-when-needed": {
    workspace: {
      human_gates: { clarification: "when-needed", plan: "never", review: "never" },
    },
    agent: {
      managerDecision: {
        type: "request_checkpoint",
        checkpointKind: "clarification",
        prompt: "Which of the two APIs did you mean?",
      },
    },
  },
  "gate-plan-risk-medium": {
    workspace: { human_gates: { plan: "on-risk" } },
    agent: { plan: planWith({ risk: "medium" }) },
  },
  "gate-plan-risk-high": {
    workspace: { human_gates: { plan: "on-risk" } },
    agent: { plan: planWith({ risk: "high" }) },
  },
  "gate-plan-risk-low": {
    workspace: { human_gates: { plan: "on-risk", review: "never" } },
    agent: { plan: planWith({ risk: "low" }) },
  },
  "gate-review-before-complete": {
    workspace: { human_gates: { plan: "never", review: "before-complete" } },
  },
  "gate-review-on-findings": {
    workspace: { human_gates: { plan: "never", review: "on-findings" } },
    agent: {
      reviewFindings: {
        findings: [{ id: "f1", severity: "minor", summary: "naming could be clearer" }],
      },
    },
  },
  "gate-review-self-approval": {
    workspace: { human_gates: { plan: "never", review: "always" } },
    agent: { reviewFindings: { findings: [] }, managerDecision: { type: "complete" } },
  },
  "gate-mandatory-security": {
    workspace: {
      // The workspace asks for no gates at all; the security policy overrules it.
      human_gates: { clarification: "never", plan: "never", review: "never" },
      mandatory_gates: { plan: "always", review: "always" },
    },
  },
  "gate-side-effect": {
    workspace: { human_gates: { plan: "never", review: "never", side_effect: "always" } },
    agent: { plan: planWith({ summary: "deploy the service and git push the tag" }) },
  },
  "gate-scheduled-all": {
    workspace: {
      default_pipeline: "scheduled",
      human_gates: {
        clarification: "always",
        plan: "always",
        review: "always",
        side_effect: "always",
      },
    },
  },
  "gate-budget-limit": {
    workspace: {
      human_gates: { plan: "never", review: "never" },
      // Its own gate name: the execution node justifies an argv against its
      // configured allowlist by name, so the failing gate cannot masquerade as
      // `test` (which that allowlist binds to the passing argv).
      quality_gates: [{ name: FAILING_QUALITY_GATE_NAME, command: FAILING_QUALITY_GATE }],
      limits: { max_fix_rounds: 2, max_steps: 12 },
    },
    agent: {
      plan: planWith({ verification: { commands: [{ name: FAILING_QUALITY_GATE_NAME }] } }),
    },
  },
};

let env: TestWorkflowEnvironment | undefined;
let daemon: TestDaemon | undefined;
let node: Awaited<ReturnType<typeof startTestNode>> | undefined;
let dataDir: string | undefined;

beforeAll(async () => {
  env = await startTimeSkippingEnv();
  dataDir = makeDataDir();

  const workspaces: Record<string, TestWorkspaceOptions> = {};
  const agentOverrides: Record<string, Omit<ScriptedAgentOptions, "workspaces">> = {};
  for (const [id, scenario] of Object.entries(SCENARIOS)) {
    workspaces[id] = scenario.workspace;
    if (scenario.agent !== undefined) agentOverrides[id] = scenario.agent;
  }

  daemon = await startTestDaemon({
    env,
    dataDir,
    workspaces,
    agents: new ScriptedAgentPort({ workspaces: agentOverrides }),
  });
  node = await startTestNode({
    dataDir,
    temporalAddress: temporalAddress(env),
    workspaces: Object.keys(workspaces),
    reviewFindingsByWorkspace: Object.fromEntries(
      Object.entries(SCENARIOS).flatMap(([workspaceId, scenario]) =>
        scenario.agent?.reviewFindings === undefined
          ? []
          : [[workspaceId, scenario.agent.reviewFindings]],
      ),
    ),
  });
}, 300_000);

afterAll(async () => {
  await node?.stop();
  await daemon?.stop();
  await env?.teardown();
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
});

type Session = {
  daemon: TestDaemon;
  client: Awaited<ReturnType<typeof cliSession>>["client"];
  taskId: string;
};

/** Submits one task into the scenario's workspace and hands back the session. */
async function submitIn(scenario: string, summary = "do the thing"): Promise<Session> {
  if (daemon === undefined) throw new Error("no daemon");
  const { client } = await cliSession(daemon, scenario);
  const taskId = await submitTask(client, summary);
  return { daemon, client, taskId };
}

describe("human gates on the production path", () => {
  it("stops for a clarification gate set to always", async () => {
    const { client, taskId } = await submitIn("gate-clarify-always");
    const checkpoint = await waitForCheckpoint(client, taskId);
    expect(checkpoint.kind).toBe("clarification");
    await waitForTaskStatus(client, taskId, "waiting_clarification");
    client.close();
  }, 120_000);

  it("skips the clarification gate when it is never", async () => {
    const { client, taskId } = await submitIn("gate-clarify-never");
    // The first gate reached is the plan gate: no clarification happened.
    const checkpoint = await waitForCheckpoint(client, taskId);
    expect(checkpoint.kind).toBe("plan-approval");
    client.close();
  }, 120_000);

  it("honours a when-needed clarification the Manager asked for", async () => {
    const { client, taskId } = await submitIn("gate-clarify-when-needed");
    const checkpoint = await waitForCheckpoint(client, taskId, { kind: "clarification" });
    expect(checkpoint.kind).toBe("clarification");
    // Raised mid-flight, so it parks in the interrupt wait state (05 section 3).
    await waitForTaskStatus(client, taskId, "waiting_user_input");
    client.close();
  }, 120_000);

  it("fires an on-risk plan gate at medium risk", async () => {
    const { client, taskId } = await submitIn("gate-plan-risk-medium");
    expect((await waitForCheckpoint(client, taskId)).kind).toBe("plan-approval");
    client.close();
  }, 120_000);

  it("fires an on-risk plan gate at high risk", async () => {
    const { client, taskId } = await submitIn("gate-plan-risk-high");
    expect((await waitForCheckpoint(client, taskId)).kind).toBe("plan-approval");
    client.close();
  }, 120_000);

  it("does not fire an on-risk plan gate at low risk", async () => {
    const { client, daemon: d, taskId } = await submitIn("gate-plan-risk-low");
    await waitForTaskStatus(client, taskId, "completed");
    expect(checkpointKinds(d, taskId)).toEqual([]);
    client.close();
  }, 120_000);

  it("fires a before-complete review gate and completes only after a human answers", async () => {
    const { client, taskId } = await submitIn("gate-review-before-complete");
    const checkpoint = await waitForCheckpoint(client, taskId, { kind: "review-approval" });
    await waitForTaskStatus(client, taskId, "waiting_review_approval");
    await answerCheckpoint(client, checkpoint.checkpointId);
    await waitForTaskStatus(client, taskId, "completed");
    client.close();
  }, 120_000);

  it("fires an on-findings review gate when the reviewer found something", async () => {
    const { client, taskId } = await submitIn("gate-review-on-findings");
    const checkpoint = await waitForCheckpoint(client, taskId, { kind: "review-approval" });
    await answerCheckpoint(client, checkpoint.checkpointId);
    await waitForTaskStatus(client, taskId, "completed");
    client.close();
  }, 120_000);

  it("does not let the reviewer and the Manager approve their own work", async () => {
    // The reviewer reports no findings and the Manager says "complete" — the
    // pair that used to reach `completed` with no human anywhere.
    const { client, taskId } = await submitIn("gate-review-self-approval");
    const checkpoint = await waitForCheckpoint(client, taskId, { kind: "review-approval" });
    const stopped = await waitForTaskStatus(client, taskId, "waiting_review_approval");
    expect(stopped.status).not.toBe("completed");

    await answerCheckpoint(client, checkpoint.checkpointId);
    await waitForTaskStatus(client, taskId, "completed");
    client.close();
  }, 120_000);

  it("cannot have a mandatory security gate relaxed by the workspace policy", async () => {
    const { client, daemon: d, taskId } = await submitIn("gate-mandatory-security");
    const plan = await waitForCheckpoint(client, taskId, { kind: "plan-approval" });
    await answerCheckpoint(client, plan.checkpointId);
    const review = await waitForCheckpoint(client, taskId, { kind: "review-approval" });
    await answerCheckpoint(client, review.checkpointId);
    await waitForTaskStatus(client, taskId, "completed");
    expect(checkpointKinds(d, taskId)).toEqual(["plan-approval", "review-approval"]);
    client.close();
  }, 120_000);

  it("stops a side-effect-capable plan at waiting_side_effect_approval", async () => {
    const { client, taskId } = await submitIn("gate-side-effect");
    const checkpoint = await waitForCheckpoint(client, taskId, { kind: "side-effect-approval" });
    await waitForTaskStatus(client, taskId, "waiting_side_effect_approval");
    await answerCheckpoint(client, checkpoint.checkpointId);
    await waitForTaskStatus(client, taskId, "completed");
    client.close();
  }, 120_000);

  it("gates a scheduled pipeline that asks for every gate", async () => {
    // The demonstrated bypass: `scheduled` under all-`always` produced zero
    // checkpoints and reached `completed` with no human at all.
    const { client, daemon: d, taskId } = await submitIn("gate-scheduled-all");
    const plan = await waitForCheckpoint(client, taskId, { kind: "plan-approval" });
    await waitForTaskStatus(client, taskId, "waiting_plan_approval");
    await answerCheckpoint(client, plan.checkpointId);

    const review = await waitForCheckpoint(client, taskId, { kind: "review-approval" });
    // It has not completed, and could not have: the gate is still open.
    await waitForTaskStatus(client, taskId, "waiting_review_approval");
    await answerCheckpoint(client, review.checkpointId);

    await waitForTaskStatus(client, taskId, "completed");
    expect(checkpointKinds(d, taskId)).toEqual(["plan-approval", "review-approval"]);
    client.close();
  }, 120_000);

  it("stops a task whose verification never passes instead of looping forever", async () => {
    const { client, daemon: d, taskId } = await submitIn("gate-budget-limit");
    const before = d.agents.invocations.length;

    // The limit checkpoint is never optional, so the task parks on it.
    const checkpoint = await waitForCheckpoint(client, taskId, { kind: "limit-exceeded" });
    await waitForTaskStatus(client, taskId, "needs_attention");

    // Bounded, not merely eventually-stopped.
    expect(d.agents.invocations.length - before).toBeLessThanOrEqual(20);

    // 06 section 8: one extension is offered, and it is the only one.
    const stored = (await client.scoped("checkpoint.get", {
      checkpointId: checkpoint.checkpointId,
    })) as { choices: { id: string }[] };
    expect(stored.choices.map((c) => c.id)).toContain("extend-once");
    await chooseCheckpoint(client, checkpoint.checkpointId, "extend-once");

    const stopped = await waitForTaskStatus(client, taskId, "needs_attention");
    expect(stopped.status).toBe("needs_attention");
    expect(d.agents.invocations.length - before).toBeLessThanOrEqual(30);
    client.close();
  }, 120_000);
});
