import type { WorkerResult } from "@meidoya/domain";
import type { AgentRuntimePort, RunContext, RuntimeEvent } from "@meidoya/node-runtime";
import type { RunRequest } from "@meidoya/node-protocol";

export const DEFAULT_FAKE_WORKER_RESULT: WorkerResult = {
  type: "completed",
  summary: "change applied",
  artifacts: [],
  evidence: [],
};

/**
 * Offline stand-in for Codex/Claude on an execution node: no binary, no network,
 * no credentials. Still exercises the node's scope sealing and cwd narrowing.
 */
export class FakeNodeRuntime implements AgentRuntimePort {
  readonly requests: RunRequest[] = [];
  readonly workdirs: string[] = [];

  constructor(private readonly result?: unknown | ((request: RunRequest) => unknown)) {}

  async *execute(request: RunRequest, ctx: RunContext): AsyncIterable<RuntimeEvent> {
    this.requests.push(request);
    this.workdirs.push(ctx.cwd);
    yield { type: "phase", phase: "running" };
    const configured = typeof this.result === "function" ? this.result(request) : this.result;
    const structuredOutput =
      configured ??
      (request.structuredOutputSchemaRef === "ReviewFindings"
        ? { findings: [] }
        : DEFAULT_FAKE_WORKER_RESULT);
    yield { type: "done", status: "succeeded", structuredOutput };
  }
}
