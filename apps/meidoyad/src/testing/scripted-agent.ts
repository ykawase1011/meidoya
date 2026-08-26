import { spawn, type ChildProcess } from "node:child_process";
import type {
  ExecutionPlan,
  MaidDecision,
  ManagerDecision,
  ReviewFindings,
  WorkerResult,
} from "@meidoya/domain";
import type {
  AgentInvocation,
  AgentInvocationPort,
  AgentInvocationResult,
} from "@meidoya/task-engine";
import { promptOutputKind } from "../agents.js";

export const DEFAULT_MAID_DECISION: MaidDecision = {
  type: "durable",
  brief: { summary: "handle the request", projects: [], origin: "cli" },
};

export const DEFAULT_PLAN: ExecutionPlan = {
  summary: "Implement the requested change",
  risk: "low",
  projects: [],
  steps: [
    {
      key: "implement",
      kind: "implement",
      description: "apply the change",
      workerProfile: "implementer",
      dependsOn: [],
    },
  ],
  expectedArtifacts: [],
  // Selects a configured quality gate by name; the operator owns the argv.
  verification: { commands: [{ name: "test" }] },
};

export const DEFAULT_WORKER_RESULT: WorkerResult = {
  type: "completed",
  summary: "change applied",
  artifacts: [],
  evidence: [],
};

export const DEFAULT_REVIEW: ReviewFindings = { findings: [] };
export const DEFAULT_MANAGER_DECISION: ManagerDecision = { type: "complete" };

export type ScriptedAgentOptions = {
  maidDecision?: MaidDecision;
  plan?: ExecutionPlan;
  workerResult?: WorkerResult;
  reviewFindings?: ReviewFindings;
  managerDecision?: ManagerDecision;
  /**
   * Spawns a real short-lived child process per invocation, so a test can
   * assert that no agent process is alive while the task waits on a human.
   */
  spawnRealProcess?: boolean;
  /** Raw override per structured-output kind, used to drive malicious output. */
  rawOutputs?: Partial<Record<string, unknown>>;
  /**
   * Per-workspace overrides, selected by the invocation's scope. Lets one
   * daemon host several independent scenarios instead of one daemon each.
   */
  workspaces?: Record<string, Omit<ScriptedAgentOptions, "workspaces">>;
};

/**
 * Offline agent runtime returning canned structured output. No Codex or Claude
 * binary, no network, no credentials.
 */
export class ScriptedAgentPort implements AgentInvocationPort {
  readonly invocations: AgentInvocation[] = [];
  readonly spawnedPids: number[] = [];
  #active = 0;
  readonly #children = new Set<ChildProcess>();

  constructor(private readonly options: ScriptedAgentOptions = {}) {}

  get activeCount(): number {
    return this.#active;
  }

  /** Pids spawned by this port that are still alive right now. */
  livePids(): number[] {
    return this.spawnedPids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Workspace overrides win over the port-wide defaults. */
  #optionsFor(invocation: AgentInvocation): ScriptedAgentOptions {
    const scoped = this.options.workspaces?.[invocation.scope.workspaceId];
    return scoped === undefined ? this.options : { ...this.options, ...scoped };
  }

  async invoke(invocation: AgentInvocation): Promise<AgentInvocationResult> {
    this.invocations.push(invocation);
    this.#active += 1;
    const options = this.#optionsFor(invocation);
    const child = options.spawnRealProcess === true ? this.#spawn() : undefined;
    try {
      const kind = promptOutputKind(invocation.prompt);
      const raw = kind === undefined ? undefined : options.rawOutputs?.[kind];
      if (raw !== undefined) return { status: "succeeded", output: raw };
      switch (kind) {
        case "MaidDecision":
          return { status: "succeeded", output: options.maidDecision ?? DEFAULT_MAID_DECISION };
        case "ExecutionPlan":
          return { status: "succeeded", output: options.plan ?? DEFAULT_PLAN };
        case "WorkerResult":
          return {
            status: "succeeded",
            output: options.workerResult ?? DEFAULT_WORKER_RESULT,
          };
        case "ReviewFindings":
          return { status: "succeeded", output: options.reviewFindings ?? DEFAULT_REVIEW };
        case "ManagerDecision":
          return {
            status: "succeeded",
            output: options.managerDecision ?? DEFAULT_MANAGER_DECISION,
          };
        default:
          return { status: "failed", errorClass: "unknown_output_kind", retryable: false };
      }
    } finally {
      // The process never outlives the invocation: a wait state must hold none.
      if (child !== undefined) await this.#kill(child);
      this.#active -= 1;
    }
  }

  #spawn(): ChildProcess {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    if (child.pid !== undefined) this.spawnedPids.push(child.pid);
    this.#children.add(child);
    return child;
  }

  async #kill(child: ChildProcess): Promise<void> {
    this.#children.delete(child);
    if (child.pid === undefined || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await exited;
  }

  killAll(): void {
    for (const child of [...this.#children]) void this.#kill(child);
  }
}
