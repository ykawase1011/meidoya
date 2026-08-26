import type {
  ChatTransport,
  ConversationDirectory,
  EmojiRef,
  MessageRef,
  RenderedMessage,
  ThreadRef,
} from "@meidoya/chat-core";
import type { MeidoyaDatabase } from "@meidoya/store-sqlite";
import {
  type BackoffOptions,
  type DeadLetterSink,
  type DeliveryReceipt,
  type OutboxRecord,
  claimPending,
  deliveryOf,
  emitDeadLetter,
  getByIdempotencyKey,
  markFailure,
  markSent,
  reclaimStaleClaims,
  recordDelivery,
} from "./repository.js";

/** Resolves outbox rows to concrete platform refs. Injected, so it stays testable. */
export interface OutboxTargetResolver {
  /** Message that reactions attach to (usually the inbound request message). */
  reactionTarget(record: OutboxRecord): Promise<MessageRef | undefined>;
  thread(record: OutboxRecord): Promise<ThreadRef | undefined>;
  /** Previously posted message for an idempotency key, for `update-message`. */
  postedMessage(idempotencyKey: string): Promise<MessageRef | undefined>;
  onPosted(record: OutboxRecord, ref: MessageRef): Promise<void>;
}

export function createDirectoryResolver(
  directory: ConversationDirectory,
  posted = new Map<string, MessageRef>()
): OutboxTargetResolver {
  const binding = (record: OutboxRecord) =>
    record.conversationId === undefined
      ? undefined
      : directory.findByConversation(record.conversationId);
  return {
    async reactionTarget(record) {
      return binding(record)?.rootMessage;
    },
    async thread(record) {
      return binding(record)?.thread;
    },
    async postedMessage(key) {
      return posted.get(key);
    },
    async onPosted(record, ref) {
      posted.set(record.idempotencyKey, ref);
    },
  };
}

function emojiOf(record: OutboxRecord): EmojiRef | undefined {
  const raw = record.payload["emoji"];
  if (typeof raw === "string") return { name: raw };
  if (typeof raw === "object" && raw !== null) {
    const name = (raw as Record<string, unknown>)["name"];
    if (typeof name === "string") return { name };
  }
  return undefined;
}

function messageOf(record: OutboxRecord): RenderedMessage | undefined {
  const raw = record.payload["message"];
  if (typeof raw !== "object" || raw === null) return undefined;
  const message = raw as Record<string, unknown>;
  const text = message["text"];
  if (typeof text !== "string") return undefined;
  const stringValue = (key: string): string | undefined => {
    const value = message[key];
    return typeof value === "string" ? value : undefined;
  };
  const stringList = (key: string): string[] | undefined => {
    const value = message[key];
    if (!Array.isArray(value)) return undefined;
    const items = value.filter((item): item is string => typeof item === "string");
    return items.length > 0 ? items : undefined;
  };
  const rawSections = message["sections"];
  const sections = Array.isArray(rawSections)
    ? rawSections.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const title = (entry as Record<string, unknown>)["title"];
        const bullets = (entry as Record<string, unknown>)["bullets"];
        if (typeof title !== "string" || !Array.isArray(bullets)) return [];
        const items = bullets.filter((item): item is string => typeof item === "string");
        return items.length === 0 ? [] : [{ title, bullets: items }];
      })
    : [];
  const rawLinks = message["links"];
  const links = Array.isArray(rawLinks)
    ? rawLinks.flatMap((l) => {
        if (typeof l !== "object" || l === null) return [];
        const label = (l as Record<string, unknown>)["label"];
        const url = (l as Record<string, unknown>)["url"];
        return typeof label === "string" && typeof url === "string" ? [{ label, url }] : [];
      })
    : [];
  const title = stringValue("title");
  const summary = stringValue("summary");
  const tone = stringValue("tone");
  const bullets = stringList("bullets");
  const choices = stringList("choices");
  return {
    text,
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
    ...(tone === "info" || tone === "success" || tone === "warning" || tone === "danger"
      ? { tone }
      : {}),
    ...(bullets === undefined ? {} : { bullets }),
    ...(sections.length === 0 ? {} : { sections }),
    ...(choices === undefined ? {} : { choices }),
    ...(links.length === 0 ? {} : { links }),
  };
}

