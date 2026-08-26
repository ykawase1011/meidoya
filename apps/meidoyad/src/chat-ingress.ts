import { createHash } from "node:crypto";
import type { MessageRef } from "@meidoya/chat-core";
import {
  InMemoryIngressBindingDirectory,
  inboundThreadRef,
  ingressKeyOf,
  resolveInboundReply,
  resolveIngressBinding,
  type InboundChatEvent,
  type IngressBinding,
  type PendingCheckpoint,
  type PendingCheckpointDirectory,
  type PlatformEventStream,
} from "@meidoya/chat-vercel";
import type { HumanCheckpoint } from "@meidoya/domain";
import type { MethodParams, MethodResult, ResolvedScope } from "@meidoya/protocol";
import type { ResolvedControlPlaneConfig } from "./config.js";
import type { ControlPlaneService } from "./api.js";
import type { SqliteTaskRepository } from "./repository.js";
import type { ScopeRegistry } from "./scope.js";
import type { ChatGateway } from "./chat-gateway.js";

const APPROVAL_KINDS = new Set(["plan-approval", "review-approval", "side-effect-approval"]);
const APPROVE = /^(?:a|approve|approved|ok|yes|承認|了承|はい)(?:します|でお願いします)?[.!。！]?$/iu;
const REJECT = /^(?:r|reject|rejected|no|却下|拒否|いいえ|キャンセル)(?:します)?[.!。！]?$/iu;

type ChatIngressService = Pick<
  ControlPlaneService,
  "createTask" | "getCheckpoint" | "answerCheckpoint"
>;

type ChatIngressScopes = Pick<ScopeRegistry, "mintForBinding" | "resolve" | "projectsOf">;

export type ChatIngressResult =
  | { kind: "task-created"; taskId: string; workspaceId: string }
  | { kind: "checkpoint-answered"; checkpointId: string; workspaceId: string }
  | { kind: "rejected"; reason: string };

export type ChatIngress = {
  /** Opens every configured and credentialed Socket Mode / Gateway stream. */
  start(): Promise<void>;
  /** Serial, idempotent entry point also used directly by tests. */
  handle(event: InboundChatEvent): Promise<ChatIngressResult>;
  /** Stops accepting events, drains the current event, then closes sockets. */
  stop(): Promise<void>;
};

export type ChatIngressOptions = {
  gateway: ChatGateway;
  config: ResolvedControlPlaneConfig;
  repository: SqliteTaskRepository;
  scopes: ChatIngressScopes;
  service: ChatIngressService;
  onError?: (message: string, error?: unknown) => void;
  onStatus?: (message: string) => void;
};

class SqlitePendingCheckpointDirectory implements PendingCheckpointDirectory {
  constructor(private readonly repository: SqliteTaskRepository) {}

  listPending(conversationId: string): readonly PendingCheckpoint[] {
    return this.repository.db
      .prepare(
        `SELECT c.id, c.task_id, c.kind, c.version, t.conversation_id
           FROM checkpoints c JOIN tasks t ON t.id = c.task_id
          WHERE t.conversation_id = ? AND c.status = 'pending'
          ORDER BY c.created_at ASC, c.id ASC`,
      )
      .all(conversationId)
      .map((row) => {
        const checkpoint = row as {
          id: string;
          task_id: string;
          kind: string;
          version: number;
          conversation_id: string;
        };
        return {
          id: checkpoint.id,
          taskId: checkpoint.task_id,
          conversationId: checkpoint.conversation_id,
          kind: checkpoint.kind,
          version: checkpoint.version,
        };
      });
  }
}

function eventDigest(event: InboundChatEvent): string {
  return createHash("sha256")
    .update(event.transport)
    .update("\u0000")
    .update(event.accountRef)
    .update("\u0000")
    .update(event.channelRef)
    .update("\u0000")
    .update(event.messageRef)
    .digest("hex")
    .slice(0, 32);
}

function titleOf(text: string): string {
  const first = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (first ?? text.trim()).slice(0, 160);
}

function rootMessageOf(event: InboundChatEvent): MessageRef {
  const thread = inboundThreadRef(event);
  return {
    transport: event.transport,
    channelRef: event.channelRef,
    messageRef: event.messageRef,
    ...(thread.threadRef === undefined ? {} : { threadRef: thread.threadRef }),
  };
}

function scopeFor(
  scopes: ChatIngressScopes,
  binding: IngressBinding,
): ResolvedScope | undefined {
  const grant = scopes.mintForBinding(binding);
  if (!("scopeToken" in grant)) return undefined;
  return scopes.resolve(grant.scopeToken);
}

