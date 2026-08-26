import type { NativeConnection, WorkerOptions } from "@temporalio/worker";

import type { Activities } from "./activities.js";
import { CONTROL_TASK_QUEUE, nodeTaskQueue } from "./task-queues.js";

export type ControlWorkerConfig = {
  connection?: NativeConnection;
  namespace: string;
  activities: Activities;
  workflowsPath: string;
  maxConcurrentActivityTaskExecutions?: number;
};

/** Control workers run every workflow plus the SQLite/notification activities. */
export function controlWorkerOptions(config: ControlWorkerConfig): WorkerOptions {
  return {
    ...(config.connection !== undefined ? { connection: config.connection } : {}),
    namespace: config.namespace,
    taskQueue: CONTROL_TASK_QUEUE,
    workflowsPath: config.workflowsPath,
    activities: config.activities,
    ...(config.maxConcurrentActivityTaskExecutions !== undefined
      ? { maxConcurrentActivityTaskExecutions: config.maxConcurrentActivityTaskExecutions }
      : {}),
  };
}

export type NodeWorkerConfig = {
  connection?: NativeConnection;
  namespace: string;
  executionNodeId: string;
  activities: Pick<Activities, "runWorkerStep" | "runReview" | "runVerification">;
  maxConcurrency: number;
};

/**
 * Execution-node workers run only Worker/reviewer and verification activities; they host no
 * workflow code and hold no SQLite access (10 section 2, 08 section 8).
 */
export function nodeWorkerOptions(config: NodeWorkerConfig): WorkerOptions {
  return {
    ...(config.connection !== undefined ? { connection: config.connection } : {}),
    namespace: config.namespace,
    taskQueue: nodeTaskQueue(config.executionNodeId),
    activities: config.activities,
    maxConcurrentActivityTaskExecutions: config.maxConcurrency,
  };
}