function toMessageRef(value: Record<string, unknown> | undefined): MessageRef | undefined {
  if (value === undefined) return undefined;
  const transport = value["transport"];
  const channelRef = value["channelRef"];
  const messageRef = value["messageRef"];
  if (
    typeof transport !== "string" ||
    typeof channelRef !== "string" ||
    typeof messageRef !== "string"
  ) {
    return undefined;
  }
  const threadRef = value["threadRef"];
  return {
    transport: transport as MessageRef["transport"],
    channelRef,
    messageRef,
    ...(typeof threadRef === "string" ? { threadRef } : {}),
  };
}

/**
 * Ref of the message a previous row posted under `key`. The durable receipt on
 * the row wins, so an edit still finds its target after a daemon restart; the
 * resolver's in-memory map is the fallback.
 *
 * WORKSPACE-GATED, and that gate is the whole reason this takes `record`.
 * `idempotency_key` is globally UNIQUE, so a key names exactly one row across
 * every tenant, and `targetIdempotencyKey` arrives in a row's PAYLOAD — the one
 * place a value the control plane did not choose can reach. An unscoped lookup
 * therefore handed one workspace the platform message ref of another's, and
 * `update-message` rewrote a foreign message in a foreign channel. That path
 * never consults the resolver's conversation lookup at all, so the workspace
 * check in the daemon's resolver (see chat-gateway.ts) could not see it: an
 * edit addresses a MESSAGE, not a thread. The check has to live here.
 */
async function targetOf(
  db: MeidoyaDatabase,
  resolver: OutboxTargetResolver,
  record: OutboxRecord,
  key: string
): Promise<MessageRef | undefined> {
  const row = getByIdempotencyKey(db, key);
  if (row !== undefined && row.workspaceId !== record.workspaceId) return undefined;
  const receipt = row === undefined ? undefined : deliveryOf(row);
  return toMessageRef(receipt?.ref) ?? (await resolver.postedMessage(key));
}

/**
 * What one dispatch produced. `newPost` is set only when this row created a NEW
 * platform message that later `update-message` rows have to be able to find.
 *
 * It is returned rather than announced from inside `dispatch` on purpose:
 * `resolver.onPosted` is a public async interface, and awaiting it inside the
 * transport try meant a resolver that rejected AFTER a successful post was
 * indistinguishable from "nothing reached the platform" — the row was
 * rescheduled and the message posted a second time.
 */
type Dispatched = {
  ref?: MessageRef;
  newPost?: MessageRef;
};

async function dispatch(
  db: MeidoyaDatabase,
  record: OutboxRecord,
  transport: ChatTransport,
  resolver: OutboxTargetResolver
): Promise<Dispatched> {
  switch (record.action) {
    case "add-reaction":
    case "remove-reaction": {
      const emoji = emojiOf(record);
      const target = await resolver.reactionTarget(record);
      if (!emoji || !target) throw new Error(`unresolved reaction target for ${record.id}`);
      if (record.action === "add-reaction") await transport.addReaction(target, emoji);
      else await transport.removeReaction(target, emoji);
      return {};
    }
    case "post-thread-message": {
      const message = messageOf(record);
      const thread = await resolver.thread(record);
      if (!message || !thread) throw new Error(`unresolved thread for ${record.id}`);
      const ref = await transport.postThreadMessage(thread, message);
      return { ref, newPost: ref };
    }
    case "update-message": {
      const message = messageOf(record);
      const key = record.payload["targetIdempotencyKey"];
      if (!message || typeof key !== "string") {
        throw new Error(`invalid update-message row ${record.id}`);
      }
      const ref = await targetOf(db, resolver, record, key);
      if (!ref) throw new Error(`no posted message for ${key}`);
      await transport.updateMessage(ref, message);
      return { ref };
    }
  }
}

