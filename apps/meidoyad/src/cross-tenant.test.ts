import { afterEach, describe, expect, it } from "vitest";
import { openCheckpoint } from "@meidoya/checkpoint-policy";
import { ControlPlaneClient, ControlPlaneClientError, run } from "meidoya";
import {
  conversationIdOfRecord,
  createConversationResolver,
  SqliteConversationRegistry,
} from "./chat-gateway.js";
import { buildStatusSnapshot } from "./status.js";
import {
  NODE_B_ONLY,
  NODE_SHARED,
  PROJECT_A,
  PROJECT_B,
  WORKSPACE_A,
  WORKSPACE_B,
  nodeRegistration,
  refusalOf,
  twoWorkspaces,
  type TwoWorkspaceFixture,
} from "./testing/two-workspaces.js";

/**
 * NEGATIVE ISOLATION, one file, one rule: workspace B's rows always exist, and
 * workspace A acts. Every test here fails the moment a workspace predicate is
 * dropped from the query it guards — which is the failure mode the rest of the
 * suite could not see, because a suite that only ever puts ONE workspace's rows
 * in the database has nothing for a missing predicate to leak.
 *
 * The predicates covered (delete any one of them and a named test below turns
 * red):
 *
 *   repository.ts listTasks           `WHERE workspace_id = ?`
 *   api.ts        #requireTask        task.workspaceId !== scope.workspaceId
 *   api.ts        #requireCheckpoint  the owning task's workspace, phrased on
 *                                     the id the CALLER named
 *   api.ts        #requireOwned       parentTaskId / conversationId on create
 *   api.ts        createTask          project ∈ scope.projectsOf(workspace)
 *   api.ts        createTask          the existing-task workspace assertion
 *   api.ts        #scheduleRows       `WHERE workspace_id = ?`
 *   api.ts        #requireOwnedSchedule
 *   api.ts        the schedule upsert's `schedules.workspace_id = excluded...`
 *   api.ts        registerNode        bindings come from policy, not the claim
 *   api.ts        registerNode/heartbeatNode  the per-node credential
 *   api.ts        readWorkspaceStatus node allowedWorkspaces filter
 *   status.ts     buildStatusSnapshot per-workspace row filter
 *   chat-gateway  conversationIdOfRecord / the resolver's workspace check
 *   server.ts     the event stream's `event.workspaceId !== scope.workspaceId`
 */

let fixture: TwoWorkspaceFixture | undefined;

function two(): TwoWorkspaceFixture {
  const created = twoWorkspaces();
  fixture = created;
  return created;
}

afterEach(async () => {
  if (fixture !== undefined) await fixture.close();
  fixture = undefined;
});

