import { describe, expect, it } from "vitest";
import { SerialWriteQueue } from "./write-queue.js";
import { successPredecessors } from "./steps.js";
import { getPipeline } from "@meidoya/task-engine";

describe("serial write queue", () => {
  it("runs jobs one at a time in submission order", async () => {
    const queue = new SerialWriteQueue();
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const job = (name: string, delayMs: number) =>
      queue.enqueue(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(name);
        concurrent -= 1;
      });

    await Promise.all([job("a", 20), job("b", 1), job("c", 5)]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(maxConcurrent).toBe(1);
  });

  it("keeps draining after a failed job", async () => {
    const queue = new SerialWriteQueue();
    const failed = queue.enqueue(() => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    await expect(queue.enqueue(() => "ok")).resolves.toBe("ok");
    await queue.close();
    await expect(queue.enqueue(() => "late")).rejects.toThrow(/closed/);
  });
});

describe("pipeline step inference", () => {
  it("walks back the coding pipeline's success edges", () => {
    expect(successPredecessors(getPipeline("coding"), "verify")).toContain("implement");
    expect(successPredecessors(getPipeline("coding"), "review")).toEqual(
      expect.arrayContaining(["verify", "implement"]),
    );
  });

  it("stops at a step with no unique success predecessor", () => {
    expect(successPredecessors(getPipeline("coding"), "clarify")).toEqual([]);
  });
});
