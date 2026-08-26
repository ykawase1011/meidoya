import { z } from "zod";
import {
  NodeHeartbeatSchema,
  NodeRegistrationSchema,
} from "@meidoya/node-protocol";
import { scopedParams } from "./scope.js";

/**
 * Caps on free text a caller supplies.
 *
 * A request is limited to MAX_FRAME_BYTES (1 MiB) but a RESPONSE is assembled
 * from many stored rows, so an unbounded field is not a per-request problem: it
 * is a durable one. Three tasks with ~400 KB titles made `task.list` produce a
 * frame the encoder refuses, and the rows outlive every restart, so the failure
 * repeats until somebody edits the database. The daemon now answers
 * `internal_error` instead of dying (server.ts), and these bounds stop the
 * oversized rows being writable in the first place.
 *
 * Generous enough that no legitimate request notices: a title is a line, a
 * summary is a paragraph or two, an answer is a message.
 */
export const MAX_TITLE_LENGTH = 4_096;
export const MAX_SUMMARY_LENGTH = 16_384;
export const MAX_ANSWER_LENGTH = 16_384;
export const MAX_REASON_LENGTH = 4_096;
/** Ids come from us or from the platform; they are never prose. */
export const MAX_ID_LENGTH = 512;

const TaskStatusSchema = z.enum([
  "received",
  "planning",
  "waiting_clarification",
  "waiting_plan_approval",
  "running",
  "verifying",
  "reviewing",
  "waiting_review_approval",
  "waiting_user_input",
  "waiting_side_effect_approval",
  "needs_attention",
  "completed",
  "failed",
  "cancelled",
]);

const PipelineSchema = z.enum([
  "quick",
  "research",
  "coding",
  "scheduled",
  "cross-workspace",
]);

/* ---------------------------------------------------------------- tasks */

export const CreateTaskParamsSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    intent: z.object({
      summary: z.string().min(1).max(MAX_SUMMARY_LENGTH),
      /** Project ids, validated against the resolved scope's workspace. */
      projects: z.array(z.string().max(MAX_ID_LENGTH)).default([]),
      origin: z.enum(["chat", "cli", "schedule", "delegation", "agent"]),
    }),
    pipeline: PipelineSchema.optional(),
    /** Authenticated ingress hint; natural-language details are still validated by the Maid schema. */
    interpretation: z.enum(["auto", "schedule"]).optional(),
    /** Required for a Head Maid coordination task; forbidden for workspace-local tasks. */
    targetWorkspaceIds: z.array(z.string().max(MAX_ID_LENGTH)).min(1).optional(),
    conversationId: z.string().max(MAX_ID_LENGTH).optional(),
    parentTaskId: z.string().max(MAX_ID_LENGTH).optional(),
    idempotencyKey: z.string().max(MAX_ID_LENGTH).optional(),
  })
  .strict();
export type CreateTaskParams = z.infer<typeof CreateTaskParamsSchema>;

