import { readFileSync, statSync } from "node:fs";
import type {
  ChatTransport,
  ConversationBinding,
  ConversationDirectory,
  MessageRef,
  ThreadRef,
  TransportKind,
} from "@meidoya/chat-core";
import {
  FakeChatTransport,
  InMemoryConversationDirectory,
  threadKey,
} from "@meidoya/chat-core";
import type { ChatPlatformClient, IngressBinding } from "@meidoya/chat-vercel";
import {
  DiscordPlatformClient,
  DiscordTransport,
  SlackPlatformClient,
  SlackTransport,
} from "@meidoya/chat-vercel";
import type { OutboxRecord, OutboxTargetResolver } from "@meidoya/notification-outbox";
import type { MeidoyaDatabase } from "@meidoya/store-sqlite";
import type { ResolvedControlPlaneConfig } from "./config.js";

/**
 * Runs one conversation write. The daemon passes its serial write queue here so
 * a conversation row can never be written inside an unrelated transaction.
 */
export type ConversationWriteRunner = <T>(fn: () => T) => Promise<T>;

const inlineWriteRunner: ConversationWriteRunner = async (fn) => fn();

export type ConversationRegistration = {
  conversationId: string;
  workspaceId: string;
  thread: ThreadRef;
  rootMessage?: MessageRef;
  ingressBindingId?: string;
};

type ConversationRow = {
  id: string;
  workspace_id: string;
  external_thread_ref: string | null;
  root_message_ref: string | null;
};

type DeliveredMessageRow = {
  conversation_id: string;
  payload_json: string;
};

function parseRef<T extends ThreadRef | MessageRef>(raw: string | null): T | undefined {
  if (raw === null || raw.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const row = parsed as Record<string, unknown>;
    return typeof row["transport"] === "string" && typeof row["channelRef"] === "string"
      ? (parsed as T)
      : undefined;
  } catch {
    // Rows written by an older shape (a bare platform ref) cannot be rebuilt
    // into a binding; skipping one is far better than crashing the daemon.
    return undefined;
  }
}

/**
 * Conversation directory backed by the `conversations` table.
 *
 * The in-memory directory alone is what made notification delivery impossible:
 * nothing registered into it, so every outbox row failed to resolve a thread
 * and ended `failed`. Registration now happens where a conversation is really
 * created (an inbound chat message, or a CLI request), it is persisted, and
 * `load()` re-registers everything on daemon startup so delivery survives a
 * restart.
 */
export class SqliteConversationRegistry implements ConversationDirectory {
  readonly #db: MeidoyaDatabase;
  readonly #directory: InMemoryConversationDirectory;
  readonly #runWrite: ConversationWriteRunner;
  readonly #messageAliases = new Map<string, ConversationBinding>();

  constructor(options: {
    db: MeidoyaDatabase;
    directory?: InMemoryConversationDirectory;
    runWrite?: ConversationWriteRunner;
  }) {
    this.#db = options.db;
    this.#directory = options.directory ?? new InMemoryConversationDirectory();
    this.#runWrite = options.runWrite ?? inlineWriteRunner;
  }

  get directory(): InMemoryConversationDirectory {
    return this.#directory;
  }

