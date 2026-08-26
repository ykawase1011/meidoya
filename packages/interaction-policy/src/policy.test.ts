import type { DomainEvent, DomainEventType } from "@meidoya/domain";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERACTION_CONFIG,
  type InteractionConfig,
  resolveInteractionConfig,
} from "./config.js";
import { type OutboxIntent, decideOutboxIntents } from "./policy.js";

const CONFIG = DEFAULT_INTERACTION_CONFIG as InteractionConfig;

let seq = 0;
function event(type: DomainEventType, payload: Record<string, unknown> = {}): DomainEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    taskId: "task_1",
    workspaceId: "ws_1",
    type,
    payload: { conversationId: "conv_1", ...payload },
    createdAt: 1_700_000_000_000 + seq,
  };
}

function reactions(intents: OutboxIntent[], action: "add-reaction" | "remove-reaction"): string[] {
  return intents.flatMap((i) => (i.action === action ? [i.emoji.name] : []));
}

function messageIntents(intents: OutboxIntent[]): OutboxIntent[] {
  return intents.filter(
    (i) => i.action === "post-thread-message" || i.action === "update-message"
  );
}

describe("default event matrix (07 section 2)", () => {
  const cases: Array<[DomainEventType, string[], number]> = [
    ["RequestAccepted", ["eyes"], 0],
    ["TaskStarted", [], 0],
    ["TaskProgressed", [], 0],
    ["WaitingClarification", ["question"], 1],
    ["WaitingPlanApproval", ["memo"], 1],
    ["WaitingReviewApproval", ["mag"], 1],
    ["WaitingSideEffectApproval", ["no_entry"], 1],
    ["TaskNeedsAttention", ["warning"], 1],
    ["MaidResponded", [], 1],
    ["TaskCompleted", ["white_check_mark"], 1],
    ["TaskFailed", ["warning"], 1],
    ["ScheduleNoChange", [], 0],
  ];

  for (const [type, added, messages] of cases) {
    it(`${type} => reactions ${JSON.stringify(added)}, ${messages} message(s)`, () => {
      const intents = decideOutboxIntents(event(type, { summary: "s" }), CONFIG);
      expect(reactions(intents, "add-reaction")).toEqual(added);
      expect(messageIntents(intents)).toHaveLength(messages);
    });
  }

  it("TaskCompleted removes prior reactions before adding the check mark", () => {
    const intents = decideOutboxIntents(event("TaskCompleted", { summary: "done" }), CONFIG);
    expect(reactions(intents, "remove-reaction")).toContain("eyes");
    expect(reactions(intents, "remove-reaction")).toContain("memo");
    const firstAdd = intents.findIndex((i) => i.action === "add-reaction");
    const lastRemove = intents.map((i) => i.action).lastIndexOf("remove-reaction");
    expect(lastRemove).toBeLessThan(firstAdd);
  });

  it("MaidResponded clears progress without adding a completion reaction", () => {
    const intents = decideOutboxIntents(
      event("MaidResponded", { summary: "こんにちは。" }),
      CONFIG,
    );
    expect(reactions(intents, "remove-reaction")).toContain("eyes");
    expect(reactions(intents, "add-reaction")).toEqual([]);
    const [message] = messageIntents(intents);
    expect(message?.action === "post-thread-message" ? message.message.text : "").toBe(
      "こんにちは。",
    );
  });

  it("ScheduleChanged posts one result message", () => {
    const intents = decideOutboxIntents(
      event("ScheduleChanged", { scheduleId: "sched_1", summary: "3 new rows" }),
      CONFIG
    );
    expect(messageIntents(intents)).toHaveLength(1);
  });

  it("ScheduleNoChange emits absolutely nothing even if configured otherwise", () => {
    const config = resolveInteractionConfig({
      schedule_no_change: { reactions: { add: "eyes" }, messages: ["thread"] },
    });
    expect(decideOutboxIntents(event("ScheduleNoChange"), config)).toEqual([]);
  });
});