export type PublishResult = {
  claimed: number;
  sent: number;
  failed: number;
  /** Rows that were already delivered and only needed their status repaired. */
  deduplicated: number;
  /**
   * Rows this pass GAVE UP ON — they will never be delivered. Counted apart
   * from `failed` (which includes rows merely rescheduled) because these are
   * the ones a human has to hear about; every one of them also went to the
   * dead-letter sink.
   */
  deadLettered: number;
};

/** Which write the publisher is asking for; lets hosts label and test them. */
export type OutboxWriteKind = "claim" | "record-delivery" | "mark-sent" | "mark-failure";

/**
 * Runs one outbox write. The daemon injects a runner that hands the statement
 * to its serial write queue, so an outbox write can never execute inside — and
 * be rolled back by — some other component's open transaction. The default
 * runs the statement inline, which is what a standalone test wants.
 */
export type OutboxWriteRunner = <T>(kind: OutboxWriteKind, fn: () => T) => Promise<T>;

const inlineWriteRunner: OutboxWriteRunner = async (_kind, fn) => fn();

export type PublishOptions = BackoffOptions & {
  now?: number;
  limit?: number;
  /** Claim lease; a `sending` row past it is reclaimed and retried. */
  leaseMs?: number;
  runWrite?: OutboxWriteRunner;
  /**
   * Where a notification the outbox gives up on is reported. Defaults to
   * `console.error`; there is deliberately no way to silence it by omission.
   */
  onDeadLetter?: DeadLetterSink;
};

/**
 * In-process memory of "the transport already took this row", for the window
 * where the send succeeded but persisting that fact did not (SQLITE_BUSY, or
 * the host's write queue closing during shutdown). The durable receipt is
 * still the primary mechanism — this only covers the process that did the
 * send, until one of its later passes manages to write the receipt down.
 *
 * Keyed by database handle so tests (and multi-db hosts) never bleed into one
 * another, and weak so a closed database's journal is collectable.
 */
const deliveryJournal = new WeakMap<MeidoyaDatabase, Map<string, DeliveryReceipt>>();

function journalDelivery(db: MeidoyaDatabase, id: string, receipt: DeliveryReceipt): void {
  const existing = deliveryJournal.get(db);
  if (existing === undefined) deliveryJournal.set(db, new Map([[id, receipt]]));
  else existing.set(id, receipt);
}

function journaledDelivery(db: MeidoyaDatabase, id: string): DeliveryReceipt | undefined {
  return deliveryJournal.get(db)?.get(id);
}

function forgetDelivery(db: MeidoyaDatabase, id: string): void {
  deliveryJournal.get(db)?.delete(id);
}

/**
 * Rows this process is dispatching right now, so an overlapping pass cannot
 * reclaim a transport call that is merely slow. See ClaimOptions.excludeIds.
 */
const inFlight = new WeakMap<MeidoyaDatabase, Set<string>>();

function inFlightIds(db: MeidoyaDatabase): Set<string> {
  const existing = inFlight.get(db);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  inFlight.set(db, created);
  return created;
}

/** Platform cool-down hint, read structurally so no transport package is imported. */
function retryAfterMsOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The transport's own verdict that this failure will not become a success:
 * `ChatTransportError.retryable === false` (rejected auth, an unknown channel,
 * a payload the platform refuses). Read structurally, like the cool-down hint,
 * so the outbox stays independent of any transport package.
 *
 * Fails SAFE: only an explicit `false` is terminal. An error carrying no
 * verdict — a plain `Error`, an unresolved-target failure raised by `dispatch`
 * itself — keeps the ordinary backoff-and-retry path.
 */
function isTerminalTransportError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { retryable?: unknown }).retryable === false;
}