export const TaskSummarySchema = z.object({
  taskId: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
  pipeline: PipelineSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const CreateTaskResultSchema = z.object({
  task: TaskSummarySchema,
  temporalWorkflowId: z.string(),
});

export const GetTaskParamsSchema = z.object({ taskId: z.string().max(MAX_ID_LENGTH) }).strict();

export const TaskDetailSchema = TaskSummarySchema.extend({
  intentSummary: z.string(),
  projects: z.array(z.string()),
  openCheckpoint: z
    .object({
      checkpointId: z.string(),
      kind: z.enum([
        "clarification",
        "plan-approval",
        "review-approval",
        "side-effect-approval",
        "limit-exceeded",
      ]),
      prompt: z.string(),
      choices: z.array(z.object({ id: z.string(), label: z.string() })),
    })
    .optional(),
});

export const ListTasksParamsSchema = z
  .object({
    status: z.array(TaskStatusSchema).optional(),
    limit: z.number().int().positive().max(200).default(50),
    cursor: z.string().optional(),
  })
  .strict();

export const ListTasksResultSchema = z.object({
  tasks: z.array(TaskSummarySchema),
  nextCursor: z.string().optional(),
});

export const CancelTaskParamsSchema = z
  .object({
    taskId: z.string().max(MAX_ID_LENGTH),
    reason: z.string().max(MAX_REASON_LENGTH).optional(),
  })
  .strict();

export const CancelTaskResultSchema = z.object({
  taskId: z.string(),
  status: TaskStatusSchema,
});

export const AnswerTaskParamsSchema = z
  .object({
    taskId: z.string().max(MAX_ID_LENGTH),
    questionId: z.string().max(MAX_ID_LENGTH),
    answer: z.string().max(MAX_ANSWER_LENGTH),
  })
  .strict();

export const AnswerTaskResultSchema = z.object({
  taskId: z.string(),
  accepted: z.boolean(),
});

/* ---------------------------------------------------------- checkpoints */

export const AnswerCheckpointParamsSchema = z
  .object({
    checkpointId: z.string().max(MAX_ID_LENGTH),
    decision: z.enum(["approve", "reject", "answer"]),
    choiceId: z.string().max(MAX_ID_LENGTH).optional(),
    answer: z.string().max(MAX_ANSWER_LENGTH).optional(),
    /** Optimistic concurrency: the checkpoint version the caller saw. */
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const AnswerCheckpointResultSchema = z.object({
  checkpointId: z.string(),
  status: z.enum(["approved", "rejected", "answered", "expired"]),
  version: z.number().int().positive(),
});

/* ------------------------------------------------------------ schedules */

export const ScheduleSpecSchema = z.object({
  cron: z.string(),
  timezone: z.string(),
});

export const ScheduleDeliverySchema = z.enum(["always", "on-change"]);
export const ScheduleOverlapSchema = z.enum(["skip", "buffer-one", "allow"]);

/**
 * A schedule's row id is `schedule/<workspaceId>/<name>`, so the name is part
 * of an id space shared by every workspace: a name containing `/` lets one
 * workspace spell another workspace's schedule id. Names are identifiers here,
 * not prose, and this is the shape that keeps the id space unambiguous. The
 * server still checks the row's owner (api.ts) — this is the outer fence.
 */
export const SCHEDULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_SCHEDULE_NAME_LENGTH = 128;

export const CreateScheduleParamsSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_SCHEDULE_NAME_LENGTH)
      .regex(SCHEDULE_NAME, "schedule name must be alphanumeric with . _ -"),
    spec: ScheduleSpecSchema,
    taskTemplate: z.object({
      title: z.string().min(1).max(MAX_TITLE_LENGTH),
      summary: z.string().min(1).max(MAX_SUMMARY_LENGTH),
      projects: z.array(z.string().max(MAX_ID_LENGTH)).default([]),
      pipeline: PipelineSchema.default("scheduled"),
    }),
    delivery: ScheduleDeliverySchema.default("on-change"),
    overlap: ScheduleOverlapSchema.default("skip"),
    enabled: z.boolean().default(false),
  })
  .strict();

export const ScheduleSummarySchema = z.object({
  scheduleId: z.string(),
  name: z.string(),
  spec: ScheduleSpecSchema,
  delivery: ScheduleDeliverySchema,
  overlap: ScheduleOverlapSchema,
  enabled: z.boolean(),
  updatedAt: z.number().int(),
});

export const UpdateScheduleParamsSchema = z
  .object({
    scheduleId: z.string().max(MAX_ID_LENGTH),
    spec: ScheduleSpecSchema.optional(),
    delivery: ScheduleDeliverySchema.optional(),
    overlap: ScheduleOverlapSchema.optional(),
    enabled: z.boolean().optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

export const DeleteScheduleParamsSchema = z
  .object({ scheduleId: z.string().max(MAX_ID_LENGTH) })
  .strict();

export const DeleteScheduleResultSchema = z.object({
  scheduleId: z.string(),
  deleted: z.boolean(),
});

export const ListSchedulesParamsSchema = z
  .object({ includeDisabled: z.boolean().default(true) })
  .strict();

export const ListSchedulesResultSchema = z.object({
  schedules: z.array(ScheduleSummarySchema),
});

/* ------------------------------------------------------- workspace status */

export const ReadWorkspaceStatusParamsSchema = z
  .object({ includeSchedules: z.boolean().default(true) })
  .strict();

const WorkspaceStatusEntrySchema = z.object({
  workspaceId: z.string(),
  activeTasks: z.array(TaskSummarySchema),
  waitingTasks: z.array(TaskSummarySchema),
  schedules: z.array(ScheduleSummarySchema),
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      profile: z.string(),
      status: z.enum(["online", "draining", "offline"]),
      activeRunCount: z.number().int().nonnegative(),
    }),
  ),
});

export const WorkspaceStatusSchema = z.object({
  generatedAt: z.number().int(),
  activeTasks: z.array(TaskSummarySchema),
  waitingTasks: z.array(TaskSummarySchema),
  schedules: z.array(ScheduleSummarySchema),
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      profile: z.string(),
      status: z.enum(["online", "draining", "offline"]),
      activeRunCount: z.number().int().nonnegative(),
    }),
  ),
  /** Present only for Head Maid; contains granted workspaces and no others. */
  workspaces: z.array(WorkspaceStatusEntrySchema).optional(),
});

/* ------------------------------------------------------------ node ops */

/**
 * Proof that the caller IS the node it names.
 *
 * A node registration is a self-report, and 10 section 6 already says the
 * control plane must reconcile that report against local policy rather than
 * trust it. The half that was missing is prior to reconciliation: whether the
 * caller is the node at all. Without it, `nodeId` was an unauthenticated
 * *selector* — any process that could reach the socket could re-register
 * another operator's node, and the re-registration rewrites that node's
 * workspace bindings and its status for every workspace at once.
 *
 * So the node presents a per-node registration token (11 section 7's
 * "Node registration token"), provisioned on disk by the control plane exactly
 * as a local client's session credential is. It is a params field rather than
 * an envelope `scopeToken` because a node is not workspace-scoped: it holds no
 * ingress binding, and there is no workspace whose scope it could be minted
 * under. Optional in the schema and mandatory in the handler: an old node that
 * sends none must be REFUSED, not rejected as a malformed frame, so the
 * operator sees "node authentication failed" and not "invalid params".
 */
