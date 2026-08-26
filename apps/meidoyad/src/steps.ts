import type { PipelineName } from "@meidoya/domain";
import { getPipeline, type PipelineDefinition } from "@meidoya/task-engine";
import type { SqliteTaskRepository } from "./repository.js";

/**
 * Steps that must be terminal before a task may complete are read back from
 * SQLite, but execution nodes never write SQLite (08 section 8). The control
 * plane therefore records a step from the fixed pipeline graph: reaching a
 * control-plane step means its unique success-predecessors already succeeded.
 */
export function successPredecessors(
  pipeline: PipelineDefinition,
  stepKey: string,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([stepKey]);
  let current = stepKey;
  for (;;) {
    // Several steps can lead to the same successor (implement and fix both feed
    // verify); only the required one is evidence the completion check needs.
    const previous = Object.values(pipeline.steps).filter(
      (s) => s.next.success === current && s.required,
    );
    const only = previous.length === 1 ? previous[0] : undefined;
    if (only === undefined || seen.has(only.key)) return chain;
    seen.add(only.key);
    chain.push(only.key);
    current = only.key;
  }
}

export type StepStatus = "succeeded" | "failed";

export async function recordStepProgress(
  repository: SqliteTaskRepository,
  taskId: string,
  stepKey: string,
  status: StepStatus,
): Promise<void> {
  const task = repository.loadTaskSync(taskId);
  if (task === undefined) return;
  const pipeline = getPipeline(task.pipeline as PipelineName);
  const step = pipeline.steps[stepKey];
  if (step === undefined) return;

  const keys: { key: string; kind: string; status: StepStatus }[] = [
    { key: step.key, kind: step.kind, status },
  ];
  if (status === "succeeded") {
    for (const previous of successPredecessors(pipeline, stepKey)) {
      const record = pipeline.steps[previous];
      if (record !== undefined) {
        keys.push({ key: record.key, kind: record.kind, status: "succeeded" });
      }
    }
  }

  for (const entry of keys) {
    const existing = repository
      .listStepsSync(taskId)
      .find((candidate) => candidate.stepKey === entry.key);
    await repository.upsertStep({
      taskId,
      stepKey: entry.key,
      stepKind: entry.kind,
      status: entry.status,
      visitCount: (existing?.visitCount ?? 0) + 1,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
    });
  }
}
