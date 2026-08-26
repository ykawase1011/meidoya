import type { DomainEventType } from "@meidoya/domain";

/** Delivery mode for scheduled tasks (07 section 8). */
export type ScheduledDeliveryMode = "always" | "on-change" | "on-failure" | "never";

export const DEFAULT_SCHEDULED_DELIVERY: ScheduledDeliveryMode = "on-change";

export type MessageChannel = "thread";

/** Per-event rule, shaped like the `interaction:` block of config.example.yaml. */
export type EventRule = {
  reactions?: {
    /** Emoji names to add, platform-neutral (e.g. "eyes"). */
    add?: string | readonly string[];
    /** Emoji names to remove before adding, e.g. clearing prior status. */
    remove?: string | readonly string[];
  };
  /** Empty array (or omitted) means: no external message at all. */
  messages?: readonly MessageChannel[];
};

/** Config keys are snake_case like the YAML; see EVENT_CONFIG_KEY. */
export type InteractionConfig = {
  request_accepted?: EventRule;
  task_started?: EventRule;
  task_progressed?: EventRule;
  waiting_clarification?: EventRule;
  waiting_plan_approval?: EventRule;
  waiting_review_approval?: EventRule;
  waiting_side_effect_approval?: EventRule;
  task_needs_attention?: EventRule;
  maid_responded?: EventRule;
  task_completed?: EventRule;
  task_failed?: EventRule;
  schedule_no_change?: EventRule;
  schedule_changed?: EventRule;
  /** Character budget for one rendered message on this transport. */
  max_message_chars?: number;
  scheduled_delivery?: ScheduledDeliveryMode;
};

export type EventConfigKey = keyof Omit<
  InteractionConfig,
  "max_message_chars" | "scheduled_delivery"
>;

export const EVENT_CONFIG_KEY: Readonly<Record<DomainEventType, EventConfigKey>> = {
  RequestAccepted: "request_accepted",
  TaskStarted: "task_started",
  TaskProgressed: "task_progressed",
  WaitingClarification: "waiting_clarification",
  WaitingPlanApproval: "waiting_plan_approval",
  WaitingReviewApproval: "waiting_review_approval",
  WaitingSideEffectApproval: "waiting_side_effect_approval",
  TaskNeedsAttention: "task_needs_attention",
  MaidResponded: "maid_responded",
  TaskCompleted: "task_completed",
  TaskFailed: "task_failed",
  ScheduleNoChange: "schedule_no_change",
  ScheduleChanged: "schedule_changed",
};

/**
 * The default event matrix from 07-interaction-policy.md section 2, expressed
 * as config so environment / workspace / transport overrides are just a merge.
 */
export const DEFAULT_INTERACTION_CONFIG: Required<
  Pick<InteractionConfig, EventConfigKey>
> &
  InteractionConfig = {
  request_accepted: { reactions: { add: "eyes" }, messages: [] },
  task_started: { messages: [] },
  task_progressed: { messages: [] },
  waiting_clarification: { reactions: { add: "question" }, messages: ["thread"] },
  waiting_plan_approval: { reactions: { add: "memo" }, messages: ["thread"] },
  waiting_review_approval: { reactions: { add: "mag" }, messages: ["thread"] },
  waiting_side_effect_approval: { reactions: { add: "no_entry" }, messages: ["thread"] },
  task_needs_attention: { reactions: { add: "warning" }, messages: ["thread"] },
  maid_responded: {
    reactions: { remove: ["eyes", "question", "memo", "mag", "no_entry", "warning"] },
    messages: ["thread"],
  },
  task_completed: {
    reactions: {
      remove: ["eyes", "question", "memo", "mag", "no_entry", "warning"],
      add: "white_check_mark",
    },
    messages: ["thread"],
  },
  task_failed: { reactions: { add: "warning" }, messages: ["thread"] },
  schedule_no_change: { messages: [] },
  schedule_changed: { messages: ["thread"] },
  max_message_chars: 3000,
  scheduled_delivery: DEFAULT_SCHEDULED_DELIVERY,
};

function mergeRule(base: EventRule | undefined, override: EventRule | undefined): EventRule {
  if (!override) return base ?? {};
  if (!base) return override;
  const reactions =
    override.reactions === undefined && base.reactions === undefined
      ? undefined
      : { ...base.reactions, ...override.reactions };
  return {
    ...(reactions === undefined ? {} : { reactions }),
    ...(override.messages === undefined
      ? base.messages === undefined
        ? {}
        : { messages: base.messages }
      : { messages: override.messages }),
  };
}

/**
 * Layered override: environment -> workspace -> transport, each layer partial.
 * Later layers win per event key; a layer that omits a key inherits it.
 */
export function resolveInteractionConfig(
  ...layers: ReadonlyArray<InteractionConfig | undefined>
): InteractionConfig {
  let acc: InteractionConfig = { ...DEFAULT_INTERACTION_CONFIG };
  for (const layer of layers) {
    if (!layer) continue;
    const next: InteractionConfig = { ...acc };
    for (const key of Object.values(EVENT_CONFIG_KEY)) {
      const merged = mergeRule(acc[key], layer[key]);
      next[key] = merged;
    }
    if (layer.max_message_chars !== undefined) next.max_message_chars = layer.max_message_chars;
    if (layer.scheduled_delivery !== undefined) next.scheduled_delivery = layer.scheduled_delivery;
    acc = next;
  }
  return acc;
}

export function ruleFor(config: InteractionConfig, type: DomainEventType): EventRule {
  return config[EVENT_CONFIG_KEY[type]] ?? {};
}

export function toList(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}
