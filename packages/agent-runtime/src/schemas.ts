import { z } from "zod";
import type {
  ExecutionPlan,
  MaidDecision,
  ManagerDecision,
  ReviewFindings,
  WorkerResult,
} from "@meidoya/domain";
import type { StructuredOutputKind } from "./types.js";
import { QUALITY_GATE_SELECTOR_PATTERN } from "./verification-runner.js";

const AdminCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task.list"),
      view: z.enum(["open", "waiting", "closed", "all"]).default("open"),
    })
    .strict(),
  z.object({ kind: z.literal("task.get"), taskId: z.string() }).strict(),
  z.object({ kind: z.literal("task.cancel"), taskId: z.string() }).strict(),
  z.object({ kind: z.literal("schedule.list") }).strict(),
  z
    .object({
      kind: z.literal("schedule.create"),
      name: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      cron: z.string().min(1),
      timezone: z.string().min(1),
      title: z.string().min(1).max(256),
      summary: z.string().min(1).max(16_384),
      projects: z.array(z.string().max(512)).default([]),
      delivery: z.enum(["always", "on-change"]).default("on-change"),
      overlap: z.enum(["skip", "buffer-one", "allow"]).default("skip"),
      enabled: z.boolean().default(true),
    })
    .strict(),
  z.object({ kind: z.literal("schedule.pause"), scheduleId: z.string() }).strict(),
  z.object({ kind: z.literal("schedule.resume"), scheduleId: z.string() }).strict(),
]);

const TaskBriefSchema = z.object({
  summary: z.string(),
  projects: z.array(z.string()),
  origin: z.enum(["chat", "cli", "schedule", "delegation", "agent"]),
});

const MaidReplySchema = z
  .object({
    summary: z.string().min(1).max(3_000),
    bullets: z.array(z.string().min(1).max(500)).max(5).optional(),
  })
  .strict();

export const MaidDecisionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("administrative"), command: AdminCommandSchema }),
  z.object({ type: z.literal("respond"), reply: MaidReplySchema }).strict(),
  z.object({ type: z.literal("quick"), brief: TaskBriefSchema }),
  z.object({ type: z.literal("durable"), brief: TaskBriefSchema }),
  z.object({
    type: z.literal("answer_question"),
    taskId: z.string(),
    questionId: z.string(),
    answer: z.string(),
  }),
  z.object({ type: z.literal("ask_user"), question: z.string() }),
  z.object({ type: z.literal("out_of_scope"), reason: z.string() }),
]);

const WorkerProfileSchema = z.enum([
  "researcher",
  "implementer",
  "reviewer",
  "security-reviewer",
  "tester",
  "mechanical-editor",
]);

const PlannedStepSchema = z.object({
  key: z.string(),
  kind: z.enum(["investigate", "implement", "test", "review", "other"]),
  description: z.string(),
  workerProfile: WorkerProfileSchema,
  dependsOn: z.array(z.string()),
});

export const ExecutionPlanSchema = z.object({
  summary: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  projects: z.array(z.object({ projectId: z.string(), mode: z.enum(["read", "write"]) })),
  steps: z.array(PlannedStepSchema),
  expectedArtifacts: z.array(z.string()),
  verification: z.object({
    // 10 section 2: a plan may only SELECT an operator-configured quality gate
    // by name. `.strict()` makes a smuggled `command` / `argv` a parse error
    // rather than something silently dropped, so the attempt is visible.
    commands: z.array(
      z
        .object({
          name: z
            .string()
            .regex(
              QUALITY_GATE_SELECTOR_PATTERN,
              "must be a configured quality-gate name (optionally group:gate)",
            ),
        })
        .strict(),
    ),
  }),
});

export const ManagerDecisionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("complete") }),
  z.object({ type: z.literal("fix"), findingIds: z.array(z.string()) }),
  z.object({ type: z.literal("additional_review") }),
  z.object({
    type: z.literal("request_checkpoint"),
    checkpointKind: z.enum([
      "clarification",
      "plan-approval",
      "review-approval",
      "side-effect-approval",
      "limit-exceeded",
    ]),
    prompt: z.string(),
  }),
  z.object({ type: z.literal("abort"), reason: z.string() }),
]);

const ArtifactRefSchema = z.object({
  artifactId: z.string(),
  kind: z.string(),
  path: z.string(),
  sha256: z.string(),
});

const EvidenceRefSchema = z.object({
  kind: z.enum(["command-output", "test-report", "diff", "log"]),
  artifactId: z.string(),
});

export const WorkerResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("completed"),
    summary: z.string(),
    artifacts: z.array(ArtifactRefSchema),
    evidence: z.array(EvidenceRefSchema),
  }),
  z.object({
    type: z.literal("blocked"),
    reason: z.string(),
    proposedQuestion: z.string().optional(),
  }),
  z.object({
    type: z.literal("failed"),
    errorClass: z.string(),
    retryable: z.boolean(),
  }),
]);

export const ReviewFindingsSchema = z.object({
  findings: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(["blocking", "major", "minor", "note"]),
      summary: z.string(),
      location: z.string().optional(),
    }),
  ),
});

export const STRUCTURED_OUTPUT_SCHEMAS = {
  MaidDecision: MaidDecisionSchema,
  ExecutionPlan: ExecutionPlanSchema,
  ManagerDecision: ManagerDecisionSchema,
  WorkerResult: WorkerResultSchema,
  ReviewFindings: ReviewFindingsSchema,
} as const;

/**
 * Compile-time guard: every value of the domain type must be accepted by its
 * schema. (The reverse direction cannot be expressed as an identity because
 * zod widens optional properties to `| undefined`.)
 */
type Covers<Domain, Inferred> = Domain extends Inferred ? true : never;
const _coversMaid: Covers<MaidDecision, z.infer<typeof MaidDecisionSchema>> = true;
const _coversPlan: Covers<ExecutionPlan, z.infer<typeof ExecutionPlanSchema>> = true;
const _coversManager: Covers<ManagerDecision, z.infer<typeof ManagerDecisionSchema>> = true;
const _coversWorker: Covers<WorkerResult, z.infer<typeof WorkerResultSchema>> = true;
const _coversReview: Covers<ReviewFindings, z.infer<typeof ReviewFindingsSchema>> = true;
void [_coversMaid, _coversPlan, _coversManager, _coversWorker, _coversReview];

export type StructuredOutputFor<K extends StructuredOutputKind> = K extends "MaidDecision"
  ? MaidDecision
  : K extends "ExecutionPlan"
    ? ExecutionPlan
    : K extends "ManagerDecision"
      ? ManagerDecision
      : K extends "WorkerResult"
        ? WorkerResult
        : ReviewFindings;

export function schemaFor(kind: StructuredOutputKind): z.ZodTypeAny {
  return STRUCTURED_OUTPUT_SCHEMAS[kind];
}