const NodeCredentialSchema = z.object({
  credential: z.string().min(1).max(512).optional(),
});

export const RegisterNodeParamsSchema = NodeRegistrationSchema.merge(NodeCredentialSchema);

export const RegisterNodeResultSchema = z.object({
  accepted: z.boolean(),
  /** Capabilities/workspaces after reconciliation with local policy. */
  grantedCapabilities: z.array(z.string()),
  grantedWorkspaces: z.array(z.string()),
  maxConcurrency: z.number().int().positive(),
  heartbeatIntervalMs: z.number().int().positive(),
  rejections: z.array(z.string()),
});

export const NodeHeartbeatParamsSchema = NodeHeartbeatSchema.merge(NodeCredentialSchema);

export const NodeHeartbeatResultSchema = z.object({
  acknowledged: z.boolean(),
  /** Control Plane may ask the node to drain or stop. */
  directive: z.enum(["continue", "drain", "shutdown", "re-register"]),
});

/* ------------------------------------------------------- method registry */

export type MethodSpec = {
  readonly scoped: boolean;
  readonly params: z.ZodTypeAny;
  readonly result: z.ZodTypeAny;
  /** Role capability required, per 04 section 7. */
  readonly capability: string;
};

export const CONTROL_METHODS = {
  "task.create": {
    scoped: true,
    params: scopedParams(CreateTaskParamsSchema),
    result: CreateTaskResultSchema,
    capability: "task.create",
  },
  "task.get": {
    scoped: true,
    params: scopedParams(GetTaskParamsSchema),
    result: TaskDetailSchema,
    capability: "workspace.status.read",
  },
  "task.list": {
    scoped: true,
    params: scopedParams(ListTasksParamsSchema),
    result: ListTasksResultSchema,
    capability: "workspace.status.read",
  },
  "task.cancel": {
    scoped: true,
    params: scopedParams(CancelTaskParamsSchema),
    result: CancelTaskResultSchema,
    capability: "task.cancel",
  },
  "task.answer": {
    scoped: true,
    params: scopedParams(AnswerTaskParamsSchema),
    result: AnswerTaskResultSchema,
    capability: "task.answer",
  },
  "checkpoint.answer": {
    scoped: true,
    params: scopedParams(AnswerCheckpointParamsSchema),
    result: AnswerCheckpointResultSchema,
    capability: "checkpoint.answer",
  },
  "schedule.create": {
    scoped: true,
    params: scopedParams(CreateScheduleParamsSchema),
    result: ScheduleSummarySchema,
    capability: "schedule.manage",
  },
  "schedule.update": {
    scoped: true,
    params: scopedParams(UpdateScheduleParamsSchema),
    result: ScheduleSummarySchema,
    capability: "schedule.manage",
  },
  "schedule.delete": {
    scoped: true,
    params: scopedParams(DeleteScheduleParamsSchema),
    result: DeleteScheduleResultSchema,
    capability: "schedule.manage",
  },
  "schedule.list": {
    scoped: true,
    params: scopedParams(ListSchedulesParamsSchema),
    result: ListSchedulesResultSchema,
    capability: "schedule.manage",
  },
  "workspace.status.read": {
    scoped: true,
    params: scopedParams(ReadWorkspaceStatusParamsSchema),
    result: WorkspaceStatusSchema,
    capability: "workspace.status.read",
  },
  /**
   * `scoped: false` means "carries no WORKSPACE scope token", never "needs no
   * authentication". Both node methods authenticate on the per-node credential
   * in their params, which the handler verifies before it touches a row; see
   * `NodeCredentialSchema` above.
   */
  "node.register": {
    scoped: false,
    params: RegisterNodeParamsSchema,
    result: RegisterNodeResultSchema,
    capability: "node.register",
  },
  "node.heartbeat": {
    scoped: false,
    params: NodeHeartbeatParamsSchema,
    result: NodeHeartbeatResultSchema,
    capability: "node.heartbeat",
  },
} as const satisfies Record<string, MethodSpec>;

export type ControlMethod = keyof typeof CONTROL_METHODS;

export type MethodParams<M extends ControlMethod> = z.infer<
  (typeof CONTROL_METHODS)[M]["params"]
>;
export type MethodResult<M extends ControlMethod> = z.infer<
  (typeof CONTROL_METHODS)[M]["result"]
>;

export function isControlMethod(value: string): value is ControlMethod {
  return Object.prototype.hasOwnProperty.call(CONTROL_METHODS, value);
}

export function isScopedMethod(method: ControlMethod): boolean {
  return CONTROL_METHODS[method].scoped;
}
