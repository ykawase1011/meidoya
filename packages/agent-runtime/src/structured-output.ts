import type { z } from "zod";
import { schemaFor, type StructuredOutputFor } from "./schemas.js";
import type { StructuredOutputKind } from "./types.js";

export type SchemaIssue = { readonly path: string; readonly message: string };

export type RepairRequest = {
  readonly kind: StructuredOutputKind;
  readonly issues: readonly SchemaIssue[];
  readonly rawOutput: unknown;
  /** Prompt to send back to the SAME agent/session. */
  readonly prompt: string;
};

/** Asks the same agent (same session) for a corrected output. */
export type RepairFn = (request: RepairRequest) => Promise<unknown>;

const OUTPUT_KIND_HEADER = "#meidoya-output:";

const OUTPUT_CONTRACTS: Record<StructuredOutputKind, string> = {
  MaidDecision: [
    "Return exactly one object:",
    '- {"type":"administrative","command":{"kind":"task.list","view":"open|waiting|closed|all"}}',
    'Use task.list view "open" for ordinary questions about current/in-progress tasks, "waiting" for human/action waits, "closed" for finished tasks, and "all" only when explicitly requested.',
    '- {"type":"administrative","command":{"kind":"task.get|task.cancel|schedule.list|schedule.pause|schedule.resume", ...required id}}',
    '- {"type":"administrative","command":{"kind":"schedule.create","name":"ascii-slug","cron":"five-field cron","timezone":"IANA timezone","title":"...","summary":"work to run","projects":["project-id"],"delivery":"always|on-change","overlap":"skip|buffer-one|allow","enabled":true}}',
    '- {"type":"quick|durable","brief":{"summary":"...","projects":["project-id"],"origin":"chat|cli|schedule|delegation|agent"}}',
    '- {"type":"answer_question","taskId":"...","questionId":"...","answer":"..."}',
    '- {"type":"ask_user","question":"..."}',
    '- {"type":"out_of_scope","reason":"..."}',
  ].join("\n"),
  ExecutionPlan: [
    "Return exactly one object:",
    '{"summary":"...","risk":"low|medium|high","projects":[{"projectId":"...","mode":"read|write"}],"steps":[{"key":"...","kind":"investigate|implement|test|review|other","description":"...","workerProfile":"researcher|implementer|reviewer|security-reviewer|tester|mechanical-editor","dependsOn":["step-key"]}],"expectedArtifacts":["workspace-relative/path"],"verification":{"commands":[{"name":"configured-quality-gate-name"}]}}',
    "Verification entries select configured gate names only; never return commands or argv.",
  ].join("\n"),
  ManagerDecision: [
    "Return exactly one object:",
    '- {"type":"complete"}',
    '- {"type":"fix","findingIds":["..."]}',
    '- {"type":"additional_review"}',
    '- {"type":"request_checkpoint","checkpointKind":"clarification|plan-approval|review-approval|side-effect-approval|limit-exceeded","prompt":"..."}',
    '- {"type":"abort","reason":"..."}',
  ].join("\n"),
  WorkerResult: [
    "Return exactly one object:",
    '- {"type":"completed","summary":"...","artifacts":[{"artifactId":"...","kind":"...","path":"workspace-relative/path","sha256":"..."}],"evidence":[{"kind":"command-output|test-report|diff|log","artifactId":"..."}]}',
    '- {"type":"blocked","reason":"...","proposedQuestion":"..."}',
    '- {"type":"failed","errorClass":"...","retryable":true|false}',
    "Use empty arrays when there are no artifacts or evidence.",
  ].join("\n"),
  ReviewFindings: [
    "Return exactly one object:",
    '{"findings":[{"id":"...","severity":"blocking|major|minor|note","summary":"...","location":"optional path:line"}]}',
    "Use an empty findings array when no issue remains.",
  ].join("\n"),
};

export function structuredOutputContract(kind: StructuredOutputKind): string {
  return OUTPUT_CONTRACTS[kind];
}

export function buildStructuredOutputPrompt(kind: StructuredOutputKind, body: string): string {
  return [
    `${OUTPUT_KIND_HEADER} ${kind}`,
    body,
    "",
    `Required ${kind} JSON contract:`,
    structuredOutputContract(kind),
    "Reply with JSON only. No prose and no code fence.",
  ].join("\n");
}

export type StructuredOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly repaired: boolean; readonly attempts: number }
  | {
      readonly ok: false;
      readonly errorClass: "schema_validation_failed";
      readonly issues: readonly SchemaIssue[];
      readonly attempts: number;
      /** 09 section 8: a failed repair consumes retry budget. */
      readonly consumesRetryBudget: true;
    };

function toIssues(error: z.ZodError): readonly SchemaIssue[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export function coerceRawOutput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    return raw;
  }
}

export function buildRepairPrompt(
  kind: StructuredOutputKind,
  issues: readonly SchemaIssue[],
): string {
  const lines = issues.map((i) => `- ${i.path === "" ? "(root)" : i.path}: ${i.message}`);
  return [
    `Your previous reply did not satisfy the required ${kind} schema.`,
    "Schema violations:",
    ...lines,
    structuredOutputContract(kind),
    "Reply with corrected JSON only. No prose, no code fence.",
  ].join("\n");
}

/**
 * 09 section 8: validate, and on failure ask the SAME agent to repair exactly once.
 * A second failure surfaces as a failure that consumes retry budget.
 */
export async function parseWithRepairOnce<K extends StructuredOutputKind>(
  kind: K,
  raw: unknown,
  repair: RepairFn,
): Promise<StructuredOutcome<StructuredOutputFor<K>>> {
  const schema = schemaFor(kind);

  const first = schema.safeParse(coerceRawOutput(raw));
  if (first.success) {
    return { ok: true, value: first.data as StructuredOutputFor<K>, repaired: false, attempts: 1 };
  }

  const issues = toIssues(first.error);
  const repaired = await repair({
    kind,
    issues,
    rawOutput: raw,
    prompt: buildRepairPrompt(kind, issues),
  });

  const second = schema.safeParse(coerceRawOutput(repaired));
  if (second.success) {
    return { ok: true, value: second.data as StructuredOutputFor<K>, repaired: true, attempts: 2 };
  }

  return {
    ok: false,
    errorClass: "schema_validation_failed",
    issues: toIssues(second.error),
    attempts: 2,
    consumesRetryBudget: true,
  };
}
