import type { z } from "zod";
import type { NoWorkspaceId, ScopeToken } from "./scope.js";
import type {
  AnswerCheckpointParamsSchema,
  AnswerCheckpointResultSchema,
  AnswerTaskParamsSchema,
  AnswerTaskResultSchema,
  CancelTaskParamsSchema,
  CancelTaskResultSchema,
  CreateScheduleParamsSchema,
  CreateTaskParamsSchema,
  CreateTaskResultSchema,
  DeleteScheduleParamsSchema,
  DeleteScheduleResultSchema,
  GetTaskParamsSchema,
  ListSchedulesParamsSchema,
  ListSchedulesResultSchema,
  ListTasksParamsSchema,
  ListTasksResultSchema,
  NodeHeartbeatResultSchema,
  ReadWorkspaceStatusParamsSchema,
  RegisterNodeResultSchema,
  ScheduleSummarySchema,
  TaskDetailSchema,
  UpdateScheduleParamsSchema,
  WorkspaceStatusSchema,
} from "./methods.js";
import type { NodeHeartbeat, NodeRegistration } from "@meidoya/node-protocol";

type In<S extends z.ZodTypeAny> = NoWorkspaceId<z.input<S>>;
type Out<S extends z.ZodTypeAny> = z.infer<S>;

/**
 * Control Plane API as seen by CLI / chat gateway / Temporal activities.
 * Workspace identity is carried only by the scope token argument: every
 * scoped params type makes `workspaceId` un-passable.
 */
export interface ControlPlaneApi {
  createTask(
    scope: ScopeToken,
    params: In<typeof CreateTaskParamsSchema>,
  ): Promise<Out<typeof CreateTaskResultSchema>>;

  getTask(
    scope: ScopeToken,
    params: In<typeof GetTaskParamsSchema>,
  ): Promise<Out<typeof TaskDetailSchema>>;

  listTasks(
    scope: ScopeToken,
    params: In<typeof ListTasksParamsSchema>,
  ): Promise<Out<typeof ListTasksResultSchema>>;

  cancelTask(
    scope: ScopeToken,
    params: In<typeof CancelTaskParamsSchema>,
  ): Promise<Out<typeof CancelTaskResultSchema>>;

  answerTask(
    scope: ScopeToken,
    params: In<typeof AnswerTaskParamsSchema>,
  ): Promise<Out<typeof AnswerTaskResultSchema>>;

  answerCheckpoint(
    scope: ScopeToken,
    params: In<typeof AnswerCheckpointParamsSchema>,
  ): Promise<Out<typeof AnswerCheckpointResultSchema>>;

  createSchedule(
    scope: ScopeToken,
    params: In<typeof CreateScheduleParamsSchema>,
  ): Promise<Out<typeof ScheduleSummarySchema>>;

  updateSchedule(
    scope: ScopeToken,
    params: In<typeof UpdateScheduleParamsSchema>,
  ): Promise<Out<typeof ScheduleSummarySchema>>;

  deleteSchedule(
    scope: ScopeToken,
    params: In<typeof DeleteScheduleParamsSchema>,
  ): Promise<Out<typeof DeleteScheduleResultSchema>>;

  listSchedules(
    scope: ScopeToken,
    params: In<typeof ListSchedulesParamsSchema>,
  ): Promise<Out<typeof ListSchedulesResultSchema>>;

  readWorkspaceStatus(
    scope: ScopeToken,
    params: In<typeof ReadWorkspaceStatusParamsSchema>,
  ): Promise<Out<typeof WorkspaceStatusSchema>>;

  /**
   * Node operations are not workspace-scoped: a node holds no ingress binding,
   * so there is no workspace whose scope token it could carry. They are not
   * unauthenticated either — `credential` is the node's own registration token,
   * and the control plane refuses both calls without it. It is optional in the
   * type only so an outdated node gets a refusal it can read rather than a
   * malformed-params error.
   */
  registerNode(
    registration: NodeRegistration & { credential?: string },
  ): Promise<Out<typeof RegisterNodeResultSchema>>;

  heartbeatNode(
    heartbeat: NodeHeartbeat & { credential?: string },
  ): Promise<Out<typeof NodeHeartbeatResultSchema>>;
}
