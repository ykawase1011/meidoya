import { describe, expect, it } from "vitest";
import { ScheduleOverlapPolicy, type Client } from "@temporalio/client";
import { TemporalWorkflowGateway } from "./temporal.js";

describe("TemporalWorkflowGateway execution-node routing", () => {
  it("overwrites any mailbox claim with the node selected by control-plane config", async () => {
    const updates: { name: string; options: unknown }[] = [];
    const client = {
      workflow: {
        start: async () => undefined,
        getHandle: () => ({
          executeUpdate: async (name: string, options: unknown) => {
            updates.push({ name, options });
          },
        }),
      },
      schedule: {},
    } as unknown as Client;
    const gateway = new TemporalWorkflowGateway(client, "personal", () => "trusted-node");

    await gateway.submitRequest("workspace", {
      requestKey: "request-1",
      origin: "cli",
      messageRef: "message:1",
      executionNodeId: "untrusted-claim",
    });

    expect(updates).toEqual([
      {
        name: "submitCliRequest",
        options: {
          args: [
            {
              requestKey: "request-1",
              origin: "cli",
              messageRef: "message:1",
              executionNodeId: "trusted-node",
            },
          ],
        },
      },
    ]);
  });

  it("injects the configured node into Temporal schedule actions", async () => {
    const creates: unknown[] = [];
    const client = {
      workflow: {},
      schedule: {
        create: async (options: unknown) => {
          creates.push(options);
          return {};
        },
      },
    } as unknown as Client;
    const gateway = new TemporalWorkflowGateway(client, "personal", () => "mac-meidoya");

    await gateway.createSchedule({
      workspaceId: "workspace",
      environmentId: "personal",
      name: "usage",
      spec: { kind: "cron", expressions: ["*/10 * * * *"], timezone: "Asia/Tokyo" },
      overlap: ScheduleOverlapPolicy.SKIP,
      messageRef: "schedule:usage",
    });

    const action = (creates[0] as { action: { args: [{ executionNodeId?: string }] } }).action;
    expect(action.args[0].executionNodeId).toBe("mac-meidoya");
  });
});
