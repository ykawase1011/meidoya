import type {
  AgentInvocation,
  AgentInvocationPort,
  AgentInvocationResult,
} from "@meidoya/task-engine";
import {
  MaidDecisionSchema,
  ExecutionPlanSchema,
  ManagerDecisionSchema,
  ReviewFindingsSchema,
  WorkerResultSchema,
  buildStructuredOutputPrompt,
  driveRun,
  type AgentRuntime,
  type StructuredOutputKind,
} from "@meidoya/agent-runtime";
export type { AgentRuntime };
import type {
  ExecutionPlan,
  MaidDecision,
  ManagerDecision,
  ReviewFindings,
  WorkerCapability,
  WorkerResult,
  Provider,
} from "@meidoya/domain";
import { derivePermissions } from "@meidoya/model-router";
import type { ModelMapping } from "@meidoya/model-router";
import { deriveRunScope } from "@meidoya/node-runtime";
import type { ActivityDependencies } from "@meidoya/workflows-temporal";

/**
 * The expected structured-output kind travels in the first prompt line. It is
 * a control-plane fact (which step is running), never an agent choice, so the
 * agent port can pick the right schema without a second registry.
 */
const OUTPUT_KIND_HEADER = "#meidoya-output:";

export function buildPrompt(kind: StructuredOutputKind, body: string): string {
  return buildStructuredOutputPrompt(kind, body);
}

export function promptOutputKind(prompt: string): StructuredOutputKind | undefined {
  const first = prompt.split("\n", 1)[0] ?? "";
  if (!first.startsWith(OUTPUT_KIND_HEADER)) return undefined;
  const kind = first.slice(OUTPUT_KIND_HEADER.length).trim();
  return kind === "MaidDecision" ||
    kind === "ExecutionPlan" ||
    kind === "ManagerDecision" ||
    kind === "WorkerResult" ||
    kind === "ReviewFindings"
    ? kind
    : undefined;
}

/**
 * Message bodies stay in SQLite; workflows carry only a reference (08 section 3),
 * so the prompt builder resolves the body at the last possible moment.
 */
export function createPromptBuilder(
  readMessage?: (ref: string) => string | undefined,
  projectsForWorkspace?: (workspaceId: string) => readonly string[],
  defaultTimezone: string = "UTC",
  maidAgentProfile: "secretary" = "secretary",
): ActivityDependencies["prompts"] {
  return {
    maidAssessment: (input, context) =>
      buildPrompt(
        "MaidDecision",
        [
          `Selected ingress agent profile: ${maidAgentProfile}.`,
          "You are Meidoya, a concise Japanese maid and executive secretary.",
          "Anticipate the user's likely intent and offer one useful next action without being verbose.",
          `Classify request ${input.requestKey} (origin ${input.origin}).`,
          `Request: ${readMessage?.(input.messageRef) ?? input.messageRef}`,
          `Available project IDs: ${JSON.stringify(projectsForWorkspace?.(input.workspaceId) ?? [])}`,
          context === undefined
            ? "Trusted workspace status: unavailable. Do not invent task or schedule counts."
            : `Trusted workspace status: ${JSON.stringify(context)}`,
          `Interpretation mode: ${input.interpretation ?? "auto"}.`,
          `Default schedule timezone: ${defaultTimezone}.`,
          `Preserve origin ${input.origin} in any TaskBrief and use only available project IDs.`,
          input.origin === "schedule"
            ? "This is an already-triggered schedule: return a quick or durable task, never schedule.create."
            : input.interpretation === "schedule"
              ? "This request must become schedule.create; use ask_user only when its recurrence or run time is ambiguous."
              : "An explicit request for recurring execution becomes schedule.create; ask_user when its recurrence or run time is ambiguous.",
          "For schedule.create, convert the recurrence to a standard five-field cron, use the default timezone when none is stated, create an ASCII slug name, preserve only the work to run in summary, and never invent project IDs.",
          "For greetings, thanks, small talk, capability questions, or a request for a helpful next step, return respond instead of creating a task.",
          "A respond reply must be natural Japanese, must not merely echo the user, and should accurately mention the trusted current task state when available.",
          "Keep respond replies to a short summary and at most two concrete bullets. Never claim work or facts not present in the request or trusted workspace status.",
          "Decide the lane only; the workspace is already fixed by the control plane.",
        ].join("\n"),
      ),
    planning: (input) =>
      buildPrompt(
        "ExecutionPlan",
        [
          input.delegationResults === undefined
            ? `Produce an execution plan for task ${input.taskId}, step ${input.stepKey}.`
            : `Aggregate the child task summaries for task ${input.taskId}, step ${input.stepKey}.`,
          `Attempt ${input.attempt}.`,
          `Task brief: ${JSON.stringify(input.brief)}`,
          ...(input.delegationResults === undefined
            ? []
            : [
                "Return the combined user-facing result in ExecutionPlan.summary.",
                `Children: ${JSON.stringify(input.delegationResults)}`,
              ]),
        ].join("\n"),
      ),
    worker: (input) =>
      buildPrompt(
        "WorkerResult",
        [
          `Task brief: ${JSON.stringify(input.brief)}`,
          `Execute pipeline step ${input.stepKey} (${input.stepKind}) of task ${input.taskId} as ${input.workerProfile}.`,
          `Attempt ${input.attempt}.`,
          ...(input.executionPlan === undefined
            ? []
            : [`Approved execution plan: ${JSON.stringify(input.executionPlan)}`]),
        ].join("\n"),
      ),
    review: (input) =>
      buildPrompt(
        "ReviewFindings",
        input.brief === undefined
          ? `Review the work produced for task ${input.taskId}, step ${input.stepKey}.`
          : [
              `Review the work produced for task ${input.taskId}, step ${input.stepKey}.`,
              `Task brief: ${JSON.stringify(input.brief)}`,
              ...(input.executionPlan === undefined
                ? []
                : [`Approved execution plan: ${JSON.stringify(input.executionPlan)}`]),
              ...(input.verification === undefined
                ? []
                : [`Verification result: ${JSON.stringify(input.verification)}`]),
            ].join("\n"),
      ),
    managerDecision: (input) =>
      buildPrompt(
        "ManagerDecision",
        [
          `Decide the next action for task ${input.taskId}.`,
          ...(Object.prototype.hasOwnProperty.call(input, "provider")
            ? [`Findings: ${input.findings.findings.length}.`]
            : [
                `Review findings: ${JSON.stringify(input.findings)}`,
                ...(input.verification === undefined
                  ? []
                  : [`Verification result: ${JSON.stringify(input.verification)}`]),
              ]),
        ].join("\n"),
      ),
  };
}