describe("natural-language schedule CLI", () => {
  it("marks `schedule add` as schedule interpretation before it reaches the Maid", async () => {
    const f = two();
    const socketPath = await f.startServer();
    const previous = {
      socket: process.env["MEIDOYA_SOCKET"],
      profile: process.env["MEIDOYA_PROFILE"],
      secret: process.env["MEIDOYA_CLIENT_SECRET"],
    };
    process.env["MEIDOYA_SOCKET"] = socketPath;
    process.env["MEIDOYA_PROFILE"] = "profile-a";
    process.env["MEIDOYA_CLIENT_SECRET"] = f.secretFor(WORKSPACE_A);
    try {
      await expect(
        run([
          "schedule",
          "add",
          "平日の朝9時にREADME.mdを確認して要点を報告して",
          "--project",
          PROJECT_A,
          "--detach",
        ]),
      ).resolves.toBe(0);
    } finally {
      for (const [key, value] of [
        ["MEIDOYA_SOCKET", previous.socket],
        ["MEIDOYA_PROFILE", previous.profile],
        ["MEIDOYA_CLIENT_SECRET", previous.secret],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(f.gateway.submitted).toMatchObject([
      {
        workspaceId: WORKSPACE_A,
        entry: { origin: "cli", interpretation: "schedule" },
      },
    ]);
    expect(f.service.listTasks(f.scopeOf(WORKSPACE_A), { limit: 10 }).tasks).toMatchObject([
      { title: "平日の朝9時にREADME.mdを確認して要点を報告して" },
    ]);
  });
});

describe("task.list and workspace.status.read", () => {
  it("shows a workspace its own tasks and never the other workspace's", async () => {
    const f = two();
    await f.createTask(WORKSPACE_B, { title: "B's confidential task" });
    const mine = await f.createTask(WORKSPACE_A, { title: "A's own task" });

    const listed = f.service.listTasks(f.scopeOf(WORKSPACE_A), { limit: 50 });
    expect(listed.tasks.map((task) => task.taskId)).toEqual([mine.taskId]);
    expect(JSON.stringify(listed)).not.toContain("confidential");

    // The same predicate, reached through the other method that depends on it.
    const status = f.service.readWorkspaceStatus(f.scopeOf(WORKSPACE_A), {
      includeSchedules: true,
    });
    expect(JSON.stringify(status)).not.toContain("confidential");
    expect([...status.activeTasks, ...status.waitingTasks].map((t) => t.taskId)).toEqual([
      mine.taskId,
    ]);

    // And B sees exactly the mirror image, so the test cannot pass by returning
    // nothing at all.
    const theirs = f.service.listTasks(f.scopeOf(WORKSPACE_B), { limit: 50 });
    expect(theirs.tasks.map((task) => task.title)).toEqual(["B's confidential task"]);
  });

  it("keeps the status filter honest when the filter is by status too", async () => {
    const f = two();
    await f.createTask(WORKSPACE_B, { title: "B received" });
    const mine = await f.createTask(WORKSPACE_A, { title: "A received" });

    const listed = f.service.listTasks(f.scopeOf(WORKSPACE_A), {
      status: ["received"],
      limit: 50,
    });
    expect(listed.tasks.map((task) => task.taskId)).toEqual([mine.taskId]);
  });

  it("natural-language task lists default to open work, group statuses, and exclude themselves", async () => {
    const f = two();
    const running = await f.createTask(WORKSPACE_A, { title: "Parser implementation" });
    const completed = await f.createTask(WORKSPACE_A, { title: "Old completed work" });
    const query = await f.createTask(WORKSPACE_A, { title: "今進行中のタスクは？" });
    await f.repo.forceTaskStatus(running.taskId, "running");
    await f.repo.forceTaskStatus(completed.taskId, "completed");
    await f.createTask(WORKSPACE_B, { title: "B confidential running task" });

    const open = await f.service.executeAdministrativeCommand({
      workspaceId: WORKSPACE_A,
      taskId: query.taskId,
      command: { kind: "task.list", view: "open" },
    });
    expect(open.title).toBe("進行中のタスク");
    expect(open.summary).toContain("1件");
    expect(JSON.stringify(open.sections)).toContain("⚙️ 実行中");
    expect(JSON.stringify(open)).toContain("Parser implementation");
    expect(JSON.stringify(open)).not.toContain("Old completed work");
    expect(JSON.stringify(open)).not.toContain("今進行中のタスクは？");
    expect(JSON.stringify(open)).not.toContain("confidential");

    const all = await f.service.executeAdministrativeCommand({
      workspaceId: WORKSPACE_A,
      taskId: query.taskId,
      command: { kind: "task.list", view: "all" },
    });
    expect(all.title).toBe("すべてのタスク");
    expect(JSON.stringify(all.sections)).toContain("Old completed work");
    expect(JSON.stringify(all.sections)).toContain("完了・終了");
  });
});

describe("single-task reads and writes", () => {
  it("refuses task.get, task.cancel, task.answer on the other workspace's task", async () => {
    const f = two();
    const theirs = await f.createTask(WORKSPACE_B, { title: "B's task" });
    const a = f.scopeOf(WORKSPACE_A);

    for (const call of [
      () => f.service.getTask(a, { taskId: theirs.taskId }),
      () => f.service.cancelTask(a, { taskId: theirs.taskId }),
      () => f.service.answerTask(a, { taskId: theirs.taskId, questionId: "q", answer: "hi" }),
    ]) {
      const refusal = await refusalOf(call);
      expect(refusal.kind).toBe("not_found");
      // Identical to a task that never existed: no existence oracle.
      expect(refusal.message).toBe(`task ${theirs.taskId} not found`);
    }

    // B's task is untouched: the refusal is a refusal, not a partial write.
    expect(f.repo.loadTaskSync(theirs.taskId)?.status).toBe("received");
    expect(f.gateway.answers).toEqual([]);
  });

  it("refuses checkpoint.get and checkpoint.answer across the boundary", async () => {
    const f = two();
    const theirs = await f.createTask(WORKSPACE_B, { title: "B's task" });
    await f.repo.recordCheckpoint(
      openCheckpoint({
        id: "cp-b",
        taskId: theirs.taskId,
        kind: "plan-approval",
        prompt: "Approve B's plan?",
      }),
    );
    const a = f.scopeOf(WORKSPACE_A);

    // Both the KIND and the MESSAGE. Asserting only the kind is what let this
    // pair of refusals drift apart: the guard raised ``task <B's task id> not
    // found`` on a foreign checkpoint and ``checkpoint cp-nope not found`` on
    // one that never existed, so the two were distinguishable — an existence
    // oracle — and the one that fired on a HIT handed A a real task id of B's.
    for (const call of [
      () => f.service.getCheckpoint(a, "cp-b"),
      () =>
        f.service.answerCheckpoint(a, {
          checkpointId: "cp-b",
          decision: "approve",
          expectedVersion: 1,
        }),
    ]) {
      const refusal = await refusalOf(call);
      expect(refusal.kind).toBe("not_found");
      expect(refusal.message).toBe("checkpoint cp-b not found");
      // Never the owning task's id, under any phrasing.
      expect(refusal.message).not.toContain(theirs.taskId);
    }

    // Word for word what a checkpoint id that exists nowhere gets, so the two
    // answers cannot be told apart.
    const absent = await refusalOf(() => f.service.getCheckpoint(a, "cp-nope"));
    expect(absent.message).toBe("checkpoint cp-nope not found");
    expect(
      (
        await refusalOf(() =>
          f.service.answerCheckpoint(a, {
            checkpointId: "cp-nope",
            decision: "approve",
            expectedVersion: 1,
          }),
        )
      ).message,
    ).toBe("checkpoint cp-nope not found");

    // Nothing was signalled to B's workflow, and the checkpoint is still open.
    expect(f.gateway.answers).toEqual([]);
    expect(f.repo.loadCheckpointSync("cp-b")?.status).toBe("pending");

    // B itself can still read it, so the guard is a boundary and not a wall.
    expect(f.service.getCheckpoint(f.scopeOf(WORKSPACE_B), "cp-b").prompt).toBe(
      "Approve B's plan?",
    );
  });
});

describe("task.create", () => {
  it("refuses a project belonging to the other workspace", async () => {
    const f = two();
    const refusal = await refusalOf(() =>
      f.service.createTask(f.scopeOf(WORKSPACE_A), {
        title: "reaching across",
        intent: { summary: "reaching across", projects: [PROJECT_B], origin: "cli" },
        idempotencyKey: "cross-project",
      }),
    );
    expect(refusal.kind).toBe("invalid_params");
    expect(refusal.message).toContain(PROJECT_B);
    // Nothing was created and nothing was submitted to Temporal.
    expect(f.service.listTasks(f.scopeOf(WORKSPACE_A), { limit: 50 }).tasks).toEqual([]);
    expect(f.gateway.submitted).toEqual([]);

    // Its own project is accepted, so the check is on ownership, not on the
    // parameter being present.
    await expect(
      f.service.createTask(f.scopeOf(WORKSPACE_A), {
        title: "own project",
        intent: { summary: "own project", projects: [PROJECT_A], origin: "cli" },
        idempotencyKey: "own-project",
      }),
    ).resolves.toMatchObject({ task: { title: "own project" } });
  });

  it("refuses a parent task and a conversation owned by the other workspace", async () => {
    const f = two();
    const theirs = await f.createTask(WORKSPACE_B, { title: "B's parent" });
    const conversations = new SqliteConversationRegistry({
      db: f.db,
      runWrite: (write) => f.repo.runWrite(write),
    });
    await conversations.ensure({
      conversationId: "conv-b",
      workspaceId: WORKSPACE_B,
      thread: { transport: "cli", channelRef: "cli:ws-b", threadRef: theirs.taskId },
    });

    const parent = await refusalOf(() =>
      f.service.createTask(f.scopeOf(WORKSPACE_A), {
        title: "adopting a foreign parent",
        intent: { summary: "budget theft", projects: [], origin: "cli" },
        parentTaskId: theirs.taskId,
        idempotencyKey: "foreign-parent",
      }),
    );
    expect(parent.kind).toBe("not_found");

    const conversation = await refusalOf(() =>
      f.service.createTask(f.scopeOf(WORKSPACE_A), {
        title: "adopting a foreign conversation",
        intent: { summary: "thread theft", projects: [], origin: "cli" },
        conversationId: "conv-b",
        idempotencyKey: "foreign-conversation",
      }),
    );
    expect(conversation.kind).toBe("not_found");

    expect(f.service.listTasks(f.scopeOf(WORKSPACE_A), { limit: 50 }).tasks).toEqual([]);
  });

  it("refuses to return a task at its own idempotent id that another workspace owns", async () => {
    const f = two();
    // `createTask`'s existing-row branch is a RETURN: hand back the task the
    // caller's idempotency key already made. The id space is per-workspace, so
    // a collision should be impossible — which is exactly why the workspace
    // assertion on that branch had no test, and why deleting it was free. It is
    // the last thing standing between "your key is a duplicate" and "here is
    // another tenant's task summary, title included".
    //
    // The collision is constructed rather than waited for: A's own row, at A's
    // own derived id, re-owned by B. That is the durable state a restore, a bad
    // migration or a future id scheme could produce, and the branch has to hold
    // whatever produced it.
    const mine = await f.createTask(WORKSPACE_A, { title: "A's task", idempotencyKey: "shared" });
    f.db
      .prepare("UPDATE tasks SET workspace_id = ?, title = ? WHERE id = ?")
      .run(WORKSPACE_B, "B's confidential title", mine.taskId);

    const refusal = await refusalOf(() =>
      f.service.createTask(f.scopeOf(WORKSPACE_A), {
        title: "colliding",
        intent: { summary: "colliding", projects: [], origin: "cli" },
        idempotencyKey: "shared",
      }),
    );
    expect(refusal.kind).toBe("not_found");
    expect(refusal.message).not.toContain("confidential");

    // The row is B's and stayed B's; nothing was submitted on its behalf.
    expect(f.repo.loadTaskSync(mine.taskId)?.workspaceId).toBe(WORKSPACE_B);
    // Only the first, legitimate creation ever reached Temporal.
    expect(f.gateway.submitted).toHaveLength(1);
  });
});

describe("schedules", () => {
  const spec = { cron: "0 9 * * *", timezone: "UTC" };
  const template = { title: "daily", summary: "daily", projects: [], pipeline: "scheduled" as const };

  async function createSchedule(f: TwoWorkspaceFixture, workspaceId: string, name: string) {
    return f.service.createSchedule(f.scopeOf(workspaceId), {
      name,
      spec,
      taskTemplate: template,
      delivery: "on-change",
      overlap: "skip",
      enabled: true,
    });
  }

  it("lists only its own, and refuses to read, update, delete or trigger the other's", async () => {
    const f = two();
    const theirs = await createSchedule(f, WORKSPACE_B, "nightly");
    await createSchedule(f, WORKSPACE_A, "morning");
    const a = f.scopeOf(WORKSPACE_A);

    expect(
      f.service.listSchedules(a, { includeDisabled: true }).schedules.map((s) => s.name),
    ).toEqual(["morning"]);

    for (const call of [
      () => f.service.updateSchedule(a, { scheduleId: theirs.scheduleId, enabled: false }),
      () => f.service.deleteSchedule(a, { scheduleId: theirs.scheduleId }),
      () => f.service.triggerSchedule(a, theirs.scheduleId),
    ]) {
      expect((await refusalOf(call)).kind).toBe("not_found");
    }

    // B's schedule survived all three, and nothing was run on its behalf.
    expect(
      f.service.listSchedules(f.scopeOf(WORKSPACE_B), { includeDisabled: true }).schedules,
    ).toMatchObject([{ name: "nightly", enabled: true }]);
    expect(f.gateway.triggered).toEqual([]);
    expect(f.gateway.deleted).toEqual([]);
  });

  it("cannot overwrite the other workspace's schedule by spelling its id in a name", async () => {
    const f = two();
    const theirs = await createSchedule(f, WORKSPACE_B, "nightly");
    expect(theirs.scheduleId).toBe(`schedule/${WORKSPACE_B}/nightly`);

    // The id is `schedule/<workspace>/<name>`, so a name carrying separators
    // lets one workspace spell another's schedule id. Refused where a caller
    // actually arrives — through the dispatcher, against the params schema.
    const socketPath = await f.startServer();
    const client = await ControlPlaneClient.connect(socketPath);
    try {
      await client.hello("profile-a", f.secretFor(WORKSPACE_A));
      const failure = await client
        .scoped("schedule.create", {
          name: `../${WORKSPACE_B}/nightly`,
          spec,
          taskTemplate: template,
          enabled: true,
        })
        .then(() => undefined)
        .catch((error: unknown) => error as ControlPlaneClientError);
      expect(failure?.error.kind).toBe("invalid_params");
    } finally {
      client.close();
    }

    // Even handed the id directly, the upsert refuses the foreign row.
    const rows = f.db
      .prepare("SELECT workspace_id, spec_json FROM schedules WHERE id = ?")
      .get(theirs.scheduleId) as { workspace_id: string; spec_json: string };
    expect(rows.workspace_id).toBe(WORKSPACE_B);
    expect(rows.spec_json).toContain("0 9 * * *");
  });

  it("refuses an upsert onto a schedule row owned by the other workspace", async () => {
    const f = two();
    // Construct the collision directly: a row of B's carrying an id that A's
    // own (name, workspace) pair would produce. Only the ownership check can
    // stop this one; the name pattern never sees it.
    const id = `schedule/${WORKSPACE_A}/shared-name`;
    f.db
      .prepare(
        `INSERT INTO schedules (id, workspace_id, name, temporal_schedule_id, spec_json,
            task_template_json, delivery_policy, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        WORKSPACE_B,
        "shared-name",
        id,
        JSON.stringify({ cron: "@yearly", timezone: "UTC", overlap: "skip" }),
        JSON.stringify(template),
        "on-change",
        1,
        1,
        1,
      );

    const refusal = await refusalOf(() => createSchedule(f, WORKSPACE_A, "shared-name"));
    expect(refusal.kind).toBe("not_found");

    const row = f.db
      .prepare("SELECT workspace_id, spec_json FROM schedules WHERE id = ?")
      .get(id) as { workspace_id: string; spec_json: string };
    expect(row.workspace_id).toBe(WORKSPACE_B);
    expect(row.spec_json).toContain("@yearly");
  });

  it("still refuses when the foreign row appears AFTER the ownership check", async () => {
    const f = two();
    // The upsert carries `WHERE schedules.workspace_id = excluded.workspace_id`
    // on top of `#requireOwnedSchedule`, and its comment claims two independent
    // fences. Only the first was ever tested — because the first one, when it
    // holds, keeps the second unreachable — so the SQL predicate could be
    // deleted with the suite entirely green.
    //
    // The second fence exists for the window BETWEEN them: `#requireOwnedSchedule`
    // reads, the upsert writes, and a check-then-write on a shared id space is
    // only as good as what closes that gap. Here the gap is opened on purpose:
    // B's row lands after A's check passed and before A's write runs, which is
    // precisely the interleaving a single-statement predicate has to survive.
    const id = `schedule/${WORKSPACE_A}/racy`;
    const original = f.repo.transaction.bind(f.repo);
    let raced = false;
    (f.repo as unknown as { transaction: typeof original }).transaction = async (fn) => {
      if (!raced) {
        raced = true;
        f.db
          .prepare(
            `INSERT INTO schedules (id, workspace_id, name, temporal_schedule_id, spec_json,
                task_template_json, delivery_policy, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            WORKSPACE_B,
            "racy",
            id,
            JSON.stringify({ cron: "@yearly", timezone: "UTC", overlap: "skip" }),
            JSON.stringify(template),
            "on-change",
            1,
            1,
            1,
          );
      }
      return original(fn);
    };

    try {
      await createSchedule(f, WORKSPACE_A, "racy");
    } finally {
      (f.repo as unknown as { transaction: typeof original }).transaction = original;
    }
    expect(raced).toBe(true);

    // B's row is untouched: the write refused itself, with no help from the
    // ownership check that had already passed.
    const row = f.db
      .prepare("SELECT workspace_id, spec_json FROM schedules WHERE id = ?")
      .get(id) as { workspace_id: string; spec_json: string };
    expect(row.workspace_id).toBe(WORKSPACE_B);
    expect(row.spec_json).toContain("@yearly");
    expect(row.spec_json).not.toContain("0 9 * * *");

    // And A learns nothing of it either: no schedule of A's exists.
    expect(f.service.listSchedules(f.scopeOf(WORKSPACE_A), { includeDisabled: true }).schedules)
      .toEqual([]);
  });

  it("creates a schedule from the Maid command and materializes every triggered run", async () => {
    const f = two();
    const result = await f.service.executeAdministrativeCommand({
      workspaceId: WORKSPACE_A,
      command: {
        kind: "schedule.create",
        name: "weekday-readme",
        cron: "0 9 * * 1-5",
        timezone: "Asia/Tokyo",
        title: "README check",
        summary: "README.mdを確認して要点を報告する",
        projects: [PROJECT_A],
        delivery: "on-change",
        overlap: "skip",
        enabled: true,
      },
    });

    expect(result.summary).toContain("weekday-readme");
    const messageRef = f.gateway.schedules[0]?.messageRef;
    expect(messageRef).toBe(`schedule:schedule/${WORKSPACE_A}/weekday-readme`);

    const first = await f.service.materializeScheduledRequest({
      workspaceId: WORKSPACE_A,
      requestKey: "weekday-readme-run-1",
      messageRef: messageRef ?? "",
    });
    const second = await f.service.materializeScheduledRequest({
      workspaceId: WORKSPACE_A,
      requestKey: "weekday-readme-run-2",
      messageRef: messageRef ?? "",
    });

    expect(first.taskId).not.toBe(second.taskId);
    expect(f.repo.loadTaskSync(first.taskId)).toMatchObject({
      workspaceId: WORKSPACE_A,
      origin: "schedule",
      pipeline: "scheduled",
      title: "README check",
      intent: {
        summary: "README.mdを確認して要点を報告する",
        projects: [PROJECT_A],
      },
    });
  });

  it("rejects schedule templates that name a project outside the bound workspace", async () => {
    const f = two();
    const refusal = await refusalOf(() =>
      f.service.createSchedule(f.scopeOf(WORKSPACE_A), {
        name: "foreign-project",
        spec,
        taskTemplate: { ...template, projects: [PROJECT_B] },
        delivery: "on-change",
        overlap: "skip",
        enabled: true,
      }),
    );

    expect(refusal.kind).toBe("invalid_params");
    expect(f.gateway.schedules).toEqual([]);
  });
});

describe("STATUS.md projection", () => {
  it("files each task under its own workspace and nowhere else", async () => {
    const f = two();
    await f.createTask(WORKSPACE_A, { title: "A visible" });
    await f.createTask(WORKSPACE_B, { title: "B visible" });

    const snapshot = buildStatusSnapshot(f.db, f.config, f.service, 1_700_000_000_000);
    const sections = new Map(snapshot.workspaces.map((w) => [w.workspaceId, w]));
    expect(sections.get(WORKSPACE_A)?.tasks.map((t) => t.title)).toEqual(["A visible"]);
    expect(sections.get(WORKSPACE_B)?.tasks.map((t) => t.title)).toEqual(["B visible"]);
  });
});

describe("chat delivery targets", () => {
  it("never resolves an outbox row onto the other workspace's conversation", async () => {
    const f = two();
    const theirs = await f.createTask(WORKSPACE_B, { title: "B's task" });
    const conversations = new SqliteConversationRegistry({
      db: f.db,
      runWrite: (write) => f.repo.runWrite(write),
    });
    await conversations.ensure(
      {
        conversationId: "conv-b",
        workspaceId: WORKSPACE_B,
        thread: { transport: "slack", channelRef: "C-BOB", threadRef: theirs.taskId },
        rootMessage: {
          transport: "slack",
          channelRef: "C-BOB",
          messageRef: theirs.taskId,
          threadRef: theirs.taskId,
        },
      },
      { linkTaskId: theirs.taskId },
    );

    const resolver = createConversationResolver(f.db, conversations);
    const record = {
      id: "outbox-a",
      workspaceId: WORKSPACE_A,
      eventId: "evt-a",
      action: "post-thread-message" as const,
      idempotencyKey: "outbox-a",
      status: "pending" as const,
      attempt: 0,
      availableAt: 0,
      createdAt: 0,
      // The one place a value a model produced can reach: the payload.
      payload: { taskId: theirs.taskId },
    };

    expect(await resolver.thread(record)).toBeUndefined();
    expect(await resolver.reactionTarget(record)).toBeUndefined();

    // The same row, owned by B, still resolves: the check is on the boundary.
    expect(await resolver.thread({ ...record, workspaceId: WORKSPACE_B })).toMatchObject({
      channelRef: "C-BOB",
    });

    // And a conversation id handed in directly does not bypass it either.
    expect(
      await resolver.thread({ ...record, conversationId: "conv-b", payload: {} }),
    ).toBeUndefined();

    // The lookup underneath is scoped in its own right, not only by the check
    // above it: a row of A's must not even LEARN B's conversation id.
    expect(conversationIdOfRecord(f.db, record)).toBeUndefined();
    expect(conversationIdOfRecord(f.db, { ...record, workspaceId: WORKSPACE_B })).toBe("conv-b");
  });
});

describe("execution nodes", () => {
  const bindingsOf = (f: TwoWorkspaceFixture, nodeId: string): string[] =>
    (
      f.db
        .prepare(
          "SELECT workspace_id FROM node_workspace_bindings WHERE node_id = ? ORDER BY workspace_id",
        )
        .all(nodeId) as { workspace_id: string }[]
    ).map((row) => row.workspace_id);

  async function registerShared(f: TwoWorkspaceFixture, bindings: string[] = [WORKSPACE_A, WORKSPACE_B]) {
    return f.service.registerNode(
      nodeRegistration(NODE_SHARED, bindings, f.nodeSecretFor(NODE_SHARED)),
    );
  }

  it("refuses an unauthenticated registration, over the real socket", async () => {
    const f = two();
    await registerShared(f);
    expect(bindingsOf(f, NODE_SHARED)).toEqual([WORKSPACE_A, WORKSPACE_B]);

    // No `session.hello`, no scope token, no credential: exactly what any
    // process that can reach the socket could send. `node.register` is the
    // daemon's only unscoped WRITE surface, and it rewrites the node's whole
    // binding set — so unauthenticated access to it is enough to unbind one
    // workspace's node from another workspace, durably, in one frame.
    const socketPath = await f.startServer();
    const client = await ControlPlaneClient.connect(socketPath);
    try {
      const failure = await client
        .request("node.register", nodeRegistration(NODE_SHARED, [WORKSPACE_A]), false)
        .then(() => undefined)
        .catch((error: unknown) => error as ControlPlaneClientError);
      expect(failure?.error.kind).toBe("unauthorized_scope");
      // Uniform: it must not say whether that node id exists.
      expect(failure?.error.message).toBe("node authentication failed");

      const unknownNode = await client
        .request("node.register", nodeRegistration("no-such-node", [WORKSPACE_A]), false)
        .then(() => undefined)
        .catch((error: unknown) => error as ControlPlaneClientError);
      expect(unknownNode?.error.message).toBe(failure?.error.message);
    } finally {
      client.close();
    }

    // B's binding survived, which is the whole point.
    expect(bindingsOf(f, NODE_SHARED)).toEqual([WORKSPACE_A, WORKSPACE_B]);
  });

  it("refuses a registration presenting another node's token, or a client's", async () => {
    const f = two();
    await registerShared(f);

    for (const credential of [
      f.nodeSecretFor(NODE_B_ONLY),
      f.secretFor(WORKSPACE_A),
      `${f.nodeSecretFor(NODE_SHARED)}x`,
    ]) {
      const refusal = await refusalOf(() =>
        f.service.registerNode(nodeRegistration(NODE_SHARED, [WORKSPACE_A], credential)),
      );
      expect(refusal.kind).toBe("unauthorized_scope");
      expect(refusal.message).toBe("node authentication failed");
    }
    expect(bindingsOf(f, NODE_SHARED)).toEqual([WORKSPACE_A, WORKSPACE_B]);
  });

  it("refuses an unauthenticated heartbeat, and never flips the node offline", async () => {
    const f = two();
    await registerShared(f);
    const statusOf = (): string | undefined =>
      (
        f.db.prepare("SELECT status FROM execution_nodes WHERE id = ?").get(NODE_SHARED) as
          | { status: string }
          | undefined
      )?.status;
    expect(statusOf()).toBe("online");

    const beat = { nodeId: NODE_SHARED, status: "offline" as const, activeRunCount: 0, timestamp: 5 };
    for (const credential of [undefined, f.nodeSecretFor(NODE_B_ONLY)]) {
      const refusal = await refusalOf(() =>
        f.service.heartbeatNode({
          ...beat,
          ...(credential === undefined ? {} : { credential }),
        }),
      );
      expect(refusal.kind).toBe("unauthorized_scope");
    }
    // A heartbeat is a write: it flips the node's status for BOTH workspaces at
    // once, so an unauthenticated one takes the node away from a tenant that
    // never spoke to it.
    expect(statusOf()).toBe("online");

    // Its own token still works, so the guard is a boundary and not a wall.
    await expect(
      f.service.heartbeatNode({ ...beat, credential: f.nodeSecretFor(NODE_SHARED) }),
    ).resolves.toMatchObject({ acknowledged: true });
    expect(statusOf()).toBe("offline");
  });

  it("does not let an authenticated node NARROW its own workspace bindings", async () => {
    const f = two();
    await registerShared(f);
    expect(bindingsOf(f, NODE_SHARED)).toEqual([WORKSPACE_A, WORKSPACE_B]);

    // Reconciliation guards WIDENING — a workspace the operator did not bind is
    // stripped from the grant — and said nothing about narrowing, while the
    // write is a DELETE-then-INSERT of the whole set. So a node that simply
    // stopped listing a workspace unbound it, and the workspace that lost its
    // node was never party to the call. Bindings are operator policy; removing
    // one takes the same authority as adding one.
    const outcome = await registerShared(f, [WORKSPACE_A]);
    expect(outcome.accepted).toBe(true);
    expect(bindingsOf(f, NODE_SHARED)).toEqual([WORKSPACE_A, WORKSPACE_B]);

    // What it advertised still decides what it may RUN.
    expect(outcome.grantedWorkspaces).toEqual([WORKSPACE_A]);
  });

  it("shows a workspace only the nodes bound to it", async () => {
    const f = two();
    await registerShared(f);
    await f.service.registerNode(
      nodeRegistration(NODE_B_ONLY, [WORKSPACE_B], f.nodeSecretFor(NODE_B_ONLY)),
    );

    const forA = f.service.readWorkspaceStatus(f.scopeOf(WORKSPACE_A), {
      includeSchedules: false,
    });
    expect(forA.nodes.map((node) => node.nodeId)).toEqual([NODE_SHARED]);
    expect(JSON.stringify(forA)).not.toContain(NODE_B_ONLY);

    // B sees both, so the filter is a boundary and not an empty list.
    const forB = f.service.readWorkspaceStatus(f.scopeOf(WORKSPACE_B), {
      includeSchedules: false,
    });
    expect(forB.nodes.map((node) => node.nodeId).sort()).toEqual([NODE_B_ONLY, NODE_SHARED]);
  });
});

describe("the event stream", () => {
  it("delivers a workspace only its own events, over the real socket", async () => {
    const f = two();
    const socketPath = await f.startServer();
    const client = await ControlPlaneClient.connect(socketPath);
    const seen: { workspaceId: string; taskId: string }[] = [];
    try {
      await client.hello("profile-a", f.secretFor(WORKSPACE_A));
      const arrived = new Promise<void>((resolve) => {
        client.onNotification((event, payload) => {
          if (event !== "task.event") return;
          const record = payload as { workspaceId: string; taskId: string };
          seen.push({ workspaceId: record.workspaceId, taskId: record.taskId });
          if (record.taskId === "task-a") resolve();
        });
      });
      await client.subscribe();

      // B's event first, A's second. Frames on one socket keep their order, so
      // waiting for A's event proves B's was not delivered — no sleeping, and
      // no chance of passing because the assertion ran too early.
      f.events.publish({
        workspaceId: WORKSPACE_B,
        taskId: "task-b",
        type: "TaskCompleted",
        payload: { text: "B's private model output" },
        at: 1,
      });
      f.events.publish({ workspaceId: WORKSPACE_A, taskId: "task-a", type: "RequestAccepted", at: 2 });
      await arrived;

      expect(seen).toEqual([{ workspaceId: WORKSPACE_A, taskId: "task-a" }]);
    } finally {
      client.close();
    }
  });

  it("stops streaming as soon as the session is revoked", async () => {
    const f = two();
    const socketPath = await f.startServer();
    const client = await ControlPlaneClient.connect(socketPath);
    const seen: string[] = [];
    try {
      await client.hello("profile-a", f.secretFor(WORKSPACE_A));
      const first = new Promise<void>((resolve) => {
        client.onNotification((event, payload) => {
          if (event !== "task.event") return;
          seen.push((payload as { taskId: string }).taskId);
          resolve();
        });
      });
      await client.subscribe();
      f.events.publish({ workspaceId: WORKSPACE_A, taskId: "before", type: "RequestAccepted", at: 1 });
      await first;
      expect(seen).toEqual(["before"]);

      // The documented response to a stolen token. It must reach the stream the
      // thief is holding, not merely the requests they can still make.
      const revoked = await client.request("session.revoke", {
        source: "cli",
        profile: "profile-a",
        credential: f.secretFor(WORKSPACE_A),
      });
      expect(revoked).toMatchObject({ workspaceId: WORKSPACE_A, revoked: 1 });

      f.events.publish({
        workspaceId: WORKSPACE_A,
        taskId: "after",
        type: "TaskCompleted",
        payload: { text: "unscrubbed model text" },
        at: 2,
      });

      // Round-trip a request the daemon must answer, which is strictly after
      // the publish above on this connection: if the revoked stream were still
      // live, "after" would already be in `seen`.
      await expect(client.systemInfo()).resolves.toMatchObject({ controlProtocolVersion: 1 });
      expect(seen).toEqual(["before"]);
    } finally {
      client.close();
    }
  });

  it("stops streaming once the workspace is suspended", async () => {
    const f = two();
    const socketPath = await f.startServer();
    const client = await ControlPlaneClient.connect(socketPath);
    const seen: string[] = [];
    try {
      await client.hello("profile-a", f.secretFor(WORKSPACE_A));
      const first = new Promise<void>((resolve) => {
        client.onNotification((event, payload) => {
          if (event !== "task.event") return;
          seen.push((payload as { taskId: string }).taskId);
          resolve();
        });
      });
      await client.subscribe();
      f.events.publish({ workspaceId: WORKSPACE_A, taskId: "before", type: "RequestAccepted", at: 1 });
      await first;

      f.scopes.setWorkspaceStatus(WORKSPACE_A, "suspended");
      f.events.publish({ workspaceId: WORKSPACE_A, taskId: "after", type: "RequestAccepted", at: 2 });
      await expect(client.systemInfo()).resolves.toMatchObject({ controlProtocolVersion: 1 });
      expect(seen).toEqual(["before"]);
    } finally {
      client.close();
    }
  });

  it("requires a scope token at all", async () => {
    const f = two();
    const socketPath = await f.startServer();
    const client = await ControlPlaneClient.connect(socketPath);
    try {
      await expect(client.request("event.subscribe", {}, false)).rejects.toThrow(
        /scope token is required/,
      );
    } finally {
      client.close();
    }
  });

  it("refuses a role that does not carry workspace.status.read", async () => {
    const f = two();
    const socketPath = await f.startServer();
    // `event.subscribe` is a workspace read, and was the one method on this
    // socket with no capability check at all. No ingress binding mints a
    // `worker` token today, so the role is substituted here: the assertion is
    // that the method consults the role, not that this role is reachable.
    const registry = f.scopes as unknown as { resolve: (token: string) => unknown };
    const real = registry.resolve.bind(f.scopes);
    registry.resolve = (token: string) => {
      const scope = real(token) as { workspaceId: string } | undefined;
      return scope === undefined ? undefined : { ...scope, role: "worker", capabilities: [] };
    };
    const client = await ControlPlaneClient.connect(socketPath);
    try {
      await client.hello("profile-a", f.secretFor(WORKSPACE_A));
      await expect(client.request("event.subscribe", {}, true)).rejects.toThrow(
        /lacks workspace.status.read/,
      );
    } finally {
      client.close();
      registry.resolve = real;
    }
  });
});

describe("an oversized response", () => {
  it("answers internal_error instead of taking the daemon down", async () => {
    const f = two();
    const socketPath = await f.startServer();
    const client = await ControlPlaneClient.connect(socketPath);
    try {
      await client.hello("profile-a", f.secretFor(WORKSPACE_A));

      // Rows big enough that `task.list` cannot be encoded in one frame. The
      // protocol caps a single title, so this goes in behind the schema — which
      // is the durable shape the daemon has to survive regardless of how the
      // rows got there (an older daemon, a direct writer, a future field).
      const insert = f.db.prepare(
        `INSERT INTO tasks (id, workspace_id, origin, pipeline, title, intent_json, status,
            temporal_workflow_id, version, created_at, updated_at)
         VALUES (?, ?, 'cli', 'coding', ?, '{"summary":"x","projects":[],"origin":"cli"}',
            'received', ?, 0, ?, ?)`,
      );
      for (let index = 0; index < 4; index += 1) {
        insert.run(
          `task-huge-${index}`,
          WORKSPACE_A,
          "x".repeat(400_000),
          `task/huge-${index}`,
          index,
          index,
        );
      }

      const failure = await client
        .scoped("task.list", { limit: 50 })
        .then(() => undefined)
        .catch((error: unknown) => error as ControlPlaneClientError);
      expect(failure?.error.kind).toBe("internal_error");

      // Still up, still serving, on the same connection and a fresh one.
      await expect(client.systemInfo()).resolves.toMatchObject({ controlProtocolVersion: 1 });
      const second = await ControlPlaneClient.connect(socketPath);
      try {
        await second.hello("profile-b", f.secretFor(WORKSPACE_B));
        await expect(second.scoped("task.list", { limit: 50 })).resolves.toMatchObject({
          tasks: [],
        });
      } finally {
        second.close();
      }
    } finally {
      client.close();
    }
  });

  it("refuses to store a title big enough to wedge the list", async () => {
    const f = two();
    const socketPath = await f.startServer();
    const client = await ControlPlaneClient.connect(socketPath);
    try {
      await client.hello("profile-a", f.secretFor(WORKSPACE_A));
      const failure = await client
        .scoped("task.create", {
          title: "x".repeat(400_000),
          intent: { summary: "big", projects: [], origin: "cli" },
        })
        .then(() => undefined)
        .catch((error: unknown) => error as ControlPlaneClientError);
      expect(failure?.error.kind).toBe("invalid_params");
      expect(f.service.listTasks(f.scopeOf(WORKSPACE_A), { limit: 50 }).tasks).toEqual([]);
    } finally {
      client.close();
    }
  });
});
