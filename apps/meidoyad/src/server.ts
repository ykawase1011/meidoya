import net from "node:net";
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlPlaneError,
  FrameDecoder,
  MAX_FRAME_BYTES,
  controlError,
  dispatchRequest,
  encodeFrame,
  errorResponse,
  okResponse,
  type ControlResponse,
  type MethodHandlers,
} from "@meidoya/protocol";
import type { ControlEvent, ControlEventBus } from "./events.js";
import type { ControlPlaneService } from "./api.js";
import type { ScopeRegistry } from "./scope.js";
import { authorizeMethod } from "./scope.js";

/**
 * Methods the daemon serves in addition to the core registry in
 * @meidoya/protocol: a version handshake, ingress-bound session establishment
 * and the event subscription the CLI uses instead of holding an agent process.
 */
export const LOCAL_METHODS = {
  SYSTEM_INFO: "system.info",
  SESSION_HELLO: "session.hello",
  SESSION_REVOKE: "session.revoke",
  EVENT_SUBSCRIBE: "event.subscribe",
  SCHEDULE_TRIGGER: "schedule.trigger",
  CHECKPOINT_GET: "checkpoint.get",
} as const;

const CheckpointGetSchema = z.object({ checkpointId: z.string().min(1) }).strict();

/**
 * The routing tuple is a *claim*: it selects which binding the caller says it
 * is, and `credential` is what proves it. A caller that omits the credential,
 * or presents one belonging to another binding, is refused with the same error
 * as a caller naming a binding that does not exist.
 */
const SessionHelloSchema = z
  .object({
    source: z.enum(["slack", "discord", "cli", "http"]).default("cli"),
    account: z.string().nullable().default(null),
    channel: z.string().nullable().default(null),
    profile: z.string().nullable().default(null),
    credential: z.string().nullable().default(null),
  })
  .strict();

/**
 * Revocation is authenticated by the binding's own credential, exactly like
 * `session.hello`, and never by a scope token: an operator who suspects a token
 * was stolen must still be able to revoke it, and the thief must not be.
 */
const SessionRevokeSchema = SessionHelloSchema.extend({
  /** "session" cuts this binding's tokens; "workspace" cuts every binding's. */
  scope: z.enum(["session", "workspace"]).default("session"),
  /** Also stop the binding accepting new sessions until the daemon restarts. */
  disable: z.boolean().default(false),
}).strict();

/** Deliberately uniform: it must not reveal which workspaces exist. */
const HELLO_REFUSED = "no ingress binding for this client";

const ScheduleTriggerSchema = z.object({ scheduleId: z.string().min(1) }).strict();

type Session = {
  socket: net.Socket;
  subscribedWorkspaceId?: string;
  unsubscribe?: () => void;
};

type ControlPlaneListen =
  | { readonly kind: "unix"; readonly path: string }
  | {
      readonly kind: "tcp";
      readonly host: string;
      readonly port: number;
      readonly allowedPeers: readonly string[];
    };

export type ControlPlaneServerOptions = {
  /** Backward-compatible Unix listener spelling used by local callers/tests. */
  socketPath?: string;
  listen?: ControlPlaneListen;
  service: ControlPlaneService;
  scopes: ScopeRegistry;
  handlers: MethodHandlers;
  events: ControlEventBus;
};

export class ControlPlaneServer {
  readonly #server: net.Server;
  readonly #sessions = new Set<Session>();
  readonly #options: ControlPlaneServerOptions;
  readonly #listen: ControlPlaneListen;
  #accepting = true;

  constructor(options: ControlPlaneServerOptions) {
    this.#options = options;
    this.#listen =
      options.listen ??
      (options.socketPath === undefined
        ? (() => {
            throw new Error("ControlPlaneServer requires socketPath or listen");
          })()
        : { kind: "unix", path: options.socketPath });
    this.#server = net.createServer((socket) => this.#onConnection(socket));
  }

