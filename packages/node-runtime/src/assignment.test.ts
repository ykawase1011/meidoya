import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemSandbox } from "@meidoya/execution-native";
import type { AgentRunScope, RunRequest } from "@meidoya/node-protocol";
import { SandboxRunAssignment } from "./assignment.js";
import { ScopeViolationError } from "./run-scope.js";

let base: string;
let roots: string;
let sandbox: FilesystemSandbox;

const scope: AgentRunScope = {
  workspaceId: "work-it",
  projectAccess: [{ projectId: "product-a", mode: "write" }],
  capabilities: ["repo.write"],
  networkPolicy: "restricted",
  sideEffectPolicy: "gated",
};

const request: RunRequest = {
  runId: "run-1",
  taskId: "task-1",
  role: "worker",
  provider: "codex",
  modelProfile: "standard",
  resolvedModel: "terra",
  scope,
  prompt: "p",
};

beforeEach(() => {
  base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "meidoya-assign-")),
  );
  roots = path.join(base, "Repositories");
  fs.mkdirSync(path.join(roots, "product-a"), { recursive: true });
  fs.mkdirSync(path.join(roots, "worktrees", "task-1"), { recursive: true });
  sandbox = new FilesystemSandbox({
    allowedRoots: [roots],
    allowHomeFallback: false,
    home: path.join(base, "home"),
    cwd: roots,
  });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("SandboxRunAssignment", () => {
  it("uses the Control Plane scope, never the request payload", () => {
    const scopes = new Map([["run-1", scope]]);
    const assignment = new SandboxRunAssignment(
      sandbox,
      { projects: { "work-it": { "product-a": path.join(roots, "product-a") } } },
      scopes,
    );
    const tampered: RunRequest = {
      ...request,
      scope: { ...scope, workspaceId: "work-grammarxiv" },
    };
    expect(assignment.authoritativeScope(tampered)).toEqual(scope);
  });

  it("refuses runs with no Control Plane scope", () => {
    const assignment = new SandboxRunAssignment(sandbox, { projects: {} }, new Map());
    expect(() => assignment.authoritativeScope(request)).toThrow(
      ScopeViolationError,
    );
  });

  it("narrows cwd to the target project", () => {
    const assignment = new SandboxRunAssignment(
      sandbox,
      { projects: { "work-it": { "product-a": path.join(roots, "product-a") } } },
      new Map([["run-1", scope]]),
    );
    expect(assignment.workingDirectory(request, scope)).toBe(
      path.join(roots, "product-a"),
    );
  });

  it("prefers the task worktree when one exists", () => {
    const worktree = path.join(roots, "worktrees", "task-1");
    const assignment = new SandboxRunAssignment(
      sandbox,
      {
        projects: { "work-it": { "product-a": path.join(roots, "product-a") } },
        worktrees: { "work-it": { "task-1": worktree } },
      },
      new Map([["run-1", scope]]),
    );
    expect(assignment.workingDirectory(request, scope)).toBe(worktree);
  });

  it("rejects a project that is not bound on this node", () => {
    const assignment = new SandboxRunAssignment(
      sandbox,
      { projects: { "work-it": {} } },
      new Map([["run-1", scope]]),
    );
    expect(() => assignment.workingDirectory(request, scope)).toThrow(
      ScopeViolationError,
    );
  });

  it("refuses a write-mode project the scope has no repo.write capability for", () => {
    // The two halves of the grant are computed separately upstream; the node
    // does not take the permissive reading when they disagree.
    const incoherent: AgentRunScope = { ...scope, capabilities: ["repo.read"] };
    const assignment = new SandboxRunAssignment(
      sandbox,
      { projects: { "work-it": { "product-a": path.join(roots, "product-a") } } },
      new Map([["run-1", incoherent]]),
    );
    expect(() => assignment.workingDirectory(request, incoherent)).toThrow(
      ScopeViolationError,
    );
  });

  it("re-verifies the cwd at use time and catches a directory swapped for a symlink", () => {
    const projectPath = path.join(roots, "product-a");
    const assignment = new SandboxRunAssignment(
      sandbox,
      { projects: { "work-it": { "product-a": projectPath } } },
      new Map([["run-1", scope]]),
    );
    const cwd = assignment.workingDirectory(request, scope);
    expect(assignment.verifyWorkingDirectory(request, scope, cwd)).toBe(cwd);

    // Between check and use, the project directory becomes a symlink to a
    // different directory that is still inside the allowed roots: `resolve`
    // alone would happily accept it.
    const elsewhere = path.join(roots, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.rmSync(projectPath, { recursive: true, force: true });
    fs.symlinkSync(elsewhere, projectPath);

    expect(() => assignment.verifyWorkingDirectory(request, scope, cwd)).toThrow(
      /changed between check and use/,
    );
  });

  it("re-verification also catches a swap that escapes the allowed roots", () => {
    const projectPath = path.join(roots, "product-a");
    const assignment = new SandboxRunAssignment(
      sandbox,
      { projects: { "work-it": { "product-a": projectPath } } },
      new Map([["run-1", scope]]),
    );
    const cwd = assignment.workingDirectory(request, scope);

    const outside = path.join(base, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.rmSync(projectPath, { recursive: true, force: true });
    fs.symlinkSync(outside, projectPath);

    expect(() => assignment.verifyWorkingDirectory(request, scope, cwd)).toThrow();
  });

  it("rejects a bound project path outside the sandbox roots", () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside, { recursive: true });
    const assignment = new SandboxRunAssignment(
      sandbox,
      { projects: { "work-it": { "product-a": outside } } },
      new Map([["run-1", scope]]),
    );
    expect(() => assignment.workingDirectory(request, scope)).toThrow();
  });
});