describe("configurable emoji", () => {
  it("workspace and transport layers override the default matrix", () => {
    const config = resolveInteractionConfig(
      { request_accepted: { reactions: { add: "hourglass" }, messages: [] } },
      { request_accepted: { reactions: { add: "robot_face" } } }
    );
    const intents = decideOutboxIntents(event("RequestAccepted"), config);
    expect(reactions(intents, "add-reaction")).toEqual(["robot_face"]);
    // Untouched events keep the default matrix.
    expect(
      reactions(decideOutboxIntents(event("TaskFailed", { summary: "x" }), config), "add-reaction")
    ).toEqual(["warning"]);
  });
});

describe("no progress spam (07 section 3)", () => {
  it("emits ZERO outbox intents for a full task run's worth of internal events", () => {
    const internal = [
      { kind: "step-started", stepKey: "plan" },
      { kind: "worker-started", worker: "impl-1" },
      { kind: "intermediate-finding", note: "found the bug" },
      { kind: "retry", attempt: 2 },
      { kind: "model-escalation", from: "small", to: "large" },
      { kind: "verifying" },
      { kind: "reviewing" },
      { kind: "vm-boot-wait", node: "lima-1" },
      { kind: "step-started", stepKey: "implement" },
      { kind: "worker-started", worker: "impl-2" },
      { kind: "intermediate-finding", note: "tests pass locally" },
      { kind: "retry", attempt: 3 },
    ];

    const intents = [
      ...decideOutboxIntents(event("TaskStarted"), CONFIG),
      ...internal.flatMap((p) => decideOutboxIntents(event("TaskProgressed", p), CONFIG)),
    ];

    expect(intents).toHaveLength(0);
    expect(messageIntents(intents)).toHaveLength(0);
  });
});

describe("one active checkpoint message (07 section 4)", () => {
  const payload = {
    checkpointId: "cp_456",
    checkpointVersion: 2,
    summary: "Approve this plan?",
  };

  it("uses checkpoint:<id>:<version> as idempotency key", () => {
    const [intent] = messageIntents(
      decideOutboxIntents(event("WaitingPlanApproval", payload), CONFIG)
    );
    expect(intent?.action).toBe("post-thread-message");
    expect(intent?.idempotencyKey).toBe("checkpoint:cp_456:2");
  });

  it("a repeat event for the same version edits instead of posting again", () => {
    const first = messageIntents(decideOutboxIntents(event("WaitingPlanApproval", payload), CONFIG));
    const second = messageIntents(
      decideOutboxIntents(event("WaitingPlanApproval", payload), CONFIG, {
        emittedIdempotencyKeys: first.map((i) => i.idempotencyKey),
      })
    );
    expect(second).toHaveLength(1);
    expect(second[0]?.action).toBe("update-message");
    expect(
      second[0]?.action === "update-message" ? second[0].targetIdempotencyKey : undefined
    ).toBe("checkpoint:cp_456:2");
    expect(second.some((i) => i.action === "post-thread-message")).toBe(false);
  });

  it("a new checkpoint version posts a new message", () => {
    const intents = messageIntents(
      decideOutboxIntents(
        event("WaitingPlanApproval", { ...payload, checkpointVersion: 3 }),
        CONFIG,
        { emittedIdempotencyKeys: ["checkpoint:cp_456:2"] }
      )
    );
    expect(intents[0]?.action).toBe("post-thread-message");
    expect(intents[0]?.idempotencyKey).toBe("checkpoint:cp_456:3");
  });
});

