import { describe, expect, it } from "vitest";

import {
  ScheduleAlreadyRunning,
  ScheduleOverlapPolicy,
  type Client,
} from "@temporalio/client";

import {
  buildScheduleOptions,
  MeidoyaSchedules,
  type MeidoyaScheduleDefinition,
} from "./schedules.js";
import { CONTROL_TASK_QUEUE } from "./task-queues.js";

function definition(
  overrides: Partial<MeidoyaScheduleDefinition> = {},
): MeidoyaScheduleDefinition {
  return {
    workspaceId: "work-it",
    environmentId: "home",
    name: "daily-digest",
    spec: { kind: "cron", expressions: ["0 9 * * *"], timezone: "Asia/Tokyo" },
    overlap: ScheduleOverlapPolicy.SKIP,
    messageRef: "template:daily-digest",
    ...overrides,
  };
}

describe("temporal schedules", () => {
  it("starts a RequestWorkflow with origin=schedule on the control queue", () => {
    const options = buildScheduleOptions(definition());
    expect(options.scheduleId).toBe("schedule/work-it/daily-digest");
    expect(options.action.type).toBe("startWorkflow");
    if (options.action.type !== "startWorkflow") return;
    expect(options.action.workflowType).toBe("RequestWorkflow");
    expect(options.action.taskQueue).toBe(CONTROL_TASK_QUEUE);
    const args = options.action.args as [
      { origin: string; workspaceId: string; requestKey: string; executionNodeId?: string },
    ];
    expect(args[0].origin).toBe("schedule");
    expect(args[0].workspaceId).toBe("work-it");
    expect(args[0].requestKey).toBe("daily-digest");
  });

  it("carries the control-plane-selected execution node into scheduled requests", () => {
    const options = buildScheduleOptions(definition({ executionNodeId: "mac-meidoya" }));
    if (options.action.type !== "startWorkflow") return;
    const args = options.action.args as [{ executionNodeId?: string }];
    expect(args[0].executionNodeId).toBe("mac-meidoya");
  });

  it("delegates overlap policy and pause state to Temporal", () => {
    const options = buildScheduleOptions(definition({ overlap: ScheduleOverlapPolicy.BUFFER_ALL, paused: true }));
    expect(options.policies?.overlap).toBe(ScheduleOverlapPolicy.BUFFER_ALL);
    expect(options.state?.paused).toBe(true);
  });

  it("supports interval specs", () => {
    const options = buildScheduleOptions(
      definition({ spec: { kind: "interval", every: "30 minutes" } }),
    );
    expect(options.spec).toEqual({ intervals: [{ every: "30 minutes" }] });
  });

  it("updates an existing Temporal schedule so activity retries are idempotent", async () => {
    let updated: unknown;
    const handle = {
      async update(updateFn: (previous: never) => unknown) {
        updated = updateFn({} as never);
      },
    };
    const client = {
      schedule: {
        async create() {
          throw new ScheduleAlreadyRunning("already exists", "schedule/work-it/daily-digest");
        },
        getHandle() {
          return handle;
        },
      },
    } as unknown as Client;

    await expect(new MeidoyaSchedules(client).create(definition({ paused: true }))).resolves.toBe(
      handle,
    );
    expect(updated).toMatchObject({
      spec: { cronExpressions: ["0 9 * * *"], timezone: "Asia/Tokyo" },
      state: { paused: true },
    });
  });
});
