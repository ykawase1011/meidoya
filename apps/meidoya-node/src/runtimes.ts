import { lstatSync, readFileSync } from "node:fs";
import type { ModelProfile, Provider, WorkerCapability, WorkerProfile } from "@meidoya/domain";
import type { AgentEvent, AgentRuntime, StructuredOutputKind } from "@meidoya/agent-runtime";
import type { NodeConfig } from "@meidoya/execution-native";
import type { AgentRuntimePort, RunContext, RuntimeEvent } from "@meidoya/node-runtime";
import type { RunRequest } from "@meidoya/node-protocol";
import { derivePermissions } from "@meidoya/model-router";
import { CodexRuntime, SubprocessCodexInvoker } from "@meidoya/runtime-codex";
import { ClaudeRuntime, SubprocessClaudeInvoker } from "@meidoya/runtime-claude";

export type RuntimeRegistry = Partial<Record<Provider, AgentRuntime>>;

export function readPrivateCredentialFile(file: string): string {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`credential path is not a regular file: ${file}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`credential file must not be accessible by group or other users: ${file}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`credential file is not owned by the meidoya-node process user: ${file}`);
  }
  const value = readFileSync(file, "utf8").trim();
  if (value === "") throw new Error(`credential file is empty: ${file}`);
  return value;
}

export function claudeRuntimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runtimeEnv = { ...env };
  const tokenFile = env["MEIDOYA_CLAUDE_TOKEN_FILE"];
  delete runtimeEnv["MEIDOYA_CLAUDE_TOKEN_FILE"];
  if (tokenFile !== undefined && tokenFile !== "") {
    runtimeEnv["CLAUDE_CODE_OAUTH_TOKEN"] = readPrivateCredentialFile(tokenFile);
  }
  return runtimeEnv;
}

/**
 * Builds the runtimes the `runtimes:` config block enables. A disabled provider
 * is simply absent, so a run routed to it fails closed instead of silently
 * falling back to another vendor.
 */
export function createRuntimes(config: NodeConfig, env: NodeJS.ProcessEnv = process.env): RuntimeRegistry {
  const registry: RuntimeRegistry = {};
  const codex = config.runtimes["codex"];
  if (codex?.enabled === true) {
    registry.codex = new CodexRuntime({
      invoker: new SubprocessCodexInvoker({
        // The node's own environment is the vendor CLI's base environment: the
        // credential, proxy and CA settings the operator provisioned on this
        // node are exactly what `codex` needs. Passed explicitly because an
        // omitted `env` reaches `spawnBounded` as `minimalEnv()`, not as the
        // parent's environment.
        baseEnv: env,
        ...(env["MEIDOYA_CODEX_BIN"] === undefined ? {} : { binPath: env["MEIDOYA_CODEX_BIN"] }),
      }),
    });
  }
  const claude = config.runtimes["claude"];
  if (claude?.enabled === true) {
    registry.claude = new ClaudeRuntime({
      invoker: new SubprocessClaudeInvoker({
        baseEnv: claudeRuntimeEnvironment(env),
        ...(env["MEIDOYA_CLAUDE_BIN"] === undefined ? {} : { binPath: env["MEIDOYA_CLAUDE_BIN"] }),
      }),
    });
  }
  return registry;
}

/**
 * Concrete vendor model names never appear in domain config; on a node they
 * come from the environment so credentials and names stay node-local.
 */
export function resolveModelName(
  provider: Provider,
  profile: ModelProfile,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[`MEIDOYA_MODEL_${provider.toUpperCase()}_${profile.toUpperCase()}`] ?? `${provider}-${profile}`;
}

/** Node-side runs are Worker runs; coordinating roles never leave the daemon. */
const WORKER_OUTPUT: StructuredOutputKind = "WorkerResult";

const WORKER_CAPABILITIES: readonly WorkerCapability[] = [
  "repo.read",
  "repo.write",
  "shell",
  "network",
  "browser",
  "package-install",
  "external-side-effect",
];

/**
 * Narrows a run scope's capability list to strings this codebase knows.
 *
 * The scope arrives over the wire, so it can carry anything; only a known
 * `WorkerCapability` may reach `derivePermissions` and, through it, the vendor
 * CLI's permission flags. Exported so the filter is testable on its own.
 */
export function requestedCapabilities(scope: RunRequest["scope"]): WorkerCapability[] {
  return scope.capabilities.filter((c): c is WorkerCapability =>
    (WORKER_CAPABILITIES as readonly string[]).includes(c),
  );
}

/** Capabilities that cannot mean anything without egress from the node. */
const NETWORK_BACKED_CAPABILITIES: readonly WorkerCapability[] = [
  "network",
  "browser",
  "package-install",
];

