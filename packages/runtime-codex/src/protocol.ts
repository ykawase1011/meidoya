import type { WorkerCapability } from "@meidoya/domain";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/**
 * 10 section 10, defence in depth. `danger-full-access` is the one Codex mode
 * that can reach outside the workspace, so it is gated on the capability a
 * HUMAN approved, not merely on the pair (`repo.write`, `network`) that implies
 * it. `containCapabilities` in `@meidoya/model-router` already strips `network`
 * from an acting run that lacks `external-side-effect`, and this function must
 * not depend on that having happened: it sits at the vendor surface, it is the
 * last thing between a capability set and a real `--sandbox` flag, and a
 * reordering or a future caller that skips containment would otherwise hand out
 * full access silently. Requiring the capability explicitly makes the two
 * checks independent, which is the whole point of a second one.
 */
export function sandboxModeFor(capabilities: readonly WorkerCapability[]): CodexSandboxMode {
  const write = capabilities.includes("repo.write");
  const network = capabilities.includes("network");
  const approved = capabilities.includes("external-side-effect");
  if (write && network && approved) return "danger-full-access";
  if (write || capabilities.includes("shell")) return "workspace-write";
  return "read-only";
}

export type CodexArgsInput = {
  readonly resolvedModel: string;
  readonly capabilities: readonly WorkerCapability[];
  readonly workdir?: string;
  readonly resumeSessionId?: string;
};

export function buildCodexArgs(input: CodexArgsInput): string[] {
  const args = ["exec"];
  if (input.resumeSessionId !== undefined) {
    args.push(
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--model",
      input.resolvedModel,
      input.resumeSessionId,
    );
    args.push("-");
    return args;
  }
  args.push(
    "--json",
    "--skip-git-repo-check",
    "--model",
    input.resolvedModel,
    "--sandbox",
    sandboxModeFor(input.capabilities),
  );
  if (input.workdir !== undefined) args.push("--cd", input.workdir);
  args.push("-");
  return args;
}

export type CodexStreamEvent =
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "phase"; readonly phase: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "turn-completed" }
  | { readonly type: "ignored" };

type Json = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normalizes `codex exec --json` lines into vendor-neutral events. Both the
 * `thread.*`/`item.*` shape and the older `msg`-wrapped shape are accepted.
 *
 * This parser deliberately does NOT redact. Redaction of a serialized document
 * before it is parsed corrupts it (`ExecutionPlan` steps are keyed `key`, so
 * every step id came back as `[redacted]`), and a bare JSON value redacts to
 * unparseable text. Redaction is applied one layer out by
 * `AgentEventFactory.make`, the single egress every adapter passes through; it
 * redacts each event field, `structuredOutput` deeply and on the PARSED value
 * (10 section 9). Redacting here too would be redundancy at the cost of the
 * payload.
 */
export function parseCodexLine(line: string): CodexStreamEvent {
  const trimmed = line.trim();
  if (trimmed === "") return { type: "ignored" };

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { type: "ignored" };
  }
  if (typeof value !== "object" || value === null) return { type: "ignored" };

  const root = value as Json;
  const inner = (typeof root["msg"] === "object" && root["msg"] !== null ? root["msg"] : root) as Json;
  const type = str(inner["type"]) ?? str(root["type"]);

  const sessionId =
    str(root["thread_id"]) ??
    str(root["session_id"]) ??
    str(inner["thread_id"]) ??
    str(inner["session_id"]);

  if (type === "thread.started" || type === "session.created" || type === "session_configured") {
    if (sessionId !== undefined) return { type: "session", sessionId };
  }

  if (type === "error" || type === "stream_error") {
    return {
      type: "error",
      message: str(inner["message"]) ?? str(root["message"]) ?? "codex error",
    };
  }

  if (type === "turn.completed" || type === "task_complete") return { type: "turn-completed" };
  if (type === "turn.started" || type === "task_started") return { type: "phase", phase: "turn" };

  if (type === "agent_message") {
    const text = str(inner["message"]) ?? str(inner["text"]);
    if (text !== undefined) return { type: "message", text };
  }

  if (type === "item.completed" || type === "item.updated") {
    const item = inner["item"];
    if (typeof item === "object" && item !== null) {
      const itemObj = item as Json;
      const itemType = str(itemObj["type"]) ?? str(itemObj["item_type"]);
      const text = str(itemObj["text"]) ?? str(itemObj["message"]);
      if (itemType === "agent_message" && text !== undefined) {
        return { type: "message", text };
      }
      if (itemType !== undefined) return { type: "phase", phase: itemType };
    }
  }

  if (sessionId !== undefined) return { type: "session", sessionId };
  return { type: "ignored" };
}