  /** Re-registers every persisted conversation. Returns how many were bound. */
  load(): number {
    const rows = this.#db
      .prepare("SELECT id, workspace_id, external_thread_ref, root_message_ref FROM conversations")
      .all() as ConversationRow[];
    let bound = 0;
    for (const row of rows) {
      const thread = parseRef<ThreadRef>(row.external_thread_ref);
      if (thread === undefined) continue;
      const rootMessage = parseRef<MessageRef>(row.root_message_ref);
      this.#directory.register({
        conversationId: row.id,
        workspaceId: row.workspace_id,
        thread,
        ...(rootMessage === undefined ? {} : { rootMessage }),
      });
      bound += 1;
    }
    const delivered = this.#db
      .prepare(
        `SELECT conversation_id, payload_json FROM notification_outbox
         WHERE conversation_id IS NOT NULL AND json_type(payload_json, '$.delivery.ref') = 'object'`,
      )
      .all() as DeliveredMessageRow[];
    for (const row of delivered) {
      let ref: MessageRef | undefined;
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        const delivery = payload["delivery"];
        const raw =
          typeof delivery === "object" && delivery !== null
            ? (delivery as Record<string, unknown>)["ref"]
            : undefined;
        if (typeof raw === "object" && raw !== null) {
          const candidate = raw as Record<string, unknown>;
          if (
            candidate["transport"] === "discord" &&
            typeof candidate["channelRef"] === "string" &&
            typeof candidate["messageRef"] === "string"
          ) {
            ref = {
              transport: "discord",
              channelRef: candidate["channelRef"],
              messageRef: candidate["messageRef"],
            };
          }
        }
      } catch {
        ref = undefined;
      }
      if (ref !== undefined) this.registerMessageAlias(row.conversation_id, ref);
    }
    return bound;
  }

  /** Lets Discord replies to a bot message resolve to the original conversation. */
  registerMessageAlias(conversationId: string, ref: MessageRef): void {
    const binding = this.#directory.findByConversation(conversationId);
    if (binding === undefined) return;
    const alias: ConversationBinding = {
      ...binding,
      thread: {
        transport: ref.transport,
        channelRef: ref.channelRef,
        threadRef: ref.messageRef,
      },
    };
    this.#messageAliases.set(threadKey(alias.thread), alias);
  }

  /**
   * Persists and registers a conversation. Idempotent on the conversation id.
   * `linkTaskId` is written in the SAME queued write, so a crash can never
   * leave a conversation that no task points at.
   */
  async ensure(
    registration: ConversationRegistration,
    options: { linkTaskId?: string } = {},
  ): Promise<ConversationBinding> {
    const binding: ConversationBinding = {
      conversationId: registration.conversationId,
      workspaceId: registration.workspaceId,
      thread: registration.thread,
      ...(registration.rootMessage === undefined ? {} : { rootMessage: registration.rootMessage }),
    };
    await this.#runWrite(() => {
      this.#db
        .prepare(
          `INSERT INTO conversations
             (id, workspace_id, ingress_binding_id, external_thread_ref, root_message_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             external_thread_ref = excluded.external_thread_ref,
             root_message_ref = excluded.root_message_ref`,
        )
        .run(
          binding.conversationId,
          binding.workspaceId,
          registration.ingressBindingId ?? null,
          JSON.stringify(binding.thread),
          binding.rootMessage === undefined ? null : JSON.stringify(binding.rootMessage),
          Date.now(),
        );
      if (options.linkTaskId !== undefined) {
        this.#db
          .prepare("UPDATE tasks SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL")
          .run(binding.conversationId, options.linkTaskId);
      }
    });
    this.#directory.register(binding);
    return binding;
  }

  findByThread(ref: ThreadRef): ConversationBinding | undefined {
    return this.#directory.findByThread(ref) ?? this.#messageAliases.get(threadKey(ref));
  }

  findByConversation(id: string): ConversationBinding | undefined {
    return this.#directory.findByConversation(id);
  }
}

/**
 * Conversation a task's request opens. Chat requests inherit the ingress
 * binding's channel; a CLI request gets its own `cli:` thread so that the very
 * same delivery path (outbox -> transport) runs for both origins.
 */
export function conversationForTask(options: {
  taskId: string;
  workspaceId: string;
  binding?: IngressBinding | undefined;
}): ConversationRegistration {
  const source = options.binding?.source;
  const transport: TransportKind =
    source === "slack" || source === "discord" ? source : "cli";
  const channelRef = options.binding?.channelRef ?? `${transport}:${options.workspaceId}`;
  const thread: ThreadRef = { transport, channelRef, threadRef: options.taskId };
  return {
    conversationId: `conv-${options.taskId}`,
    workspaceId: options.workspaceId,
    thread,
    rootMessage: {
      transport,
      channelRef,
      messageRef: options.taskId,
      threadRef: options.taskId,
    },
    ...(options.binding === undefined ? {} : { ingressBindingId: options.binding.id }),
  };
}

/**
 * Resolves the conversation an outbox row belongs to.
 *
 * The row's own `conversation_id` wins. When it is absent — activities emit
 * events without carrying the conversation down — the row is traced back to its
 * task through the sibling record written in the SAME transaction as the outbox
 * insert: the task event (`event:<eventId>`) or the checkpoint (`<eventId>`).
 */