function checkpointParams(
  checkpoint: HumanCheckpoint,
  answer: string,
): MethodParams<"checkpoint.answer"> {
  if (!APPROVAL_KINDS.has(checkpoint.kind)) {
    return {
      checkpointId: checkpoint.id,
      decision: "answer",
      answer,
      expectedVersion: checkpoint.version,
    };
  }
  const normalized = answer.trim();
  if (APPROVE.test(normalized)) {
    return {
      checkpointId: checkpoint.id,
      decision: "approve",
      expectedVersion: checkpoint.version,
    };
  }
  if (REJECT.test(normalized)) {
    return {
      checkpointId: checkpoint.id,
      decision: "reject",
      expectedVersion: checkpoint.version,
    };
  }
  return {
    checkpointId: checkpoint.id,
    decision: "reject",
    answer: normalized,
    expectedVersion: checkpoint.version,
  };
}

export function createChatIngress(options: ChatIngressOptions): ChatIngress | undefined {
  const conversations = options.gateway.conversations;
  if (conversations === undefined || options.gateway.platformClients.size === 0) return undefined;

  const ingress = new InMemoryIngressBindingDirectory(options.config.ingressBindings);
  const checkpoints = new SqlitePendingCheckpointDirectory(options.repository);
  const streams: PlatformEventStream[] = [];
  const log =
    options.onError ??
    ((message: string, error?: unknown): void => {
      const detail = error === undefined ? "" : `: ${String(error)}`;
      process.stderr.write(`meidoyad: ${message}${detail}\n`);
    });
  const status =
    options.onStatus ?? ((message: string): void => void process.stdout.write(`meidoyad: ${message}\n`));
  let started = false;
  let stopped = false;
  let tail: Promise<void> = Promise.resolve();

  const processEvent = async (event: InboundChatEvent): Promise<ChatIngressResult> => {
    if (stopped) return { kind: "rejected", reason: "ingress-stopped" };
    const text = event.text.trim();
    if (text.length === 0) return { kind: "rejected", reason: "empty-message" };

    const key = ingressKeyOf(event);
    if (key === undefined) return { kind: "rejected", reason: "unsupported-source" };
    const resolved = resolveIngressBinding(ingress, key);
    if (!resolved.ok) return { kind: "rejected", reason: resolved.reason };
    const scope = scopeFor(options.scopes, resolved.binding);
    if (scope === undefined) return { kind: "rejected", reason: "scope-unavailable" };

    const isReply = event.threadRef !== undefined || event.parentChannelRef !== undefined;
    if (isReply) {
      const answer = resolveInboundReply(
        { ingress, conversations, checkpoints },
        event,
      );
      if (!answer.ok) return { kind: "rejected", reason: answer.reason };
      const checkpoint = options.service.getCheckpoint(scope, answer.checkpointId);
      const result: MethodResult<"checkpoint.answer"> = await options.service.answerCheckpoint(
        scope,
        checkpointParams(checkpoint, answer.answer),
      );
      return {
        kind: "checkpoint-answered",
        checkpointId: result.checkpointId,
        workspaceId: answer.workspaceId,
      };
    }

    const digest = eventDigest(event);
    const conversationId = `conv-chat-${digest}`;
    await conversations.ensure({
      conversationId,
      workspaceId: resolved.workspaceId,
      thread: inboundThreadRef(event),
      rootMessage: rootMessageOf(event),
      ingressBindingId: resolved.binding.id,
    });

    const coordinationTargets =
      scope.role === "head-maid"
        ? Object.entries(options.config.headMaid?.grants ?? {})
            .filter(
              ([, capabilities]) =>
                capabilities.includes("task.delegate") &&
                capabilities.includes("task-summary.read"),
            )
            .map(([workspaceId]) => workspaceId)
            .sort()
        : undefined;
    if (coordinationTargets !== undefined && coordinationTargets.length === 0) {
      return { kind: "rejected", reason: "no-coordination-targets" };
    }
    const created: MethodResult<"task.create"> = await options.service.createTask(scope, {
      title: titleOf(text),
      intent: {
        summary: text,
        projects: [...options.scopes.projectsOf(resolved.workspaceId)],
        origin: "chat",
      },
      conversationId,
      idempotencyKey: `chat-${digest}`,
      ...(coordinationTargets === undefined ? {} : { targetWorkspaceIds: coordinationTargets }),
    });
    return {
      kind: "task-created",
      taskId: created.task.taskId,
      workspaceId: resolved.workspaceId,
    };
  };

  const handle = (event: InboundChatEvent): Promise<ChatIngressResult> => {
    const result = tail.then(() => processEvent(event));
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    async start() {
      if (started || stopped) return;
      started = true;
      for (const [kind, client] of options.gateway.platformClients) {
        if (!options.config.ingressBindings.some((binding) => binding.enabled && binding.source === kind)) {
          continue;
        }
        try {
          const stream = await client.openEventStream(async (event) => {
            try {
              await handle(event);
            } catch (error) {
              log(`${kind} ingress event failed`, error);
              throw error;
            }
          });
          streams.push(stream);
          status(`${kind} ingress started`);
        } catch (error) {
          log(`could not start ${kind} ingress`, error);
        }
      }
    },
    handle,
    async stop() {
      if (stopped) return;
      stopped = true;
      await tail;
      await Promise.allSettled(streams.splice(0).map((stream) => stream.close()));
    },
  };
}
