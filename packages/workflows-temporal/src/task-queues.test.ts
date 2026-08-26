import { describe, expect, it } from "vitest";

import {
  CONTROL_TASK_QUEUE,
  isControlTaskQueue,
  nodeTaskQueue,
  parseNodeTaskQueue,
} from "./task-queues.js";
import {
  crossWorkspaceWorkflowId,
  environmentWorkflowId,
  headMaidWorkflowId,
  maidWorkflowId,
  requestWorkflowId,
  scheduleId,
  taskWorkflowId,
} from "./workflow-ids.js";
import { agentRunKey, checkpointKey, notificationKey } from "./idempotency.js";

describe("task queue routing", () => {
  it("uses one control queue and one queue per node", () => {
    expect(CONTROL_TASK_QUEUE).toBe("meidoya/control");
    expect(nodeTaskQueue("mac-main")).toBe("meidoya/node/mac-main");
    expect(nodeTaskQueue("lima-work-it")).toBe("meidoya/node/lima-work-it");
    expect(isControlTaskQueue(nodeTaskQueue("mac-main"))).toBe(false);
  });

  it("round-trips a node id", () => {
    expect(parseNodeTaskQueue(nodeTaskQueue("lima-grammarxiv"))).toBe("lima-grammarxiv");
    expect(parseNodeTaskQueue(CONTROL_TASK_QUEUE)).toBeUndefined();
    expect(parseNodeTaskQueue("meidoya/node/Bad Node")).toBeUndefined();
  });

  it("rejects queue names that would encode a role, model or profile", () => {
    expect(() => nodeTaskQueue("worker/reviewer")).toThrow();
    expect(() => nodeTaskQueue("codex:high")).toThrow();
  });
});

describe("workflow ids", () => {
  it("matches the documented shapes", () => {
    expect(maidWorkflowId("home", "work-it")).toBe("maid/home/work-it");
    expect(headMaidWorkflowId("home")).toBe("head-maid/home");
    expect(environmentWorkflowId("home")).toBe("environment/home");
    expect(taskWorkflowId("t-1")).toBe("task/t-1");
    expect(requestWorkflowId("work-it", "r-1")).toBe("request/work-it/r-1");
    expect(crossWorkspaceWorkflowId("t-1")).toBe("cross-workspace/t-1");
    expect(scheduleId("work-it", "daily")).toBe("schedule/work-it/daily");
  });
});

describe("idempotency keys", () => {
  it("is stable per attempt and version", () => {
    expect(agentRunKey("t1", "implement", 2)).toBe("run:t1:implement:2");
    expect(agentRunKey("t1", "implement", 2)).toBe(agentRunKey("t1", "implement", 2));
    expect(checkpointKey("c1", 3)).toBe("checkpoint:c1:3");
    expect(notificationKey("e1", "post-thread-message")).toBe(
      "notification:e1:post-thread-message",
    );
  });
});
