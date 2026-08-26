/**
 * 10 section 2: exactly one control queue plus one queue per execution node.
 * Provider, tier and WorkerProfile travel in the activity input, never as queues.
 */

export const CONTROL_TASK_QUEUE = "meidoya/control";

const NODE_QUEUE_PREFIX = "meidoya/node/";
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function nodeTaskQueue(nodeId: string): string {
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new TypeError(`invalid execution node id: ${nodeId}`);
  }
  return `${NODE_QUEUE_PREFIX}${nodeId}`;
}

export function parseNodeTaskQueue(queue: string): string | undefined {
  if (!queue.startsWith(NODE_QUEUE_PREFIX)) return undefined;
  const nodeId = queue.slice(NODE_QUEUE_PREFIX.length);
  return NODE_ID_PATTERN.test(nodeId) ? nodeId : undefined;
}

export function isControlTaskQueue(queue: string): boolean {
  return queue === CONTROL_TASK_QUEUE;
}
