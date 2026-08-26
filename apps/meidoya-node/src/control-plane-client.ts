import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  CONTROL_PROTOCOL_VERSION,
  FrameDecoder,
  encodeFrame,
  type ControlError,
} from "@meidoya/protocol";
import type { NodeHeartbeat, NodeRegistration } from "@meidoya/node-protocol";
import type {
  ControlPlanePort,
  HeartbeatOutcome,
  RegistrationOutcome,
} from "@meidoya/node-runtime";

export class ControlPlaneCallError extends Error {
  constructor(readonly error: ControlError) {
    super(`${error.message} (${error.kind})`);
    this.name = "ControlPlaneCallError";
  }
}

export type SystemInfo = {
  controlProtocolVersion: number;
  nodeProtocolVersion: number;
  environmentId: string;
};

export type ControlPlaneEndpoint =
  | { readonly kind: "unix"; readonly path: string }
  | { readonly kind: "tcp"; readonly host: string; readonly port: number };

export function parseControlPlaneEndpoint(value: string): ControlPlaneEndpoint {
  if (!value.startsWith("tcp://")) {
    const path = value.replace(/^unix:\/\//, "");
    if (path === "") throw new Error("control plane Unix socket path is empty");
    return { kind: "unix", path };
  }
  const url = new URL(value);
  if (url.protocol !== "tcp:" || url.hostname === "" || url.port === "") {
    throw new Error(`invalid control plane TCP endpoint ${JSON.stringify(value)}`);
  }
  const port = Number(url.port);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`invalid control plane TCP endpoint ${JSON.stringify(value)}`);
  }
  return { kind: "tcp", host: url.hostname, port };
}

/** Socket Control Plane client. The node never opens SQLite (08 section 8). */
export class SocketControlPlaneClient implements ControlPlanePort {
  readonly #socket: net.Socket;
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        const record = frame as Record<string, unknown>;
        const id = record["id"];
        if (typeof id !== "string") continue;
        const pending = this.#pending.get(id);
        if (pending === undefined) continue;
        this.#pending.delete(id);
        if (record["ok"] === true) pending.resolve(record["result"]);
        else pending.reject(new ControlPlaneCallError(record["error"] as ControlError));
      }
    });
    const fail = (error: unknown): void => {
      for (const [id, pending] of [...this.#pending]) {
        this.#pending.delete(id);
        pending.reject(error);
      }
    };
    socket.on("close", () => fail(new Error("control plane connection closed")));
    socket.on("error", fail);
  }

  static connect(target: string | ControlPlaneEndpoint): Promise<SocketControlPlaneClient> {
    return new Promise((resolve, reject) => {
      const endpoint = typeof target === "string" ? parseControlPlaneEndpoint(target) : target;
      const socket =
        endpoint.kind === "unix"
          ? net.createConnection(endpoint.path)
          : net.createConnection({ host: endpoint.host, port: endpoint.port });
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(new SocketControlPlaneClient(socket));
      });
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, id, method, params }));
    });
  }

  systemInfo(): Promise<SystemInfo> {
    return this.request("system.info", {}) as Promise<SystemInfo>;
  }

  async registerNode(registration: NodeRegistration): Promise<RegistrationOutcome> {
    return (await this.request("node.register", registration)) as RegistrationOutcome;
  }

  async heartbeatNode(heartbeat: NodeHeartbeat): Promise<HeartbeatOutcome> {
    return (await this.request("node.heartbeat", heartbeat)) as HeartbeatOutcome;
  }

  close(): void {
    this.#socket.end();
    this.#socket.destroy();
  }
}
