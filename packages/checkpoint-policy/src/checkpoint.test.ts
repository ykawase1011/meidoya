import { describe, expect, it } from "vitest";
import {
  applyCheckpointEvent,
  checkpointSignalAnswer,
  isCheckpointResolved,
  openCheckpoint,
  planCheckpointDelivery,
} from "./checkpoint.js";

function pendingApproval() {
  return openCheckpoint({
    id: "cp-1",
    taskId: "task-1",
    kind: "plan-approval",
    prompt: "Approve the plan?",
  });
}

describe("checkpoint state transitions", () => {
  it("opens pending at version 1", () => {
    const checkpoint = pendingApproval();
    expect(checkpoint.status).toBe("pending");
    expect(checkpoint.version).toBe(1);
    expect(isCheckpointResolved(checkpoint)).toBe(false);
  });

  it("approves and rejects approval checkpoints, bumping the version", () => {
    const approved = applyCheckpointEvent(pendingApproval(), { type: "approve" });
    expect(approved).toEqual({
      ok: true,
      checkpoint: { ...pendingApproval(), status: "approved", version: 2 },
    });
    const rejected = applyCheckpointEvent(pendingApproval(), { type: "reject" });
    expect(rejected.ok && rejected.checkpoint.status).toBe("rejected");
  });

  it("refuses a second transition once resolved", () => {
    const first = applyCheckpointEvent(pendingApproval(), { type: "approve" });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(applyCheckpointEvent(first.checkpoint, { type: "reject" })).toEqual({
        ok: false,
        error: "not-pending",
      });
    }
  });

  it("refuses approve on a clarification checkpoint", () => {
    const clarification = openCheckpoint({
      id: "cp-2",
      taskId: "task-1",
      kind: "clarification",
      prompt: "Which repository?",
    });
    expect(applyCheckpointEvent(clarification, { type: "approve" })).toEqual({
      ok: false,
      error: "event-not-valid-for-kind",
    });
    const answered = applyCheckpointEvent(clarification, { type: "answer", text: "grammarxiv" });
    expect(answered.ok && answered.checkpoint.status).toBe("answered");
  });

  it("refuses answer on an approval checkpoint", () => {
    expect(applyCheckpointEvent(pendingApproval(), { type: "answer" })).toEqual({
      ok: false,
      error: "event-not-valid-for-kind",
    });
  });

  it("validates choices for limit-exceeded checkpoints", () => {
    const limit = openCheckpoint({
      id: "cp-3",
      taskId: "task-1",
      kind: "limit-exceeded",
      prompt: "Task paused: execution limit reached.",
      choices: [
        { id: "extend-once", label: "Extend budget once" },
        { id: "cancel", label: "Cancel" },
      ],
    });
    expect(applyCheckpointEvent(limit, { type: "answer" })).toEqual({
      ok: false,
      error: "choice-required",
    });
    expect(applyCheckpointEvent(limit, { type: "answer", choiceId: "extend-twice" })).toEqual({
      ok: false,
      error: "unknown-choice",
    });
    const answered = applyCheckpointEvent(limit, { type: "answer", choiceId: "cancel" });
    expect(answered.ok && answered.checkpoint.status).toBe("answered");
  });

  it("expires any pending checkpoint", () => {
    const expired = applyCheckpointEvent(pendingApproval(), { type: "expire" });
    expect(expired.ok && expired.checkpoint.status).toBe("expired");
  });
});

describe("checkpoint delivery", () => {
  it("resolves a pending checkpoint however the signal flag reads", () => {
    expect(planCheckpointDelivery({ status: "pending", signalled: false })).toEqual({
      action: "resolve",
    });
    expect(planCheckpointDelivery({ status: "pending", signalled: true })).toEqual({
      action: "resolve",
    });
  });

  it("re-delivers a committed answer that was never signalled", () => {
    for (const status of ["approved", "rejected", "answered", "expired"] as const) {
      expect(planCheckpointDelivery({ status, signalled: false })).toEqual({
        action: "redeliver",
      });
    }
  });

  it("treats a second answer to a delivered checkpoint as a conflict", () => {
    for (const status of ["approved", "rejected", "answered", "expired"] as const) {
      expect(planCheckpointDelivery({ status, signalled: true })).toEqual({ action: "conflict" });
    }
  });

  it("maps a resolution to the signal answer, and has none for pending or expired", () => {
    expect(checkpointSignalAnswer("approved")).toBe("approved");
    expect(checkpointSignalAnswer("rejected")).toBe("rejected");
    expect(checkpointSignalAnswer("answered")).toBe("answered");
    expect(checkpointSignalAnswer("pending")).toBeUndefined();
    expect(checkpointSignalAnswer("expired")).toBeUndefined();
  });
});
