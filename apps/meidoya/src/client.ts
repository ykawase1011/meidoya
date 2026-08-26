import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CONTROL_PROTOCOL_VERSION,
  FrameDecoder,
  encodeFrame,
  type ControlError,
} from "@meidoya/protocol";
import { readSessionCredential } from "./credentials.js";

export const DEFAULT_SOCKET_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "meidoya",
  "meidoya.sock",
);

export class ControlPlaneClientError extends Error {
  constructor(
    readonly error: ControlError,
    method: string,
  ) {
    super(`${method}: ${error.message} (${error.kind})`);
    this.name = "ControlPlaneClientError";
  }
}

export type ControlNotificationHandler = (event: string, payload: unknown) => void;

/**
 * NDJSON client for the Control Plane unix socket. The CLI never runs an agent;
 * it issues requests and subscribes to Control Plane events (07 section 7).
 */
export class ControlPlaneClient {
  readonly #socket: net.Socket;
  readonly #socketPath: string;
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void; method: string }
  >();
  readonly #handlers = new Set<ControlNotificationHandler>();
  #scopeToken: string | undefined;
  #closed = false;

  private constructor(socket: net.Socket, socketPath: string) {
    this.#socket = socket;
    this.#socketPath = socketPath;
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        this.#failAll(error);
        return;
      }
      for (const frame of frames) this.#onFrame(frame);
    });
    socket.on("close", () => {
      this.#closed = true;
      this.#failAll(new Error("control plane connection closed"));
    });
    socket.on("error", (error) => this.#failAll(error));
  }

  static connect(socketPath: string = DEFAULT_SOCKET_PATH): Promise<ControlPlaneClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(new ControlPlaneClient(socket, socketPath));
      });
    });
  }

  get scopeToken(): string | undefined {
    return this.#scopeToken;
  }

  onNotification(handler: ControlNotificationHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /**
   * Establishes the session's workspace. The workspace comes from the daemon's
   * ingress binding for this profile; the CLI cannot name one. The profile is
   * only a claim, so the session credential provisioned for that profile is
   * presented alongside it and the daemon refuses the handshake without it.
   */
  async hello(
    profile: string | undefined,
    credential: string | undefined = readSessionCredential(profile, this.#socketPath),
  ): Promise<{
    scopeToken: string;
    workspaceId: string;
    projects: string[];
    role: string;
    expiresAt?: number;
  }> {
    const result = (await this.request("session.hello", {
      source: "cli",
      profile: profile ?? null,
      credential: credential ?? null,
    })) as {
      scopeToken: string;
      workspaceId: string;
      projects: string[];
      role: string;
      expiresAt?: number;
    };
    this.#scopeToken = result.scopeToken;
    return result;
  }

  systemInfo(): Promise<{
    controlProtocolVersion: number;
    nodeProtocolVersion: number;
    environmentId: string;
  }> {
    return this.request("system.info", {}) as Promise<{
      controlProtocolVersion: number;
      nodeProtocolVersion: number;
      environmentId: string;
    }>;
  }

  async subscribe(): Promise<void> {
    await this.request("event.subscribe", {}, true);
  }

  request(method: string, params: unknown, scoped = false): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("control plane connection closed"));
    const id = randomUUID();
    const frame = {
      v: CONTROL_PROTOCOL_VERSION,
      id,
      method,
      params,
      ...(scoped && this.#scopeToken !== undefined ? { scopeToken: this.#scopeToken } : {}),
    };
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#socket.write(encodeFrame(frame));
    });
  }

  /** Every workspace-scoped call carries the session token, never a workspace id. */
  scoped(method: string, params: unknown): Promise<unknown> {
    if (this.#scopeToken === undefined) {
      return Promise.reject(new Error("session.hello has not been completed"));
    }
    return this.request(method, params, true);
  }

  close(): void {
    this.#closed = true;
    this.#socket.end();
    this.#socket.destroy();
  }

  #onFrame(frame: unknown): void {
    const record = frame as Record<string, unknown>;
    if (typeof record["event"] === "string") {
      for (const handler of [...this.#handlers]) {
        handler(record["event"], record["payload"]);
      }
      return;
    }
    const id = record["id"];
    if (typeof id !== "string") return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if (record["ok"] === true) pending.resolve(record["result"]);
    else pending.reject(new ControlPlaneClientError(record["error"] as ControlError, pending.method));
  }

  #failAll(error: unknown): void {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}