/** Structured output is validated before it can influence any control decision. */
export function createParsers(): ActivityDependencies["parse"] {
  return {
    maidDecision: (output) => MaidDecisionSchema.parse(output) as MaidDecision,
    plan: (output) => ExecutionPlanSchema.parse(output) as ExecutionPlan,
    workerResult: (output) => WorkerResultSchema.parse(output) as WorkerResult,
    reviewFindings: (output) => ReviewFindingsSchema.parse(output) as ReviewFindings,
    managerDecision: (output) => ManagerDecisionSchema.parse(output) as ManagerDecision,
  };
}

export type LocalAgentPortOptions = {
  runtimes: Partial<Record<Provider, AgentRuntime>>;
  modelMapping: ModelMapping;
  workdir?: string;
  timeoutMs?: number;
};

/**
 * Every capability the domain recognises. `invocation.scope.capabilities`
 * arrives as `string[]` (it travels through the workflow/activity boundary),
 * so it must be narrowed to `WorkerCapability[]` before `derivePermissions`
 * can intersect it against the actor's profile maximum. An unrecognised
 * string is dropped, never passed through.
 */
const KNOWN_CAPABILITIES: readonly WorkerCapability[] = [
  "repo.read",
  "repo.write",
  "shell",
  "network",
  "browser",
  "package-install",
  "external-side-effect",
];

function requestedCapabilities(capabilities: readonly string[]): WorkerCapability[] {
  return capabilities.filter((c): c is WorkerCapability =>
    (KNOWN_CAPABILITIES as readonly string[]).includes(c),
  );
}

/**
 * Runs an invocation on the control-plane host. `derivePermissions` guarantees
 * coordinating roles (Head Maid / Maid / Manager) hold no repository, shell or
 * network capability whatever the prompt asks for (09 section 9) — the
 * requested set is intersected against `ROLE_CAPABILITIES`-derived maxima,
 * never unioned, so a worker step's actual grant travels through untouched
 * while a coordinating role's request is discarded regardless of what
 * `invocation.scope.capabilities` contains.
 */
