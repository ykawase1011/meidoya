import type {
  ConversationId,
  PipelineName,
  ProjectId,
  ScopeToken,
  TaskOrigin,
  WorkspaceId,
} from "@meidoya/domain";
import { scopeAllowsProject, type WorkspaceScope } from "./scope.js";
import {
  verifyScopeToken,
  type ScopeSecret,
  type ScopeTokenRejection,
  type VerifyOptions,
} from "./token.js";

export type ScopedApiErrorCode =
  | "invalid-scope-token"
  | "workspace-id-in-input"
  | "project-out-of-scope";

export type ScopedApiError = {
  code: ScopedApiErrorCode;
  message: string;
  tokenRejection?: ScopeTokenRejection;
};

export type ScopedApiResult<T> = { ok: true; value: T } | { ok: false; error: ScopedApiError };

/** Makes `workspaceId` unrepresentable in caller-supplied input at the type level. */
export type WithoutWorkspaceId<T> = T & { workspaceId?: never };

export type ScopedCreateTaskInput = {
  title: string;
  summary: string;
  projects: readonly ProjectId[];
  origin: TaskOrigin;
  pipeline: PipelineName;
  conversationId?: ConversationId;
};

export type ScopedCreateTaskCommand = ScopedCreateTaskInput & {
  workspaceId: WorkspaceId;
};

export type CreateTaskHandler<T> = (command: ScopedCreateTaskCommand) => T;

export type ScopedApiConfig<T> = {
  secret: ScopeSecret;
  createTask: CreateTaskHandler<T>;
  /** Domain and clock are mandatory: there is no unbounded verification mode. */
  verify: VerifyOptions;
};

export type ScopedApi<T> = {
  createTask(
    scopeToken: ScopeToken,
    input: WithoutWorkspaceId<ScopedCreateTaskInput>,
  ): ScopedApiResult<T>;
};

function hasWorkspaceIdField(input: object): boolean {
  return "workspaceId" in input || "workspace_id" in input;
}

export function resolveScope(
  scopeToken: ScopeToken,
  secret: ScopeSecret,
  options: VerifyOptions,
): ScopedApiResult<WorkspaceScope> {
  const verified = verifyScopeToken(scopeToken, secret, options);
  if (!verified.ok) {
    return {
      ok: false,
      error: {
        code: "invalid-scope-token",
        message: "scope token could not be verified",
        tokenRejection: verified.reason,
      },
    };
  }
  return { ok: true, value: verified.scope };
}

export function createScopedApi<T>(config: ScopedApiConfig<T>): ScopedApi<T> {
  return {
    createTask(scopeToken, input) {
      if (hasWorkspaceIdField(input)) {
        return {
          ok: false,
          error: {
            code: "workspace-id-in-input",
            message: "workspaceId must not be supplied by the caller; it comes from the scope token",
          },
        };
      }
      const scope = resolveScope(scopeToken, config.secret, config.verify);
      if (!scope.ok) {
        return scope;
      }
      for (const project of input.projects) {
        if (!scopeAllowsProject(scope.value, project)) {
          return {
            ok: false,
            error: {
              code: "project-out-of-scope",
              message: `project is not in the bound workspace scope: ${project}`,
            },
          };
        }
      }
      const command: ScopedCreateTaskCommand = {
        title: input.title,
        summary: input.summary,
        projects: [...input.projects],
        origin: input.origin,
        pipeline: input.pipeline,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        workspaceId: scope.value.workspaceId,
      };
      return { ok: true, value: config.createTask(command) };
    },
  };
}