export function conversationIdOfRecord(
  db: MeidoyaDatabase,
  record: OutboxRecord,
): string | undefined {
  if (record.conversationId !== undefined) return record.conversationId;
  const taskId = taskIdOfRecord(db, record);
  if (taskId === undefined) return undefined;
  // Scoped to the row's own workspace. `taskId` can come from the outbox
  // payload, and a payload is the one place a model-supplied value can reach:
  // an unscoped lookup would resolve another workspace's task and hand its
  // conversation — its Slack thread — to this row's message.
  const row = db
    .prepare("SELECT conversation_id FROM tasks WHERE id = ? AND workspace_id = ?")
    .get(taskId, record.workspaceId) as { conversation_id: string | null } | undefined;
  return row?.conversation_id ?? undefined;
}

function taskIdOfRecord(db: MeidoyaDatabase, record: OutboxRecord): string | undefined {
  const payloadTaskId = record.payload["taskId"];
  if (typeof payloadTaskId === "string" && payloadTaskId.length > 0) return payloadTaskId;
  const event = db
    .prepare("SELECT task_id FROM task_events WHERE idempotency_key = ?")
    .get(`event:${record.eventId}`) as { task_id: string } | undefined;
  if (event !== undefined) return event.task_id;
  const checkpoint = db
    .prepare("SELECT task_id FROM checkpoints WHERE id = ?")
    .get(record.eventId) as { task_id: string } | undefined;
  return checkpoint?.task_id;
}

/**
 * Outbox resolver over the conversation registry. Posted-message refs come from
 * the outbox's own durable delivery receipts, so edits survive a restart; the
 * in-memory map here is only a same-process fast path.
 */
export function createConversationResolver(
  db: MeidoyaDatabase,
  directory: ConversationDirectory,
  posted = new Map<string, MessageRef>(),
): OutboxTargetResolver {
  const binding = (record: OutboxRecord): ConversationBinding | undefined => {
    const conversationId = conversationIdOfRecord(db, record);
    if (conversationId === undefined) return undefined;
    const found = directory.findByConversation(conversationId);
    // Last gate before a message is addressed: the conversation a row is
    // delivered into must belong to the row's own workspace. `findByConversation`
    // is a flat id lookup over every workspace's threads, so without this a
    // conversation id that reached the row from anywhere but our own scoping
    // would post one tenant's text into another tenant's channel.
    if (found === undefined || found.workspaceId !== record.workspaceId) return undefined;
    return found;
  };
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
      if (ref.transport === "discord") {
        const conversationId = conversationIdOfRecord(db, record);
        if (conversationId !== undefined) {
          (
            directory as ConversationDirectory & {
              registerMessageAlias?: (id: string, message: MessageRef) => void;
            }
          ).registerMessageAlias?.(conversationId, ref);
        }
      }
    },
  };
}

export type ChatGateway = {
  /** One transport per ingress source actually configured and credentialed. */
  transports: Map<string, ChatTransport>;
  /** Socket-capable clients whose event streams the daemon supervises. */
  platformClients: Map<string, ChatPlatformClient>;
  directory: InMemoryConversationDirectory;
  /** Persisted conversation directory; undefined when no database was given. */
  conversations?: SqliteConversationRegistry;
  /** Transport the outbox publisher dispatches through. */
  defaultTransport: ChatTransport;
  bound: string[];
};

export type ChatGatewayOptions = {
  config: ResolvedControlPlaneConfig;
  env?: NodeJS.ProcessEnv;
  /** Injected for the local demo and tests; bypasses all credentials. */
  transportOverride?: ChatTransport;
  /** Enables the persisted conversation directory. */
  db?: MeidoyaDatabase;
  /** Serial write queue for conversation rows. */
  runWrite?: ConversationWriteRunner;
  /** Injected socket clients for ingress lifecycle tests. */
  platformClients?: readonly ChatPlatformClient[];
};

function secretFromEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name]?.trim();
  if (direct !== undefined && direct.length > 0) return direct;
  const file = env[`${name}_FILE`]?.trim();
  if (file === undefined || file.length === 0) return undefined;
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    throw new Error(`${name}_FILE must not be readable or writable by group/other: ${file}`);
  }
  const value = readFileSync(file, "utf8").trim();
  return value.length === 0 ? undefined : value;
}

class RoutedChatTransport implements ChatTransport {
  readonly #transports: ReadonlyMap<string, ChatTransport>;
  readonly #local: ChatTransport;

