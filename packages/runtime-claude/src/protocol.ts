import type { WorkerCapability } from "@meidoya/domain";

/** Capability → the only built-in Claude Code tools visible to the model. */
export const CAPABILITY_TOOLS: Record<WorkerCapability, readonly string[]> = {
  "repo.read": ["Read", "Grep", "Glob"],
  "repo.write": ["Edit", "Write"],
  shell: ["Bash"],
  network: ["WebFetch", "WebSearch"],
  browser: [],
  "package-install": [],
  "external-side-effect": [],
};

const ALL_TOOLS = [
  ...new Set(Object.values(CAPABILITY_TOOLS).flat()),
] as const;

export function allowedTools(capabilities: readonly WorkerCapability[]): string[] {
  const allowed = new Set<string>();
  for (const capability of capabilities) {
    for (const tool of CAPABILITY_TOOLS[capability]) allowed.add(tool);
  }
  return [...allowed];
}

export function disallowedTools(capabilities: readonly WorkerCapability[]): string[] {
  const allowed = new Set(allowedTools(capabilities));
  return ALL_TOOLS.filter((tool) => !allowed.has(tool));
}

export function claudeSandboxSettings(
  capabilities: readonly WorkerCapability[],
): Record<string, unknown> {
  const externalNetwork =
    capabilities.includes("network") && capabilities.includes("external-side-effect");
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      network: {
        strictAllowlist: true,
        allowedDomains: externalNetwork ? ["*"] : [],
      },
    },
  };
}

export type ClaudeArgsInput = {
  readonly resolvedModel: string;
  readonly capabilities: readonly WorkerCapability[];
  readonly resumeSessionId?: string;
};

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args: string[] = [];
  if (input.resumeSessionId !== undefined) args.push("--resume", input.resumeSessionId);
  args.push("-p", "--output-format", "stream-json", "--verbose");
  args.push("--model", input.resolvedModel);
  args.push(
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
  );

  const allowed = allowedTools(input.capabilities);
  args.push("--tools", allowed.join(","));
  if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));
  const disallowed = disallowedTools(input.capabilities);
  if (disallowed.length > 0) args.push("--disallowedTools", disallowed.join(","));
  args.push("--settings", JSON.stringify(claudeSandboxSettings(input.capabilities)));
  return args;
}

export type ClaudeStreamEvent =
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "phase"; readonly phase: string }
  | {
      readonly type: "result";
      readonly ok: boolean;
      readonly text: string | undefined;
      readonly sessionId: string | undefined;
      readonly subtype: string | undefined;
    }
  | { readonly type: "ignored" };

type Json = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textFromMessage(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as Json)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Json;
    if (b["type"] === "text") {
      const text = str(b["text"]);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

/**
 * Parses one `--output-format stream-json` line into a vendor-neutral event.
 *
 * This parser deliberately does NOT redact. Redaction of a serialized document
 * before it is parsed corrupts it: `PlannedStep.key` is literally named `key`,
 * so `{"key":"step-1"}` came back as `{"key":"[redacted]"}` and every plan lost
 * its step ids and its `dependsOn` edges while the run still reported success.
 * Redaction is applied one layer out, by `AgentEventFactory.make`, which is the
 * single egress every adapter must pass through and which redacts each event
 * field it touches — including `structuredOutput`, deeply, on the PARSED value
 * where a step id has no `key:` prefix to trigger the assignment rule.
 * Redacting here as well would be pure redundancy on top of a chokepoint that
 * cannot be bypassed, at the cost of destroying the payload.
 */
export function parseClaudeLine(line: string): ClaudeStreamEvent {
  const trimmed = line.trim();
  if (trimmed === "") return { type: "ignored" };

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { type: "ignored" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { type: "ignored" };
  }

  const root = value as Json;
  const type = str(root["type"]);
  const sessionId = str(root["session_id"]);

  if (type === "system") {
    if (str(root["subtype"]) === "init" && sessionId !== undefined) {
      return { type: "session", sessionId };
    }
    return { type: "phase", phase: str(root["subtype"]) ?? "system" };
  }

  if (type === "assistant") {
    const text = textFromMessage(root["message"]);
    if (text !== undefined) return { type: "message", text };
    return { type: "phase", phase: "assistant" };
  }

  if (type === "user") return { type: "phase", phase: "tool-result" };

  if (type === "result") {
    const subtype = str(root["subtype"]);
    const isError = root["is_error"] === true || (subtype !== undefined && subtype !== "success");
    const result = str(root["result"]);
    return {
      type: "result",
      ok: !isError,
      text: result,
      sessionId,
      subtype,
    };
  }

  return { type: "ignored" };
}
