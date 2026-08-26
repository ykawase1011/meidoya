import type { EmojiRef, RenderedMessage } from "@meidoya/chat-core";
import type {
  ConversationId,
  DomainEvent,
  DomainEventType,
  OutboxAction,
  TaskId,
  WorkspaceId,
} from "@meidoya/domain";
import {
  DEFAULT_SCHEDULED_DELIVERY,
  type InteractionConfig,
  type ScheduledDeliveryMode,
  ruleFor,
  toList,
} from "./config.js";
import { type MessageTemplateKind, type RenderInput, render } from "./renderer.js";

/** Where a reaction goes. The policy stays pure; refs are resolved downstream. */
export type ReactionTarget = { kind: "conversation-root" };

type IntentBase = {
  eventId: string;
  taskId: TaskId;
  workspaceId: WorkspaceId;
  conversationId?: ConversationId;
  idempotencyKey: string;
};

export type OutboxIntent = IntentBase &
  (
    | { action: Extract<OutboxAction, "add-reaction" | "remove-reaction">; emoji: EmojiRef; target: ReactionTarget }
    | { action: Extract<OutboxAction, "post-thread-message">; message: RenderedMessage }
    | {
        action: Extract<OutboxAction, "update-message">;
        message: RenderedMessage;
        /** Idempotency key of the message this edit replaces. */
        targetIdempotencyKey: string;
      }
  );

export type PolicyState = {
  /** Idempotency keys already enqueued for this conversation. */
  emittedIdempotencyKeys?: readonly string[];
  /** Result fingerprint of the previous scheduled run (07 section 8). */
  lastScheduleResultHash?: string;
  /** Delivery mode for this schedule; overrides config when present. */
  scheduledDelivery?: ScheduledDeliveryMode;
};

const TEMPLATE_KIND: Readonly<Partial<Record<DomainEventType, MessageTemplateKind>>> = {
  WaitingClarification: "question",
  WaitingPlanApproval: "plan",
  WaitingReviewApproval: "review",
  WaitingSideEffectApproval: "approval",
  TaskNeedsAttention: "attention",
  TaskCompleted: "result",
  TaskFailed: "failure",
  ScheduleChanged: "schedule",
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string");
  return items.length > 0 ? items : undefined;
}

/**
 * Choices arrive either as plain strings or as the `{ id, label }` rows a
 * HumanCheckpoint stores. Both are structured, operator-facing values, so both
 * are accepted; anything else in the array is dropped.
 */
function choiceList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((v) => {
    if (typeof v === "string") return v.length > 0 ? [v] : [];
    if (typeof v !== "object" || v === null) return [];
    const row = v as Record<string, unknown>;
    const label = str(row["label"]) ?? str(row["id"]);
    return label === undefined ? [] : [label];
  });
  return items.length > 0 ? items : undefined;
}

function linkList(value: unknown): ReadonlyArray<{ label: string; url: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const links = value.flatMap((v) => {
    if (typeof v !== "object" || v === null) return [];
    const label = str((v as Record<string, unknown>)["label"]);
    const url = str((v as Record<string, unknown>)["url"]);
    return label && url ? [{ label, url }] : [];
  });
  return links.length > 0 ? links : undefined;
}

function sectionList(
  value: unknown,
): ReadonlyArray<{ title: string; bullets: readonly string[] }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections = value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const title = str(row["title"]);
    const bullets = strList(row["bullets"]);
    return title === undefined || bullets === undefined ? [] : [{ title, bullets }];
  });
  return sections.length > 0 ? sections : undefined;
}

/**
 * The complete set of payload fields that may reach a rendered message, grouped
 * by the render slot they feed. Emitters legitimately spell "the one line a
 * human must read" differently per event — `question` for a clarification,
 * `prompt` for a checkpoint, `message` for an attention notice, `reason` for a
 * failure — so each slot accepts a short, explicit alias list and the first
 * present alias wins.
 *
 * The whitelist itself is the security boundary (07 section 9): a field that is
 * not named here — rawOutput, logs, stdout, stderr, diff, transcript, prompts
 * fed to the model — has no slot to travel in and therefore no path to the
 * outside world. Widen it only with fields that are already structured,
 * human-facing text.
 */
const RENDER_FIELD_WHITELIST = {
  title: ["title", "reason"],
  summary: ["summary", "question", "prompt", "message", "detail"],
  bullets: ["bullets"],
  sections: ["sections"],
  choices: ["choices"],
  links: ["links"],
} as const satisfies Readonly<Record<keyof Omit<RenderInput, "kind">, readonly string[]>>;

