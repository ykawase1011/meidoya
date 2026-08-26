import type { AgentRunScope, RunRequest } from "@meidoya/node-protocol";
import type { FilesystemSandbox } from "@meidoya/execution-native";
import type { RunAssignmentPort } from "./runner.js";
import {
  assertCapability,
  projectMode,
  REPO_WRITE_CAPABILITY,
  ScopeViolationError,
} from "./run-scope.js";

export type WorkspaceLayout = {
  /** workspaceId -> projectId -> absolute path, validated at config load. */
  projects: Record<string, Record<string, string>>;
  /** workspaceId -> taskId -> worktree path, for task-scoped runs. */
  worktrees?: Record<string, Record<string, string>>;
};

/**
 * Resolves the fixed per-worker cwd, narrowed at run time to the target
 * project or task worktree, and re-checked against the sandbox.
 */
export class SandboxRunAssignment implements RunAssignmentPort {
  constructor(
    private readonly sandbox: FilesystemSandbox,
    private readonly layout: WorkspaceLayout,
    /** Scopes handed down by the Control Plane, keyed by runId. */
    private readonly scopes: Map<string, AgentRunScope>,
  ) {}

  authoritativeScope(request: RunRequest): AgentRunScope {
    const scope = this.scopes.get(request.runId);
    if (scope === undefined) {
      throw new ScopeViolationError(
        `no Control Plane scope for run ${request.runId}; refusing to trust the request payload`,
      );
    }
    return scope;
  }

  workingDirectory(request: RunRequest, scope: AgentRunScope): string {
    return this.sandbox.narrowTo(this.target(request, scope)).cwd;
  }

  /**
   * Re-resolve the configured path at spawn time and confirm it still lands on
   * the directory `workingDirectory` chose. Everything between the two calls —
   * queueing behind the concurrency limiter, the runtime lookup — is a window
   * in which the project directory, or any ancestor of it, could be replaced by
   * a symlink pointing outside the allowed roots. The first resolve alone only
   * proves the path was safe then; this proves it is still the same path now.
   */
  verifyWorkingDirectory(
    request: RunRequest,
    scope: AgentRunScope,
    cwd: string,
  ): string {
    return this.sandbox.verifyStillAllowed(this.target(request, scope), cwd, {
      mustExist: true,
    }).path;
  }

  /**
   * Picks the directory for this run and authorises it.
   *
   * The write-mode grant and the `repo.write` capability are computed by
   * different code paths upstream (the Control Plane's grant and this node's
   * local policy, intersected). The node does not assume they agree: a project
   * offered in write mode that is not backed by the capability is a scope we
   * cannot trust, so the run is refused rather than given the more permissive
   * of the two readings.
   */
  private target(request: RunRequest, scope: AgentRunScope): string {
    const first = scope.projectAccess[0];
    if (first === undefined) {
      throw new ScopeViolationError(
        `run ${request.runId} has no project access; nothing to narrow to`,
      );
    }
    if (projectMode(scope, first.projectId) === "write") {
      assertCapability(scope, REPO_WRITE_CAPABILITY);
    }

    const worktree =
      this.layout.worktrees?.[scope.workspaceId]?.[request.taskId];
    if (worktree !== undefined) {
      return worktree;
    }
    const projectPath = this.layout.projects[scope.workspaceId]?.[first.projectId];
    if (projectPath === undefined) {
      throw new ScopeViolationError(
        `project ${first.projectId} is not bound on this node`,
      );
    }
    return projectPath;
  }
}