/**
 * One publisher pass: claim due rows, dispatch, mark sent, and on transport
 * failure reschedule with backoff. Task state is never rolled back here.
 *
 * The success path is durable in two steps: the delivery receipt is written
 * before the row is marked sent, so a crash (or a failing `markSent`) between
 * THOSE TWO leaves a reclaimable row that skips the transport instead of
 * posting the same message twice.
 *
 * It does NOT make delivery exactly-once, and nothing here can. `ChatTransport`
 * carries no idempotency token, so the post's only record is the receipt this
 * function writes AFTER the transport returns; a process killed in that window
 * has posted a message it holds no receipt for, and the reclaimed row posts it
 * again. The in-process journal covers the same window for a process that
 * survives, not for one that dies. The guarantee is at-least-once — see the
 * note on `ChatTransport` — and duplication is the direction chosen on purpose.
 *
 * The two halves of a row's handling are failure-isolated on purpose. A
 * DISPATCH failure means the message does not exist and the row is rescheduled.
 * A failure AFTER a successful dispatch is bookkeeping only: the message
 * exists, so the row is never rescheduled and never re-dispatched — the only
 * thing outstanding is recording what already happened.
 */
export async function publishOnce(
  db: MeidoyaDatabase,
  transport: ChatTransport,
  resolver: OutboxTargetResolver,
  options: PublishOptions = {}
): Promise<PublishResult> {
  const now = options.now ?? Date.now();
  const runWrite = options.runWrite ?? inlineWriteRunner;
  const busy = inFlightIds(db);
  const records = await runWrite("claim", () =>
    claimPending(db, {
      now,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.onDeadLetter === undefined ? {} : { onDeadLetter: options.onDeadLetter }),
      ...(busy.size === 0 ? {} : { excludeIds: [...busy] }),
    })
  );
  for (const record of records) busy.add(record.id);
  const result: PublishResult = {
    claimed: records.length,
    sent: 0,
    failed: 0,
    deduplicated: 0,
    deadLettered: 0,
  };

  try {
    await publishClaimed(db, transport, resolver, records, result, now, runWrite, options);
  } finally {
    for (const record of records) busy.delete(record.id);
  }
  return result;
}

async function publishClaimed(
  db: MeidoyaDatabase,
  transport: ChatTransport,
  resolver: OutboxTargetResolver,
  records: readonly OutboxRecord[],
  result: PublishResult,
  now: number,
  runWrite: OutboxWriteRunner,
  options: PublishOptions
): Promise<void> {
  for (const record of records) {
    const alreadyDelivered = deliveryOf(record) ?? journaledDelivery(db, record.id);
    if (alreadyDelivered !== undefined) {
      // The transport already accepted this exact row; only the bookkeeping is
      // outstanding. Re-posting here is the duplicate-send bug.
      const closed = await runWrite("mark-sent", () =>
        markSent(db, record.id, now, alreadyDelivered, record.claimToken)
      ).catch(() => false);
      if (closed) forgetDelivery(db, record.id);
      result.sent += 1;
      result.deduplicated += 1;
      continue;
    }

    let dispatched: Dispatched;
    try {
      dispatched = await dispatch(db, record, transport, resolver);
    } catch (error) {
      // Nothing reached the platform: reschedule, or dead-letter when the
      // transport says retrying cannot help.
      const retryAfterMs = retryAfterMsOf(error);
      const terminal = isTerminalTransportError(error);
      const outcome = await runWrite("mark-failure", () =>
        markFailure(db, record, {
          ...options,
          now,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          ...(terminal ? { terminal: true } : {}),
        })
      ).catch(() => undefined);
      // Every give-up is announced. A dead-letter nobody can see is how a whole
      // backlog disappeared without a trace.
      if (outcome?.status === "failed" && outcome.applied) {
        result.deadLettered += 1;
        emitDeadLetter(options.onDeadLetter, {
          id: record.id,
          workspaceId: record.workspaceId,
          ...(record.conversationId === undefined
            ? {}
            : { conversationId: record.conversationId }),
          eventId: record.eventId,
          action: record.action,
          idempotencyKey: record.idempotencyKey,
          attempt: record.attempt + 1,
          origin: "dispatch",
          reason: terminal ? "terminal" : "attempts-exhausted",
          error,
        });
      }
      result.failed += 1;
      continue;
    }
    const ref = dispatched.ref;

    // Past this line the message EXISTS. Everything below is bookkeeping, and
    // no bookkeeping failure may ever turn into a second post: that is why the
    // journal is written first (it cannot throw) and why there is no
    // markFailure in this branch.
    const receipt: DeliveryReceipt = {
      ...(ref === undefined ? {} : { ref: ref as unknown as Record<string, unknown> }),
      at: now,
    };
    journalDelivery(db, record.id, receipt);
    try {
      // Announcing the post to the resolver is bookkeeping like the rest: a
      // resolver that rejects here must never re-run the transport call.
      if (dispatched.newPost !== undefined) {
        await resolver.onPosted(record, dispatched.newPost);
      }
      await runWrite("record-delivery", () => recordDelivery(db, record.id, receipt));
      const closed = await runWrite("mark-sent", () =>
        markSent(db, record.id, now, receipt, record.claimToken)
      );
      if (closed) forgetDelivery(db, record.id);
    } catch {
      // The row keeps its lease and is reclaimed later; the journal (or, if the
      // receipt did land, the row itself) makes that pass a dedup, not a post.
    }
    result.sent += 1;
  }
}