  async start(): Promise<void> {
    if (this.#listen.kind === "unix") {
      mkdirSync(path.dirname(this.#listen.path), { recursive: true });
      try {
        statSync(this.#listen.path);
        rmSync(this.#listen.path);
      } catch {
        // No stale socket to remove.
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      const ready = (): void => {
        this.#server.off("error", reject);
        resolve();
      };
      if (this.#listen.kind === "unix") this.#server.listen(this.#listen.path, ready);
      else this.#server.listen(this.#listen.port, this.#listen.host, ready);
    });
    // Outer fence only: 0600 keeps other users out, but every agent process
    // runs as this same user, so the session credential in `session.hello` is
    // what actually authenticates a client to a workspace.
    if (this.#listen.kind === "unix") chmodSync(this.#listen.path, 0o600);
  }

  /** Stops accepting, then closes live connections once their writes flush. */
  async close(): Promise<void> {
    this.#accepting = false;
    // Calling `server.close()` first stops acceptance, but its callback waits
    // for every existing connection. Destroy those sessions BEFORE awaiting
    // the callback; doing it afterwards deadlocks shutdown whenever a CLI or
    // execution node keeps its control socket open.
    const closed = new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    for (const session of [...this.#sessions]) {
      session.unsubscribe?.();
      session.socket.end();
      session.socket.destroy();
      this.#sessions.delete(session);
    }
    await closed;
    if (this.#listen.kind === "unix") {
      try {
        rmSync(this.#listen.path);
      } catch {
        // Already gone.
      }
    }
  }

  #onConnection(socket: net.Socket): void {
    if (!this.#accepting) {
      socket.destroy();
      return;
    }
    if (
      this.#listen.kind === "tcp" &&
      !this.#listen.allowedPeers.includes(normalizePeer(socket.remoteAddress))
    ) {
      socket.destroy();
      return;
    }
    const session: Session = { socket };
    this.#sessions.add(session);
    const decoder = new FrameDecoder();

    socket.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        this.#write(socket, {
          v: CONTROL_PROTOCOL_VERSION,
          id: "unknown",
          ok: false,
          error: controlError("invalid_request", (error as Error).message),
        });
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        void this.#handle(session, frame);
      }
    });

    const cleanup = (): void => {
      session.unsubscribe?.();
      this.#sessions.delete(session);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  async #handle(session: Session, frame: unknown): Promise<void> {
    const request = frame as { id?: unknown; method?: unknown; params?: unknown; scopeToken?: unknown };
    const id = typeof request.id === "string" ? request.id : "unknown";
    const method = typeof request.method === "string" ? request.method : "";

    if (isLocalMethod(method)) {
      try {
        this.#write(session.socket, okResponse(id, await this.#local(session, method, request)));
      } catch (error) {
        this.#write(
          session.socket,
          error instanceof ControlPlaneError
            ? errorResponse(id, error.toWire())
            : errorResponse(
                id,
                controlError("internal_error", error instanceof Error ? error.message : "failed"),
              ),
        );
      }
      return;
    }

    // Everything from here on is inside the same guard as the local methods.
    // `#write` used to sit outside it, and `encodeFrame` throws above
    // MAX_FRAME_BYTES: an oversized RESULT (a `task.list` over rows whose own
    // free text is large enough) rejected the un-awaited `#handle` above, and an
    // unhandled rejection terminates Node. One workspace, using only its own
    // durable rows, could take the control plane down for every workspace —
    // repeatably, because the rows survive the restart.
    try {
      const response = await dispatchRequest(frame, {
        resolveScope: async (token) => this.#options.scopes.resolve(token),
        handlers: this.#options.handlers,
        authorize: authorizeMethod,
      });
      this.#write(session.socket, response);
    } catch (error) {
      this.#write(
        session.socket,
        error instanceof ControlPlaneError
          ? errorResponse(id, error.toWire())
          : errorResponse(
              id,
              controlError("internal_error", error instanceof Error ? error.message : "failed"),
            ),
      );
    }
  }

  async #local(
    session: Session,
    method: string,
    request: { params?: unknown; scopeToken?: unknown },
  ): Promise<unknown> {
    switch (method) {
      case LOCAL_METHODS.SYSTEM_INFO:
        return this.#options.service.systemInfo();

      case LOCAL_METHODS.SESSION_HELLO: {
        const params = SessionHelloSchema.parse(request.params ?? {});
        const grant = this.#options.scopes.mint(
          {
            source: params.source,
            accountRef: params.account,
            channelRef: params.channel,
            profileRef: params.profile,
          },
          params.credential ?? undefined,
        );
        if ("reason" in grant) {
          throw new ControlPlaneError("unauthorized_scope", HELLO_REFUSED);
        }
        return {
          scopeToken: grant.scopeToken,
          workspaceId: grant.workspaceId,
          projects: grant.projects,
          role: grant.role,
          expiresAt: grant.expiresAt,
        };
      }

      case LOCAL_METHODS.SESSION_REVOKE: {
        const params = SessionRevokeSchema.parse(request.params ?? {});
        const result = this.#options.scopes.revoke(
          {
            source: params.source,
            accountRef: params.account,
            channelRef: params.channel,
            profileRef: params.profile,
          },
          params.credential ?? undefined,
          { scope: params.scope, disable: params.disable },
        );
        if ("reason" in result) {
          throw new ControlPlaneError("unauthorized_scope", HELLO_REFUSED);
        }
        return result;
      }

