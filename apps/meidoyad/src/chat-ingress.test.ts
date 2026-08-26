import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FakePlatformClient, type InboundChatEvent } from "@meidoya/chat-vercel";
import { migrate, migrations, openDatabase } from "@meidoya/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseControlPlaneConfig, resolveControlPlaneConfig } from "./config.js";
import { createChatGateway } from "./chat-gateway.js";
import { createChatIngress, type ChatIngressOptions } from "./chat-ingress.js";
import { SqliteTaskRepository, seedFromConfig } from "./repository.js";
import { SerialWriteQueue } from "./write-queue.js";
import { makeDataDir, testConfigYaml } from "./testing/harness.js";

const WORKSPACE = "work-grammarxiv";
const SLACK_ROOT = "1700000000.000100";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = makeDataDir();
  dirs.push(dir);
  return dir;
}

function configForChat(dir: string) {
  const yaml = testConfigYaml(dir).replace(
    `    ingress:\n      cli:\n        profile: ${WORKSPACE}\n`,
    `    ingress:\n` +
      `      cli:\n        profile: ${WORKSPACE}\n` +
      `      slack:\n        account: T_PERSONAL\n        channel: C_WORK\n` +
      `      discord:\n        account: G_PERSONAL\n        channel: D_WORK\n`,
  );
  return resolveControlPlaneConfig(parseControlPlaneConfig(yaml));
}