  constructor(transports: ReadonlyMap<string, ChatTransport>) {
    this.#transports = transports;
    this.#local = new FakeChatTransport();
  }

  #for(kind: TransportKind): ChatTransport {
    const transport = this.#transports.get(kind);
    if (transport !== undefined) return transport;
    if (kind === "cli" || kind === "fake") return this.#local;
    throw new Error(`no credentialed ${kind} chat transport is available`);
  }

  addReaction(ref: MessageRef, emoji: Parameters<ChatTransport["addReaction"]>[1]): Promise<void> {
    return this.#for(ref.transport).addReaction(ref, emoji);
  }

  removeReaction(
    ref: MessageRef,
    emoji: Parameters<ChatTransport["removeReaction"]>[1],
  ): Promise<void> {
    return this.#for(ref.transport).removeReaction(ref, emoji);
  }

  postThreadMessage(
    ref: ThreadRef,
    message: Parameters<ChatTransport["postThreadMessage"]>[1],
  ): Promise<MessageRef> {
    return this.#for(ref.transport).postThreadMessage(ref, message);
  }

  updateMessage(
    ref: MessageRef,
    message: Parameters<ChatTransport["updateMessage"]>[1],
  ): Promise<void> {
    return this.#for(ref.transport).updateMessage(ref, message);
  }
}

/**
 * Binds ingress rows to chat transports. A binding without credentials is
 * skipped rather than guessed at, and with no transport at all the outbox
 * dispatches into an in-memory transport so task state still progresses.
 */
export function createChatGateway(options: ChatGatewayOptions): ChatGateway {
  const env = options.env ?? process.env;
  const transports = new Map<string, ChatTransport>();
  const platformClients = new Map<string, ChatPlatformClient>(
    (options.platformClients ?? []).map((client) => [client.kind, client]),
  );
  const bound: string[] = [];

  if (options.transportOverride === undefined) {
    for (const binding of options.config.ingressBindings) {
      if (binding.source === "slack" && !transports.has("slack")) {
        let client = platformClients.get("slack");
        if (client === undefined) {
          const botToken = secretFromEnv(env, "MEIDOYA_SLACK_BOT_TOKEN");
          if (botToken !== undefined) {
            const appToken = secretFromEnv(env, "MEIDOYA_SLACK_APP_TOKEN");
            client = new SlackPlatformClient({
              botToken,
              ...(appToken === undefined ? {} : { appToken }),
            });
            platformClients.set("slack", client);
          }
        }
        if (client !== undefined) {
          transports.set("slack", new SlackTransport(client));
          bound.push(`slack:${binding.workspaceId}`);
        }
      }
      if (binding.source === "discord" && !transports.has("discord")) {
        let client = platformClients.get("discord");
        if (client === undefined) {
          const botToken = secretFromEnv(env, "MEIDOYA_DISCORD_BOT_TOKEN");
          if (botToken !== undefined) {
            client = new DiscordPlatformClient({ botToken });
            platformClients.set("discord", client);
          }
        }
        if (client !== undefined) {
          transports.set("discord", new DiscordTransport(client));
          bound.push(`discord:${binding.workspaceId}`);
        }
      }
    }
  }

  const defaultTransport =
    options.transportOverride ??
    new RoutedChatTransport(transports);

  const directory = new InMemoryConversationDirectory();
  const conversations =
    options.db === undefined
      ? undefined
      : new SqliteConversationRegistry({
          db: options.db,
          directory,
          ...(options.runWrite === undefined ? {} : { runWrite: options.runWrite }),
        });
  // A restart must not lose the threads notifications are delivered into.
  conversations?.load();

  return {
    transports,
    platformClients,
    directory,
    ...(conversations === undefined ? {} : { conversations }),
    defaultTransport,
    bound,
  };
}

/** Just enough of the control event bus to hear about accepted requests. */
export type RequestEventSource = {
  subscribe(listener: (event: { type: string; workspaceId: string; taskId: string }) => void): () => void;
};

export type ChatDeliveryWiringOptions = {
  gateway: ChatGateway;
  config: ResolvedControlPlaneConfig;
  db: MeidoyaDatabase;
  /** Accepted requests are what open conversations. */
  events: RequestEventSource;
  /** Reports a registration failure; delivery is best-effort, never fatal. */
  onError?: (error: unknown) => void;
};