      case LOCAL_METHODS.EVENT_SUBSCRIBE: {
        const scope = this.#requireScope(request.scopeToken);
        // Proved to be a string by #requireScope, and kept so the listener can
        // re-resolve it rather than trust a scope captured once.
        const token = request.scopeToken as string;
        if (!authorizeMethod(scope, "workspace.status.read")) {
          throw new ControlPlaneError(
            "capability_denied",
            `role ${scope.role} lacks workspace.status.read`,
          );
        }
        session.unsubscribe?.();
        session.subscribedWorkspaceId = scope.workspaceId;
        // The stream is a long-lived read of a workspace, so its authority has
        // to be re-checked on every event and never captured once. Capturing
        // the resolved scope in this closure meant a socket kept receiving
        // every ControlEvent of the workspace — `payload` included, which
        // carries unscrubbed model text — after `session.revoke`, after the
        // binding was disabled, after the workspace was suspended and after the
        // token's signed lifetime ran out. Revocation is the documented answer
        // to a stolen token; it has to reach the stream the thief is holding.
        session.unsubscribe = this.#options.events.subscribe((event: ControlEvent) => {
          const current = this.#options.scopes.resolve(token);
          if (current === undefined || !authorizeMethod(current, "workspace.status.read")) {
            const stop = session.unsubscribe;
            delete session.unsubscribe;
            delete session.subscribedWorkspaceId;
            stop?.();
            return;
          }
          if (event.workspaceId !== current.workspaceId) return;
          this.#writeFrame(session.socket, {
            v: CONTROL_PROTOCOL_VERSION,
            event: "task.event",
            payload: event,
          });
        });
        return { subscribed: true, workspaceId: scope.workspaceId };
      }

      case LOCAL_METHODS.SCHEDULE_TRIGGER: {
        const scope = this.#requireScope(request.scopeToken);
        if (!authorizeMethod(scope, "schedule.manage")) {
          throw new ControlPlaneError("capability_denied", `role ${scope.role} lacks schedule.manage`);
        }
        const params = ScheduleTriggerSchema.parse(request.params ?? {});
        return this.#options.service.triggerSchedule(scope, params.scheduleId);
      }

      case LOCAL_METHODS.CHECKPOINT_GET: {
        const scope = this.#requireScope(request.scopeToken);
        if (!authorizeMethod(scope, "workspace.status.read")) {
          throw new ControlPlaneError(
            "capability_denied",
            `role ${scope.role} lacks workspace.status.read`,
          );
        }
        const params = CheckpointGetSchema.parse(request.params ?? {});
        return this.#options.service.getCheckpoint(scope, params.checkpointId);
      }

      default:
        throw new ControlPlaneError("method_not_found", `unknown method: ${method}`);
    }
  }

  #requireScope(token: unknown) {
    if (typeof token !== "string") {
      throw new ControlPlaneError("unauthorized_scope", "a scope token is required");
    }
    const scope = this.#options.scopes.resolve(token);
    if (scope === undefined) {
      throw new ControlPlaneError("unauthorized_scope", "invalid scope token");
    }
    return scope;
  }

  /**
   * A response the client is owed. If it cannot be encoded — it is over the
   * frame limit — the client is told so instead of being left hanging, and the
   * daemon stays up either way.
   */
  #write(socket: net.Socket, response: ControlResponse): void {
    if (this.#writeFrame(socket, response)) return;
    this.#writeFrame(
      socket,
      errorResponse(
        response.id,
        controlError(
          "internal_error",
          `response exceeds the ${MAX_FRAME_BYTES}-byte control frame limit`,
        ),
      ),
    );
  }

  /** False when the frame could not be encoded or the socket is already gone. */
  #writeFrame(socket: net.Socket, frame: Parameters<typeof encodeFrame>[0]): boolean {
    if (socket.destroyed) return false;
    let encoded: string;
    try {
      encoded = encodeFrame(frame);
    } catch {
      return false;
    }
    socket.write(encoded);
    return true;
  }
}

function normalizePeer(address: string | undefined): string {
  if (address === undefined) return "";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function isLocalMethod(method: string): boolean {
  return (Object.values(LOCAL_METHODS) as string[]).includes(method);
}