function slackEvent(overrides: Partial<InboundChatEvent> = {}): InboundChatEvent {
  return {
    transport: "slack",
    accountRef: "T_PERSONAL",
    channelRef: "C_WORK",
    messageRef: SLACK_ROOT,
    authorRef: "U_HUMAN",
    text: "Run the repository tests",
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function discordEvent(overrides: Partial<InboundChatEvent> = {}): InboundChatEvent {
  return {
    transport: "discord",
    accountRef: "G_PERSONAL",
    channelRef: "D_WORK",
    messageRef: "discord-root",
    authorRef: "U_HUMAN",
    text: "Run the repository tests",
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function rig() {
  const dir = dataDir();
  const config = configForChat(dir);
  const db = openDatabase(config.sqlitePath);
  migrate(db, migrations);
  seedFromConfig(db, config);
  const queue = new SerialWriteQueue();
  const repository = new SqliteTaskRepository(db, queue);
  const slack = new FakePlatformClient("slack");
  const discord = new FakePlatformClient("discord");
  const gateway = createChatGateway({
    config,
    db,
    runWrite: (fn) => queue.enqueue(fn),
    platformClients: [slack, discord],
  });
  const createTask = vi.fn(async (_scope, params) => ({
    task: {
      taskId: `task-${params.idempotencyKey ?? "generated"}`,
      title: params.title,
      status: "received" as const,
      pipeline: "coding" as const,
      createdAt: 1,
      updatedAt: 1,
    },
    temporalWorkflowId: `task/${params.idempotencyKey ?? "generated"}`,
  }));
  const answerCheckpoint = vi.fn(async (_scope, params) => ({
    checkpointId: params.checkpointId,
    status: params.decision === "approve" ? ("approved" as const) : ("answered" as const),
    version: params.expectedVersion + 1,
  }));
  const service = {
    createTask,
    getCheckpoint: (_scope: unknown, checkpointId: string) => {
      const checkpoint = repository.loadCheckpointSync(checkpointId);
      if (checkpoint === undefined) throw new Error(`missing ${checkpointId}`);
      return checkpoint;
    },
    answerCheckpoint,
  } as ChatIngressOptions["service"];
  const scopes = {
    mintForBinding: (binding) => ({
      scopeToken: `scope:${binding.id}`,
      workspaceId: binding.workspaceId,
      projects: ["grammarxiv"],
      role: "maid" as const,
      expiresAt: Date.now() + 60_000,
    }),
    resolve: () => ({ workspaceId: WORKSPACE, role: "maid" as const, capabilities: [] }),
    projectsOf: () => ["grammarxiv"],
  } as ChatIngressOptions["scopes"];
  const ingress = createChatIngress({ gateway, config, repository, scopes, service });
  if (ingress === undefined) throw new Error("chat ingress was not created");
  return {
    db,
    queue,
    repository,
    gateway,
    slack,
    discord,
    ingress,
    createTask,
    answerCheckpoint,
    async close() {
      await ingress.stop();
      await queue.close();
      db.close();
    },
  };
}

describe("chat ingress", () => {
  it("accepts Slack and Discord root messages as idempotent chat tasks", async () => {
    const test = await rig();
    await test.ingress.start();

    await test.slack.emit(slackEvent());
    await test.slack.emit(slackEvent());
    await test.discord.emit(discordEvent());

    expect(test.createTask).toHaveBeenCalledTimes(3);
    expect(test.createTask.mock.calls[0]?.[1]).toMatchObject({
      intent: { summary: "Run the repository tests", projects: ["grammarxiv"], origin: "chat" },
      conversationId: expect.stringMatching(/^conv-chat-/u),
      idempotencyKey: expect.stringMatching(/^chat-/u),
    });
    expect(test.createTask.mock.calls[1]?.[1].idempotencyKey).toBe(
      test.createTask.mock.calls[0]?.[1].idempotencyKey,
    );
    expect(test.createTask.mock.calls[2]?.[1].idempotencyKey).not.toBe(
      test.createTask.mock.calls[0]?.[1].idempotencyKey,
    );
    const rows = test.db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number };
    expect(rows.n).toBe(2);
    await test.close();
  });

  it("routes a Japanese approval reply to the pending Slack checkpoint", async () => {
    const test = await rig();
    await test.gateway.conversations?.ensure({
      conversationId: "conv-slack",
      workspaceId: WORKSPACE,
      ingressBindingId: `slack:${WORKSPACE}`,
      thread: { transport: "slack", channelRef: "C_WORK", threadRef: SLACK_ROOT },
      rootMessage: {
        transport: "slack",
        channelRef: "C_WORK",
        messageRef: SLACK_ROOT,
        threadRef: SLACK_ROOT,
      },
    });
    await test.repository.createTask({
      taskId: "task-slack",
      workspaceId: WORKSPACE,
      conversationId: "conv-slack",
      origin: "chat",
      pipeline: "coding",
      title: "Run tests",
      intent: { summary: "Run tests", projects: ["grammarxiv"], origin: "chat" },
      temporalWorkflowId: "task/task-slack",
      now: Date.now(),
    });
    await test.repository.recordCheckpoint({
      id: "cp_slack",
      taskId: "task-slack",
      kind: "plan-approval",
      status: "pending",
      prompt: "Approve?",
      choices: [],
      version: 1,
    });

    const result = await test.ingress.handle(
      slackEvent({ messageRef: "1700000001.000200", threadRef: SLACK_ROOT, text: "承認します" }),
    );

    expect(result).toEqual({
      kind: "checkpoint-answered",
      checkpointId: "cp_slack",
      workspaceId: WORKSPACE,
    });
    expect(test.answerCheckpoint.mock.calls[0]?.[1]).toEqual({
      checkpointId: "cp_slack",
      decision: "approve",
      expectedVersion: 1,
    });
    await test.close();
  });

  it("resolves Discord replies to a posted bot-message alias", async () => {
    const test = await rig();
    await test.gateway.conversations?.ensure({
      conversationId: "conv-discord",
      workspaceId: WORKSPACE,
      ingressBindingId: `discord:${WORKSPACE}`,
      thread: { transport: "discord", channelRef: "D_WORK", threadRef: "discord-root" },
      rootMessage: {
        transport: "discord",
        channelRef: "D_WORK",
        messageRef: "discord-root",
        threadRef: "discord-root",
      },
    });
    test.gateway.conversations?.registerMessageAlias("conv-discord", {
      transport: "discord",
      channelRef: "D_WORK",
      messageRef: "bot-checkpoint-message",
    });
    await test.repository.createTask({
      taskId: "task-discord",
      workspaceId: WORKSPACE,
      conversationId: "conv-discord",
      origin: "chat",
      pipeline: "coding",
      title: "Run tests",
      intent: { summary: "Run tests", projects: ["grammarxiv"], origin: "chat" },
      temporalWorkflowId: "task/task-discord",
      now: Date.now(),
    });
    await test.repository.recordCheckpoint({
      id: "cp_discord",
      taskId: "task-discord",
      kind: "clarification",
      status: "pending",
      prompt: "Which target?",
      choices: [],
      version: 2,
    });

    await test.ingress.handle(
      discordEvent({
        messageRef: "discord-answer",
        threadRef: "bot-checkpoint-message",
        text: "staging",
      }),
    );

    expect(test.answerCheckpoint.mock.calls[0]?.[1]).toEqual({
      checkpointId: "cp_discord",
      decision: "answer",
      answer: "staging",
      expectedVersion: 2,
    });
    await test.close();
  });

  it("accepts a natural Japanese approval posted directly in the channel", async () => {
    const test = await rig();
    await test.gateway.conversations?.ensure({
      conversationId: "conv-discord-direct",
      workspaceId: WORKSPACE,
      ingressBindingId: `discord:${WORKSPACE}`,
      thread: { transport: "discord", channelRef: "D_WORK", threadRef: "discord-root" },
      rootMessage: {
        transport: "discord",
        channelRef: "D_WORK",
        messageRef: "discord-root",
        threadRef: "discord-root",
      },
    });
    await test.repository.createTask({
      taskId: "task-discord-direct",
      workspaceId: WORKSPACE,
      conversationId: "conv-discord-direct",
      origin: "chat",
      pipeline: "coding",
      title: "READMEの確認",
      intent: { summary: "READMEを確認", projects: ["grammarxiv"], origin: "chat" },
      temporalWorkflowId: "task/task-discord-direct",
      now: Date.now(),
    });
    await test.repository.recordCheckpoint({
      id: "cp_discord_direct",
      taskId: "task-discord-direct",
      kind: "plan-approval",
      status: "pending",
      prompt: "この計画を承認しますか？",
      choices: [],
      version: 1,
    });
    await test.gateway.conversations?.ensure({
      conversationId: "conv-cancelled-stale",
      workspaceId: WORKSPACE,
      ingressBindingId: `discord:${WORKSPACE}`,
      thread: { transport: "discord", channelRef: "D_WORK", threadRef: "stale-root" },
    });
    await test.repository.createTask({
      taskId: "task-cancelled-stale",
      workspaceId: WORKSPACE,
      conversationId: "conv-cancelled-stale",
      origin: "chat",
      pipeline: "coding",
      title: "キャンセル済み",
      intent: { summary: "stale", projects: ["grammarxiv"], origin: "chat" },
      temporalWorkflowId: "task/task-cancelled-stale",
      now: Date.now(),
    });
    await test.repository.recordCheckpoint({
      id: "cp_cancelled_stale",
      taskId: "task-cancelled-stale",
      kind: "clarification",
      status: "pending",
      prompt: "古い確認",
      choices: [],
      version: 1,
    });
    await test.repository.forceTaskStatus("task-cancelled-stale", "cancelled");

    const result = await test.ingress.handle(
      discordEvent({
        messageRef: "discord-direct-answer",
        text: "全て確認しました。承認します。",
      }),
    );

    expect(result).toEqual({
      kind: "checkpoint-answered",
      checkpointId: "cp_discord_direct",
      workspaceId: WORKSPACE,
    });
    expect(test.answerCheckpoint.mock.calls[0]?.[1]).toEqual({
      checkpointId: "cp_discord_direct",
      decision: "approve",
      expectedVersion: 1,
    });
    expect(test.createTask).not.toHaveBeenCalled();
    expect(test.discord.callsOfKind("send")[0]?.message.body["content"]).toBe(
      "✅ タスク「READMEの確認」への回答を受け付けました。",
    );
    await test.close();
  });

  it("lists task names instead of guessing when a direct approval is ambiguous", async () => {
    const test = await rig();
    const addPending = async (suffix: string, title: string): Promise<void> => {
      const conversationId = `conv-${suffix}`;
      const taskId = `task-${suffix}`;
      await test.gateway.conversations?.ensure({
        conversationId,
        workspaceId: WORKSPACE,
        ingressBindingId: `discord:${WORKSPACE}`,
        thread: { transport: "discord", channelRef: "D_WORK", threadRef: `root-${suffix}` },
      });
      await test.repository.createTask({
        taskId,
        workspaceId: WORKSPACE,
        conversationId,
        origin: "chat",
        pipeline: "coding",
        title,
        intent: { summary: title, projects: ["grammarxiv"], origin: "chat" },
        temporalWorkflowId: `task/${taskId}`,
        now: Date.now(),
      });
      await test.repository.recordCheckpoint({
        id: `cp-${suffix}`,
        taskId,
        kind: "plan-approval",
        status: "pending",
        prompt: "承認しますか？",
        choices: [],
        version: 1,
      });
    };
    await addPending("one", "READMEの確認");
    await addPending("two", "リリース準備");

    await expect(
      test.ingress.handle(discordEvent({ messageRef: "ambiguous-answer", text: "承認" })),
    ).resolves.toEqual({ kind: "rejected", reason: "ambiguous-checkpoint" });
    const content = String(test.discord.callsOfKind("send")[0]?.message.body["content"]);
    expect(content).toContain("READMEの確認");
    expect(content).toContain("リリース準備");
    expect(content).not.toContain("task-one");
    expect(content).not.toContain("cp-one");
    expect(test.answerCheckpoint).not.toHaveBeenCalled();
    expect(test.createTask).not.toHaveBeenCalled();
    await test.close();
  });

  it("fails closed for an unbound channel", async () => {
    const test = await rig();
    await expect(test.ingress.handle(slackEvent({ channelRef: "C_OTHER" }))).resolves.toEqual({
      kind: "rejected",
      reason: "no-binding",
    });
    expect(test.createTask).not.toHaveBeenCalled();
    await test.close();
  });
});

describe("chat gateway credentials and routing", () => {
  it("loads token files and routes each outbound ref to its own platform", async () => {
    const dir = dataDir();
    const config = configForChat(dir);
    const slackToken = path.join(dir, "slack.bot-token");
    const slackAppToken = path.join(dir, "slack.app-token");
    const discordToken = path.join(dir, "discord.bot-token");
    writeFileSync(slackToken, "xoxb-secret\n", { mode: 0o600 });
    writeFileSync(slackAppToken, "xapp-secret\n", { mode: 0o600 });
    writeFileSync(discordToken, "discord-secret\n", { mode: 0o600 });

    const env = {
      MEIDOYA_SLACK_BOT_TOKEN_FILE: slackToken,
      MEIDOYA_SLACK_APP_TOKEN_FILE: slackAppToken,
      MEIDOYA_DISCORD_BOT_TOKEN_FILE: discordToken,
    };
    const credentialed = createChatGateway({ config, env });
    expect([...credentialed.platformClients.keys()].sort()).toEqual(["discord", "slack"]);

    const slack = new FakePlatformClient("slack");
    const discord = new FakePlatformClient("discord");
    const gateway = createChatGateway({
      config,
      env,
      platformClients: [slack, discord],
    });

    await gateway.defaultTransport.postThreadMessage(
      { transport: "slack", channelRef: "C_WORK", threadRef: SLACK_ROOT },
      { text: "slack" },
    );
    await gateway.defaultTransport.postThreadMessage(
      { transport: "discord", channelRef: "D_WORK", threadRef: "discord-root" },
      { text: "discord" },
    );
    expect(slack.callsOfKind("send")).toHaveLength(1);
    expect(discord.callsOfKind("send")).toHaveLength(1);
  });

  it("rejects a token file readable by another local account", () => {
    if (process.platform === "win32") return;
    const dir = dataDir();
    const config = configForChat(dir);
    const token = path.join(dir, "discord.insecure.token");
    writeFileSync(token, "discord-secret\n", { mode: 0o644 });
    expect(() =>
      createChatGateway({
        config,
        env: { MEIDOYA_DISCORD_BOT_TOKEN_FILE: token },
      }),
    ).toThrow(/must not be readable or writable by group\/other/u);
  });
});
