import { describe, expect, it } from "vitest";
import type { Client } from "@temporalio/client";
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
});
