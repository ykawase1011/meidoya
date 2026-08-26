import { createHash } from "node:crypto";

import type { ActivityDependencies } from "@meidoya/workflows-temporal";
import type { DelegationRegistry } from "@meidoya/workspace-scope";

import type { ResolvedWorkspace } from "./config.js";
import type { SqliteTaskRepository } from "./repository.js";
import type { WorkflowGateway } from "./temporal.js";

export function createDelegationPort(options: {
  registry: DelegationRegistry;
  workspaces: ReadonlyMap<string, ResolvedWorkspace>;
  repository: SqliteTaskRepository;
  gateway: WorkflowGateway;
  now?: () => number;
}): ActivityDependencies["delegations"] {
  const now = options.now ?? (() => Date.now());
  return {
    async create(input) {
      const delegation = options.registry.check(
        "global",
        input.targetWorkspaceId,
        "task.delegate",
      );
      if (delegation.outcome === "not-found") {
        throw new Error("delegation target not found");
      }
      if (delegation.outcome === "capability-denied") {
        throw new Error("delegation target does not grant task.delegate");
      }
      const summaries = options.registry.check(
        "global",
        input.targetWorkspaceId,
        "task-summary.read",
      );
      if (summaries.outcome !== "granted") {
        throw new Error("delegation target does not grant task-summary.read");
      }

      const workspace = options.workspaces.get(input.targetWorkspaceId);
      if (workspace === undefined || workspace.kind !== "execution") {
        throw new Error("delegation target not found");
      }
      const requestKey = createHash("sha256")
        .update(input.idempotencyKey)
        .digest("hex")
        .slice(0, 32);
      const childTaskId = `task-${requestKey}`;
      const existing = options.repository.loadTaskSync(childTaskId);
      if (existing !== undefined && existing.workspaceId !== input.targetWorkspaceId) {
        throw new Error("delegation target not found");
      }
      if (existing === undefined) {
        await options.repository.createTask({
          taskId: childTaskId,
          workspaceId: input.targetWorkspaceId,
          parentTaskId: input.parentTaskId,
          origin: "delegation",
          pipeline: workspace.policy.requestPolicy.defaultPipeline,
          title: input.brief.summary,
          intent: input.brief,
          temporalWorkflowId: `task/${childTaskId}`,
          now: now(),
        });
        await options.repository.appendTaskEvent({
          taskId: childTaskId,
          eventType: "RequestAccepted",
          idempotencyKey: `request:${requestKey}`,
          payload: input.brief,
        });
      }

      const maidWorkflowId = await options.gateway.submitDelegation(input.targetWorkspaceId, {
        requestKey,
        origin: "delegation",
        messageRef: `task_event:request:${requestKey}`,
        delegation: {
          brief: input.brief,
          childTaskId,
          rootTaskId: input.parentTaskId,
          coordinationWorkflowId: input.coordinationWorkflowId,
        },
      });
      return { childTaskId, maidWorkflowId };
    },
  };
}
