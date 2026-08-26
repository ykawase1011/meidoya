import { describe, expect, it } from "vitest";

import { MAX_QUEUED_ANSWERS, recordCheckpointAnswer } from "./answer-queue.js";

type Answer = { checkpointId: string; answer: "approved" | "rejected" | "answered" };

function answer(checkpointId: string, value: Answer["answer"] = "approved"): Answer {
  return { checkpointId, answer: value };
}

describe("the checkpoint answer queue", () => {
  it("keeps an answer for a checkpoint nobody is waiting on yet", () => {
    // The whole reason the queue exists: an answer can beat the workflow's own
    // record of which checkpoint it is waiting on.
    const queue: Answer[] = [];
    recordCheckpointAnswer(queue, answer("cp-1"));
    expect(queue).toEqual([answer("cp-1")]);
  });

  it("replaces an earlier answer for the same checkpoint rather than queueing both", () => {
    const queue: Answer[] = [];
    recordCheckpointAnswer(queue, answer("cp-1", "approved"));
    recordCheckpointAnswer(queue, answer("cp-1", "rejected"));
    expect(queue).toEqual([answer("cp-1", "rejected")]);
  });

  it("keeps the queue in arrival order", () => {
    const queue: Answer[] = [];
    recordCheckpointAnswer(queue, answer("cp-1"));
    recordCheckpointAnswer(queue, answer("cp-2"));
    recordCheckpointAnswer(queue, answer("cp-1", "rejected"));
    expect(queue.map((a) => a.checkpointId)).toEqual(["cp-2", "cp-1"]);
  });

  /**
   * The defect this module exists for: nothing drains the queue except a gate,
   * and a workflow parked in a two-hour Worker activity reaches no gate. Every
   * signal sent to it — redeliveries, mis-addressed answers, a client in a loop
   * — used to live in workflow memory for the whole execution.
   */
  it("never grows past its bound, however many distinct answers arrive", () => {
    const queue: Answer[] = [];
    for (let i = 0; i < MAX_QUEUED_ANSWERS * 100; i += 1) {
      recordCheckpointAnswer(queue, answer(`cp-${i}`));
    }
    expect(queue).toHaveLength(MAX_QUEUED_ANSWERS);
  });

  it("drops the OLDEST when it overflows, because the awaited answer is a recent one", () => {
    const queue: Answer[] = [];
    for (let i = 0; i < 5; i += 1) recordCheckpointAnswer(queue, answer(`cp-${i}`), 3);
    expect(queue.map((a) => a.checkpointId)).toEqual(["cp-2", "cp-3", "cp-4"]);
  });

  it("does not let a flood of redeliveries of ONE answer evict anything", () => {
    const queue: Answer[] = [];
    recordCheckpointAnswer(queue, answer("cp-keep"), 3);
    for (let i = 0; i < 50; i += 1) recordCheckpointAnswer(queue, answer("cp-noise"), 3);
    expect(queue.map((a) => a.checkpointId)).toEqual(["cp-keep", "cp-noise"]);
  });
});