export function createLocalAgentPort(options: LocalAgentPortOptions): AgentInvocationPort {
  return {
    async invoke(invocation: AgentInvocation): Promise<AgentInvocationResult> {
      const runtime = options.runtimes[invocation.provider];
      if (runtime === undefined) {
        return {
          status: "failed",
          errorClass: `agent_runtime_unavailable:${invocation.provider}`,
          retryable: false,
        };
      }
      const kind = promptOutputKind(invocation.prompt);
      const actor =
        invocation.actor.role === "worker"
          ? ({ role: "worker", profile: invocation.actor.profile } as const)
          : ({ role: invocation.actor.role } as const);
      const permissions = derivePermissions(actor, {
        requested: requestedCapabilities(invocation.scope.capabilities),
      });
      const scope = deriveRunScope({
        workspaceId: invocation.scope.workspaceId,
        projectAccess: [],
        capabilities: [...permissions.capabilities],
        // 10 section 7: network/side-effect reach follows the granted
        // capability, never a standing default — a run that was not granted
        // `network` gets none, and only a human-approved `external-side-effect`
        // turns the side-effect gate to "allow".
        networkPolicy: permissions.capabilities.includes("network") ? "restricted" : "none",
        sideEffectPolicy: permissions.capabilities.includes("external-side-effect")
          ? "allow"
          : "deny",
      });

      const outcome = await driveRun(runtime, {
        runId: invocation.runId,
        role: invocation.actor.role,
        ...(invocation.actor.role === "worker" ? { workerProfile: invocation.actor.profile } : {}),
        provider: invocation.provider,
        modelProfile: invocation.modelProfile,
        resolvedModel: options.modelMapping[invocation.provider][invocation.modelProfile],
        scope,
        capabilities: permissions.capabilities,
        prompt: invocation.prompt,
        ...(kind === undefined ? {} : { structuredOutput: kind }),
        ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });

      switch (outcome.status) {
        case "succeeded":
          return { status: "succeeded", output: outcome.structuredOutput };
        case "cancelled":
          return { status: "cancelled" };
        case "waiting_user":
          // A coordinating role may not block on the user directly; the gate is
          // owned by the state machine, so this is an agent contract violation.
          return { status: "failed", errorClass: "unexpected_awaiting_user", retryable: false };
        default:
          return { status: "failed", errorClass: outcome.errorClass, retryable: outcome.retryable };
      }
    },
  };
}

/** Used when no agent runtime is configured: fail closed instead of guessing. */
export function createUnavailableAgentPort(reason: string): AgentInvocationPort {
  return {
    invoke(): AgentInvocationResult {
      return { status: "failed", errorClass: `agent_runtime_unavailable:${reason}`, retryable: false };
    },
  };
}

export type DaemonAgentPortOptions = {
  /** An already-built port (tests, the harness, the demo). Wins if present. */
  agents?: AgentInvocationPort;
  /** Vendor runtimes for coordinating roles, keyed by the requested provider. */
  runtimes?: Partial<Record<Provider, AgentRuntime>>;
  /** Concrete vendor model names, from the control plane's `models:` block. */
  modelMapping?: ModelMapping;
  workdir?: string;
  /** Where the "this daemon can run no agent" line goes. */
  warn: (message: string) => void;
};

/**
 * The daemon's agent port.
 *
 * `createLocalAgentPort` had no production caller: the daemon fell back to an
 * `unavailable` port whenever nothing was injected, so the shipped binary could
 * never run a Head Maid, Maid or Manager and never said so — the failure only
 * showed up as an `agent_runtime_unavailable` errorClass on some later task.
 *
 * Now there is exactly one place that decides, it builds the real port as soon
 * as a runtime and a model mapping exist, and the degraded case is ANNOUNCED at
 * startup rather than discovered by a user whose task died.
 */
export function createDaemonAgentPort(options: DaemonAgentPortOptions): AgentInvocationPort {
  if (options.agents !== undefined) return options.agents;
  if (options.runtimes !== undefined && options.modelMapping !== undefined) {
    return createLocalAgentPort({
      runtimes: options.runtimes,
      modelMapping: options.modelMapping,
      ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
    });
  }
  const reason =
    options.runtimes === undefined
      ? "no agent runtime is configured for this control plane"
      : "no `models:` mapping is configured for this control plane";
  options.warn(
    `meidoyad: DEGRADED: ${reason}; every coordinating role (Head Maid, Maid, Manager) will fail` +
      " with agent_runtime_unavailable and no task can be planned\n",
  );
  return createUnavailableAgentPort(reason);
}