/**
 * Applies the run scope's `networkPolicy` / `sideEffectPolicy` to the capability
 * set the agent process is actually spawned with (10 section 7).
 *
 * These two fields used to be carried, logged and compared but never enforced,
 * which made them decorative: a run whose scope said `networkPolicy: "none"`
 * still handed the vendor CLI a `network` capability, and the vendor CLI is
 * what turns a capability into a sandbox/approval flag. Enforcement happens
 * here, on the node, because this is the last place before spawn.
 *
 * Narrowing only: this can remove a capability, never add one.
 */
export function constrainByRunPolicy(
  capabilities: readonly WorkerCapability[],
  scope: { readonly networkPolicy: string; readonly sideEffectPolicy: string },
): WorkerCapability[] {
  const denied = new Set<WorkerCapability>();
  // Anything other than an explicit egress policy is treated as "none": an
  // unknown policy string is not permission to reach the network.
  if (scope.networkPolicy !== "restricted" && scope.networkPolicy !== "open") {
    for (const capability of NETWORK_BACKED_CAPABILITIES) denied.add(capability);
  }
  // 06 section 1.4: only a human answer at the side-effect gate turns this to
  // "allow"; anything else means the run may not act outside the sandbox.
  if (scope.sideEffectPolicy !== "allow") denied.add("external-side-effect");
  return capabilities.filter((capability) => !denied.has(capability));
}

/**
 * Adapts a vendor AgentRuntime to the node's RuntimeEvent stream. The agent
 * subprocess is spawned detached, so cancelling the run signals the whole
 * process group rather than a single pid (10 section 3).
 */
export class AgentRuntimeAdapter implements AgentRuntimePort {
  constructor(
    private readonly runtimes: RuntimeRegistry,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async *execute(request: RunRequest, ctx: RunContext): AsyncIterable<RuntimeEvent> {
    const runtime = this.runtimes[request.provider];
    if (runtime === undefined) {
      yield {
        type: "done",
        status: "failed",
        errorClass: `runtime_not_enabled:${request.provider}`,
        retryable: false,
      };
      return;
    }

    const actor =
      request.role === "worker"
        ? ({ role: "worker", profile: (request.workerProfile ?? "implementer") as WorkerProfile } as const)
        : ({ role: request.role } as const);
    const permissions = derivePermissions(actor, {
      requested: requestedCapabilities(request.scope),
    });
    // The scope's own policies are the last narrowing before spawn, so the
    // fields have effect on the process rather than only on a log line.
    const granted = constrainByRunPolicy(permissions.capabilities, request.scope);
    const scope = { ...request.scope, capabilities: [...granted] };

    const abort = (): void => {
      void runtime.cancel(request.runId);
    };
    ctx.signal.addEventListener("abort", abort, { once: true });

    const events =
      request.resumeSessionId === undefined
        ? runtime.run({
            runId: request.runId,
            role: request.role,
            ...(request.workerProfile === undefined
              ? {}
              : { workerProfile: request.workerProfile as WorkerProfile }),
            provider: request.provider,
            modelProfile: request.modelProfile,
            resolvedModel:
              request.resolvedModel.length > 0
                ? request.resolvedModel
                : resolveModelName(request.provider, request.modelProfile, this.env),
            scope,
            capabilities: granted,
            prompt: request.prompt,
            structuredOutput: request.structuredOutputSchemaRef ?? WORKER_OUTPUT,
            workdir: ctx.cwd,
          })
        : runtime.resume({
            runId: request.runId,
            role: request.role,
            provider: request.provider,
            modelProfile: request.modelProfile,
            resolvedModel: request.resolvedModel,
            scope,
            capabilities: granted,
            prompt: request.prompt,
            structuredOutput: request.structuredOutputSchemaRef ?? WORKER_OUTPUT,
            workdir: ctx.cwd,
            externalSessionId: request.resumeSessionId,
          });

    try {
      for await (const event of events) {
        const mapped = toRuntimeEvent(event);
        if (mapped !== undefined) yield mapped;
        if (mapped?.type === "done") return;
      }
    } finally {
      ctx.signal.removeEventListener("abort", abort);
    }
  }
}

function toRuntimeEvent(event: AgentEvent): RuntimeEvent | undefined {
  switch (event.type) {
    case "session":
      return { type: "session", sessionId: event.externalSessionId };
    case "phase":
      return { type: "phase", phase: event.phase };
    case "log":
      return { type: "log", message: event.message };
    case "awaiting-user":
      // A Worker may not block on a human: it must return a blocked result and
      // let the Manager own the gate (05 section 9).
      return {
        type: "done",
        status: "failed",
        errorClass: "worker_awaited_user",
        retryable: false,
      };
    case "result":
      if (event.status === "succeeded") {
        return {
          type: "done",
          status: "succeeded",
          ...(event.structuredOutput === undefined
            ? {}
            : { structuredOutput: event.structuredOutput }),
        };
      }
      return {
        type: "done",
        status: "failed",
        errorClass: event.errorClass ?? "agent_failed",
        retryable: event.retryable ?? true,
      };
    default:
      return undefined;
  }
}
