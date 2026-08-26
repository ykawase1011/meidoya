import type {
  AdminCommand,
  MaidDecision,
  MaidReply,
  PipelineName,
  TaskBrief,
  TaskId,
  WorkspaceKind,
} from "@meidoya/domain";

import type { TaskLane } from "./state-machine.js";

export type IntakeContext = {
  workspaceKind: WorkspaceKind;
  defaultPipeline: PipelineName;
  /** Explicit pipeline chosen by the requester or schedule template. */
  pipelineHint?: PipelineName;
};

export type IntakeOutcome =
  | { kind: "administrative"; command: AdminCommand }
  | { kind: "respond"; reply: MaidReply }
  | { kind: "start-task"; lane: TaskLane; pipeline: PipelineName; brief: TaskBrief }
  | { kind: "answer-checkpoint"; taskId: TaskId; questionId: string; answer: string }
  | { kind: "ask-user"; question: string }
  | { kind: "rejected"; reason: string };

/**
 * Pipeline choice is control-plane logic, not an LLM free choice: the Maid only
 * classifies the request lane (05 section 1).
 */
export function selectPipeline(brief: TaskBrief, ctx: IntakeContext): PipelineName {
  if (ctx.pipelineHint) return ctx.pipelineHint;
  if (brief.origin === "schedule") return "scheduled";
  if (ctx.workspaceKind === "coordination") return "cross-workspace";
  return ctx.defaultPipeline;
}

export function handleMaidDecision(decision: MaidDecision, ctx: IntakeContext): IntakeOutcome {
  switch (decision.type) {
    case "administrative":
      return { kind: "administrative", command: decision.command };
    case "respond":
      return { kind: "respond", reply: decision.reply };
    case "quick":
      return { kind: "start-task", lane: "quick", pipeline: "quick", brief: decision.brief };
    case "durable":
      return {
        kind: "start-task",
        lane: "durable",
        pipeline: selectPipeline(decision.brief, ctx),
        brief: decision.brief,
      };
    case "answer_question":
      return {
        kind: "answer-checkpoint",
        taskId: decision.taskId,
        questionId: decision.questionId,
        answer: decision.answer,
      };
    case "ask_user":
      return { kind: "ask-user", question: decision.question };
    case "out_of_scope":
      return { kind: "rejected", reason: decision.reason };
  }
}