export type ChatDeliveryWiring = {
  /**
   * Opens (or re-opens) the conversation a request's task delivers into. Called
   * for every accepted request, whatever its origin, and idempotent per task.
   */
  onRequestAccepted(event: { workspaceId: string; taskId: string }): Promise<void>;
  /**
   * Opens the conversation of every task that still has none. Returns how many
   * were repaired.
   *
   * Registration hangs off a non-durable, in-process event bus and is started
   * with `void`, so the only thing between "the task was accepted" and "the
   * task has a thread to be notified in" is a promise nobody holds. A crash
   * between the two — or a listener that threw, which the bus swallows —
   * leaves a task whose every outbox row can never resolve a thread and
   * dead-letters, silently and forever, because nothing retries registration.
   *
   * This is that retry. It is idempotent (`ensure` upserts, and the task link
   * is written only `WHERE conversation_id IS NULL`), so running it at startup
   * and on a timer costs nothing when there is nothing to fix.
   */
  reconcileConversations(options?: { limit?: number }): Promise<number>;
  /** Resolver the outbox publisher dispatches through. */
  resolver: OutboxTargetResolver;
  /** Detaches the subscription; the daemon calls this while draining. */
  stop(): void;
};

/**
 * Wires request acceptance to conversation registration. Without this, nothing
 * ever calls `register()` and every notification fails to resolve a thread —
 * which is precisely why no notification had ever been delivered.
 */
export function createChatDeliveryWiring(
  options: ChatDeliveryWiringOptions,
): ChatDeliveryWiring | undefined {
  const registry = options.gateway.conversations;
  if (registry === undefined) return undefined;
  // A request accepted over the Control Plane API has no external thread of its
  // own, so it opens a `cli:` conversation. An inbound chat message registers
  // its real thread through `registry.ensure` at the ingress instead.
  const bindingOf = (workspaceId: string): IngressBinding | undefined =>
    options.config.ingressBindings.find(
      (b) => b.workspaceId === workspaceId && b.enabled && b.source === "cli",
    );

  /** Throws on failure; the two callers below decide what that means. */
  const register = async (event: { workspaceId: string; taskId: string }): Promise<void> => {
    const task = options.db
      .prepare("SELECT conversation_id FROM tasks WHERE id = ? AND workspace_id = ?")
      .get(event.taskId, event.workspaceId) as { conversation_id: string | null } | undefined;
    // Chat ingress creates and links its real external conversation before it
    // submits the task. Never overwrite it with a synthetic CLI thread.
    if (task?.conversation_id !== null && task?.conversation_id !== undefined) return;
    const registration = conversationForTask({
      taskId: event.taskId,
      workspaceId: event.workspaceId,
      binding: bindingOf(event.workspaceId),
    });
    await registry.ensure(registration, { linkTaskId: event.taskId });
  };

  const onRequestAccepted = async (event: {
    workspaceId: string;
    taskId: string;
  }): Promise<void> => {
    try {
      await register(event);
    } catch (error) {
      // Best-effort on the hot path: an accepted request is not failed because
      // its thread could not be opened. `reconcileConversations` is what makes
      // sure the failure is temporary rather than permanent.
      options.onError?.(error);
    }
  };

  const reconcileConversations = async (
    reconcileOptions: { limit?: number } = {},
  ): Promise<number> => {
    const rows = options.db
      .prepare(
        `SELECT id, workspace_id FROM tasks
         WHERE conversation_id IS NULL
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(reconcileOptions.limit ?? 200) as { id: string; workspace_id: string }[];
    let repaired = 0;
    for (const row of rows) {
      // Per row, because one workspace's failure must not strand the rest.
      try {
        await register({ workspaceId: row.workspace_id, taskId: row.id });
        repaired += 1;
      } catch (error) {
        options.onError?.(error);
      }
    }
    return repaired;
  };

  const unsubscribe = options.events.subscribe((event) => {
    if (event.type !== "RequestAccepted") return;
    void onRequestAccepted({ workspaceId: event.workspaceId, taskId: event.taskId });
  });

  return {
    onRequestAccepted,
    reconcileConversations,
    resolver: createConversationResolver(options.db, registry),
    stop: unsubscribe,
  };
}