function pick<T>(
  payload: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  coerce: (value: unknown) => T | undefined,
): T | undefined {
  for (const field of fields) {
    const value = coerce(payload[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Builds render input from whitelisted payload fields only. Anything else
 * (raw LLM text, logs, diffs) has no path to the outside world.
 */
function toRenderInput(event: DomainEvent, kind: MessageTemplateKind): RenderInput {
  const p = event.payload;
  const title = pick(p, RENDER_FIELD_WHITELIST.title, str);
  const summary = pick(p, RENDER_FIELD_WHITELIST.summary, str);
  const bullets = pick(p, RENDER_FIELD_WHITELIST.bullets, strList);
  const sections = pick(p, RENDER_FIELD_WHITELIST.sections, sectionList);
  const choices = pick(p, RENDER_FIELD_WHITELIST.choices, choiceList);
  const links = pick(p, RENDER_FIELD_WHITELIST.links, linkList);
  return {
    kind,
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
    ...(bullets === undefined ? {} : { bullets }),
    ...(sections === undefined ? {} : { sections }),
    ...(choices === undefined ? {} : { choices }),
    ...(links === undefined ? {} : { links }),
  };
}

function checkpointKey(event: DomainEvent): string | undefined {
  const id = str(event.payload["checkpointId"]);
  if (!id) return undefined;
  const rawVersion = event.payload["checkpointVersion"];
  const version = typeof rawVersion === "number" ? rawVersion : 1;
  return `checkpoint:${id}:${version}`;
}

/** 07 section 8: identical scheduled result must not notify. */
function scheduledDeliveryAllows(
  event: DomainEvent,
  mode: ScheduledDeliveryMode,
  state: PolicyState
): boolean {
  switch (mode) {
    case "never":
      return false;
    case "always":
      return true;
    case "on-failure":
      return event.type === "TaskFailed" || event.payload["failed"] === true;
    case "on-change": {
      const hash = str(event.payload["resultHash"]);
      if (hash === undefined) return true;
      return hash !== state.lastScheduleResultHash;
    }
  }
}

function isScheduled(event: DomainEvent, state: PolicyState): boolean {
  return (
    state.scheduledDelivery !== undefined ||
    str(event.payload["scheduleId"]) !== undefined ||
    event.type === "ScheduleChanged" ||
    event.type === "ScheduleNoChange"
  );
}

/**
 * The deterministic UX engine: DomainEvent + config -> OutboxIntent[].
 * Pure; no I/O, no clock, no randomness.
 */
export function decideOutboxIntents(
  event: DomainEvent,
  config: InteractionConfig,
  state: PolicyState = {}
): OutboxIntent[] {
  // ScheduleNoChange is absolutely silent, regardless of config.
  if (event.type === "ScheduleNoChange") return [];

  if (isScheduled(event, state)) {
    const mode =
      state.scheduledDelivery ?? config.scheduled_delivery ?? DEFAULT_SCHEDULED_DELIVERY;
    if (!scheduledDeliveryAllows(event, mode, state)) return [];
  }

  const rule = ruleFor(config, event.type);
  const conversationId = str(event.payload["conversationId"]);
  const base = {
    eventId: event.id,
    taskId: event.taskId,
    workspaceId: event.workspaceId,
    ...(conversationId === undefined ? {} : { conversationId }),
  };

  const intents: OutboxIntent[] = [];

  for (const name of toList(rule.reactions?.remove)) {
    intents.push({
      ...base,
      action: "remove-reaction",
      emoji: { name },
      target: { kind: "conversation-root" },
      idempotencyKey: `event:${event.id}:remove-reaction:${name}`,
    });
  }
  for (const name of toList(rule.reactions?.add)) {
    intents.push({
      ...base,
      action: "add-reaction",
      emoji: { name },
      target: { kind: "conversation-root" },
      idempotencyKey: `event:${event.id}:add-reaction:${name}`,
    });
  }

  const wantsMessage = (rule.messages ?? []).includes("thread");
  const kind = TEMPLATE_KIND[event.type];
  if (wantsMessage && kind !== undefined) {
    const maxChars = config.max_message_chars ?? 3000;
    const message = render(toRenderInput(event, kind), { maxChars });
    // 07 section 4: one active message per checkpoint version; repeats edit it.
    const cpKey = checkpointKey(event);
    const key = cpKey ?? `event:${event.id}:post-thread-message`;
    const alreadyEmitted = (state.emittedIdempotencyKeys ?? []).includes(key);
    intents.push(
      alreadyEmitted
        ? {
            ...base,
            action: "update-message",
            message,
            targetIdempotencyKey: key,
            idempotencyKey: `${key}:update:${event.id}`,
          }
        : { ...base, action: "post-thread-message", message, idempotencyKey: key }
    );
  }

  return intents;
}
