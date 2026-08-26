import type { ProjectId, WorkspaceId } from "@meidoya/domain";

export type IngressChannel = "slack" | "discord" | "cli" | "schedule" | "internal";

export type IngressBinding = {
  channel: IngressChannel;
  accountRef: string;
  externalRef: string;
  workspaceId: WorkspaceId;
  projects: readonly ProjectId[];
};

declare const workspaceScopeBrand: unique symbol;

/**
 * The brand property never exists at runtime; it exists so that no caller
 * outside this module can produce a WorkspaceScope from an object literal
 * (i.e. from LLM output). The only constructors are deriveWorkspaceScope and
 * verifyScopeToken.
 */
export type WorkspaceScope = {
  readonly workspaceId: WorkspaceId;
  readonly projects: readonly ProjectId[];
  readonly issuedAt: number;
  readonly [workspaceScopeBrand]: "workspace-scope";
};

export type ScopeDerivationError = {
  code: "empty-workspace-id" | "empty-project-id" | "duplicate-project";
  message: string;
};

export type ScopeDerivationResult =
  | { ok: true; scope: WorkspaceScope }
  | { ok: false; error: ScopeDerivationError };

export function makeScope(
  workspaceId: WorkspaceId,
  projects: readonly ProjectId[],
  issuedAt: number,
): ScopeDerivationResult {
  if (workspaceId.trim() === "") {
    return {
      ok: false,
      error: { code: "empty-workspace-id", message: "workspaceId must not be empty" },
    };
  }
  const seen = new Set<ProjectId>();
  for (const project of projects) {
    if (project.trim() === "") {
      return {
        ok: false,
        error: { code: "empty-project-id", message: "projectId must not be empty" },
      };
    }
    if (seen.has(project)) {
      return {
        ok: false,
        error: { code: "duplicate-project", message: `duplicate project: ${project}` },
      };
    }
    seen.add(project);
  }
  const scope = {
    workspaceId,
    projects: Object.freeze([...projects].sort()),
    issuedAt,
  } as unknown as WorkspaceScope;
  return { ok: true, scope: Object.freeze(scope) };
}

export function deriveWorkspaceScope(
  binding: IngressBinding,
  issuedAt: number,
): ScopeDerivationResult {
  return makeScope(binding.workspaceId, binding.projects, issuedAt);
}

export function scopeWorkspaceId(scope: WorkspaceScope): WorkspaceId {
  return scope.workspaceId;
}

export function scopeProjects(scope: WorkspaceScope): readonly ProjectId[] {
  return scope.projects;
}

export function scopeAllowsProject(scope: WorkspaceScope, projectId: ProjectId): boolean {
  return scope.projects.includes(projectId);
}