export type PublisherLoopOptions = PublishOptions & {
  intervalMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** Set false to skip the startup sweep (tests that drive claims by hand). */
  sweepOnStart?: boolean;
  /** Where a pass-level failure is reported. Defaults to `console.error`. */
  onError?: (error: unknown, consecutiveFailures: number) => void;
  /** Cap on the error backoff between passes. */
  maxErrorBackoffMs?: number;
};

const DEFAULT_MAX_ERROR_BACKOFF_MS = 30_000;

/**
 * Long-running loop; stops on abort. Starts by sweeping rows whose lease a
 * previous process left expired, so a crashed dispatch is retried immediately
 * rather than waiting out the poll interval.
 *
 * A pass that throws must never end the loop. `claimPending` can fail for
 * entirely transient reasons (`SQLITE_BUSY`, and a WAL snapshot upgrade that
 * `busy_timeout` does not retry reports plain "database is locked"); letting
 * that escape used to kill the publisher for the life of the process, silently
 * — no notification would ever be delivered again and nothing was logged. So
 * every pass is contained, reported, and followed by a backoff that grows while
 * failures persist, so a hard-down database is not hot-looped either.
 */
export async function runPublisherLoop(
  db: MeidoyaDatabase,
  transport: ChatTransport,
  resolver: OutboxTargetResolver,
  options: PublisherLoopOptions = {}
): Promise<void> {
  const runWrite = options.runWrite ?? inlineWriteRunner;
  if (options.sweepOnStart !== false) {
    await runWrite("claim", () =>
      reclaimStaleClaims(db, {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
        ...(options.onDeadLetter === undefined ? {} : { onDeadLetter: options.onDeadLetter }),
      })
    ).catch(() => 0);
  }
  const intervalMs = options.intervalMs ?? 1_000;
  const maxBackoffMs = options.maxErrorBackoffMs ?? DEFAULT_MAX_ERROR_BACKOFF_MS;
  const onError =
    options.onError ??
    ((error: unknown, failures: number) => {
      console.error(`[outbox] publisher pass failed (${failures} in a row)`, error);
    });
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Function call, not a narrowed property read: the flag flips across awaits.
  const aborted = (): boolean => options.signal?.aborted === true;
  let failures = 0;
  while (!aborted()) {
    try {
      await publishOnce(db, transport, resolver, options);
      failures = 0;
    } catch (error) {
      failures += 1;
      try {
        onError(error, failures);
      } catch {
        // A broken reporter must not be able to kill the loop either.
      }
    }
    if (aborted()) return;
    const delay =
      failures === 0
        ? intervalMs
        : Math.min(maxBackoffMs, Math.max(intervalMs, 1) * 2 ** Math.min(failures, 20));
    await sleep(delay);
  }
}