describe("scheduled delivery modes (07 section 8)", () => {
  const changed = () =>
    event("ScheduleChanged", { scheduleId: "sched_1", summary: "same", resultHash: "h1" });

  it("defaults to on-change", () => {
    expect(DEFAULT_INTERACTION_CONFIG.scheduled_delivery).toBe("on-change");
  });

  it("on-change: an identical result produces no external notification", () => {
    const intents = decideOutboxIntents(changed(), CONFIG, {
      scheduledDelivery: "on-change",
      lastScheduleResultHash: "h1",
    });
    expect(intents).toEqual([]);
  });

  it("on-change: a different result notifies", () => {
    const intents = decideOutboxIntents(changed(), CONFIG, {
      scheduledDelivery: "on-change",
      lastScheduleResultHash: "h0",
    });
    expect(messageIntents(intents)).toHaveLength(1);
  });

  it("always: notifies even for an identical result", () => {
    const intents = decideOutboxIntents(changed(), CONFIG, {
      scheduledDelivery: "always",
      lastScheduleResultHash: "h1",
    });
    expect(messageIntents(intents)).toHaveLength(1);
  });

  it("never: notifies for nothing", () => {
    expect(
      decideOutboxIntents(
        event("TaskFailed", { scheduleId: "sched_1", summary: "boom" }),
        CONFIG,
        { scheduledDelivery: "never" }
      )
    ).toEqual([]);
  });

  it("on-failure: silent on success, loud on failure", () => {
    expect(
      decideOutboxIntents(changed(), CONFIG, { scheduledDelivery: "on-failure" })
    ).toEqual([]);
    const failure = decideOutboxIntents(
      event("TaskFailed", { scheduleId: "sched_1", summary: "boom" }),
      CONFIG,
      { scheduledDelivery: "on-failure" }
    );
    expect(messageIntents(failure)).toHaveLength(1);
  });

  it("non-scheduled tasks are unaffected by the schedule delivery mode", () => {
    const config = resolveInteractionConfig({ scheduled_delivery: "never" });
    const intents = decideOutboxIntents(event("TaskCompleted", { summary: "ok" }), config);
    expect(messageIntents(intents)).toHaveLength(1);
  });
});

describe("payload field whitelist (07 section 9)", () => {
  function textOf(intents: OutboxIntent[]): string {
    const [intent] = messageIntents(intents);
    if (intent === undefined) return "";
    return intent.action === "post-thread-message" || intent.action === "update-message"
      ? intent.message.text
      : "";
  }

  it("renders the ACTUAL question of a clarification, not just the heading", () => {
    const text = textOf(
      decideOutboxIntents(
        event("WaitingClarification", { question: "Which branch should I target?" }),
        CONFIG
      )
    );
    expect(text).toContain("Which branch should I target?");
    expect(text).not.toBe("Question");
  });

  it("renders a checkpoint prompt and its choices", () => {
    const text = textOf(
      decideOutboxIntents(
        event("WaitingPlanApproval", {
          checkpointId: "cp_9",
          checkpointVersion: 1,
          prompt: "Approve the migration plan?",
          choices: [
            { id: "approve", label: "Approve" },
            { id: "reject", label: "Reject" },
          ],
        }),
        CONFIG
      )
    );
    expect(text).toContain("Approve the migration plan?");
    expect(text).toContain("[Approve]");
    expect(text).toContain("[Reject]");
  });

  it("renders the failure reason and the attention message", () => {
    expect(
      textOf(decideOutboxIntents(event("TaskFailed", { reason: "out of scope" }), CONFIG))
    ).toContain("out of scope");
    const attention = textOf(
      decideOutboxIntents(
        event("TaskNeedsAttention", { reason: "budget", message: "step limit reached" }),
        CONFIG
      )
    );
    expect(attention).toContain("budget");
    expect(attention).toContain("step limit reached");
  });

  it("still refuses every raw / log field, whichever event carries it", () => {
    const forbidden = {
      rawOutput: "I think maybe I should ...",
      logs: "line1\nline2",
      stdout: "stdout-secret",
      stderr: "stderr-secret",
      diff: "--- a/file\n+++ b/file",
      transcript: "user: hi\nassistant: hi",
      prompt_raw: "SYSTEM: you are ...",
    };
    for (const type of ["WaitingClarification", "TaskCompleted", "TaskFailed"] as const) {
      const text = textOf(
        decideOutboxIntents(event(type, { question: "q?", summary: "s", ...forbidden }), CONFIG)
      );
      for (const value of Object.values(forbidden)) {
        expect(text).not.toContain(value.slice(0, 12));
      }
    }
  });
});

describe("rendering integration", () => {
  it("never leaks raw LLM output or logs from the payload", () => {
    const intents = messageIntents(
      decideOutboxIntents(
        event("TaskCompleted", {
          summary: "Fixed the parser",
          rawOutput: "I think maybe I should ...",
          logs: "line1\nline2",
        }),
        CONFIG
      )
    );
    const text = intents[0]?.action === "post-thread-message" ? intents[0].message.text : "";
    expect(text).toContain("Fixed the parser");
    expect(text).not.toContain("I think maybe");
    expect(text).not.toContain("line1");
  });
});
