import { readFileSync } from "node:fs";
import {
  NODE_PROTOCOL_VERSION,
  NodeRegistrationSchema,
  type NodeArchitecture,
  type NodeHeartbeat,
  type NodePlatform,
  type NodeProfile,
  type NodeRegistration,
  type NodeStatus,
} from "@meidoya/node-protocol";
import { systemClock, type Clock, type ControlPlanePort } from "./ports.js";

export type NodeSelfDescription = {
  nodeId: string;
  nodeVersion: string;
  platform: NodePlatform;
  arch: NodeArchitecture;
  profile: NodeProfile;
  capabilities: string[];
  workspaceBindings: string[];
  maxConcurrency: number;
};

/**
 * A node's registration token, and where a node process is allowed to get one.
 *
 * The control plane provisions one 0600 file per configured node and refuses
 * `node.register` / `node.heartbeat` without it: `nodeId` is otherwise a bare
 * selector, and a registration rewrites that node's workspace bindings while a
 * heartbeat flips its status for every workspace bound to it.
 *
 * Deliberately NOT part of `NodeSelfDescription`, and deliberately not read
 * from the node's config file: the self-description is exactly the claim the
 * token authenticates, so a claim must not be able to supply its own proof.
 * The token comes from the process's environment instead, put there by whoever
 * launched the node — `MEIDOYA_NODE_TOKEN` for the value, or
 * `MEIDOYA_NODE_TOKEN_FILE` for a path read fresh on every call, so rotating
 * the file takes effect without restarting the node.
 */
export function nodeCredentialFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const inline = env["MEIDOYA_NODE_TOKEN"];
  if (typeof inline === "string" && inline.trim() !== "") return inline.trim();
  const file = env["MEIDOYA_NODE_TOKEN_FILE"];
  if (typeof file !== "string" || file === "") return undefined;
  try {
    const text = readFileSync(file, "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    // Unreadable or absent: the call is refused by the control plane, which is
    // the same outcome as presenting nothing and a far better one than guessing.
    return undefined;
  }
}

/** A claim plus the proof that the caller is the node making it. */
export type CredentialedNodeRegistration = NodeRegistration & { credential?: string };
export type CredentialedNodeHeartbeat = NodeHeartbeat & { credential?: string };

export function buildRegistration(
  self: NodeSelfDescription,
  credential?: string,
): CredentialedNodeRegistration {
  const registration = NodeRegistrationSchema.parse({
    nodeId: self.nodeId,
    nodeVersion: self.nodeVersion,
    protocolVersion: NODE_PROTOCOL_VERSION,
    platform: self.platform,
    arch: self.arch,
    profile: self.profile,
    capabilities: [...new Set(self.capabilities)].sort(),
    workspaceBindings: [...new Set(self.workspaceBindings)].sort(),
    maxConcurrency: self.maxConcurrency,
  });
  // Attached after the parse, never through it: the registration schema
  // describes what the node CLAIMS, and the credential is the proof carried
  // alongside that claim rather than a part of it.
  return credential === undefined ? registration : { ...registration, credential };
}

export type NodeAgentOptions = {
  self: NodeSelfDescription;
  controlPlane: ControlPlanePort;
  activeRunCount: () => number;
  clock?: Clock;
  /**
   * Registration token presented on every node call. Defaults to the process
   * environment (see `nodeCredentialFromEnv`); read per call, so a rotated
   * token is picked up without a restart.
   */
  credential?: () => string | undefined;
  defaultHeartbeatIntervalMs?: number;
  onDirective?: (directive: "drain" | "shutdown") => void;
  /** Called only after the Control Plane accepted a registration or heartbeat. */
  onControlPlaneAcknowledged?: (at: number) => void;
};

/**
 * Node side of registration + heartbeat. The node advertises what it believes
 * it can do; whatever the Control Plane grants back is authoritative.
 */
export class NodeAgent {
  private status: NodeStatus = "offline";
  private timer: ReturnType<typeof setInterval> | undefined;
  private granted:
    | { capabilities: string[]; workspaces: string[]; maxConcurrency: number }
    | undefined;
  private heartbeatIntervalMs: number;
  private readonly clock: Clock;

  constructor(private readonly options: NodeAgentOptions) {
    this.clock = options.clock ?? systemClock;
    this.heartbeatIntervalMs = options.defaultHeartbeatIntervalMs ?? 15_000;
  }

  get nodeStatus(): NodeStatus {
    return this.status;
  }

  get grantedCapabilities(): readonly string[] {
    return this.granted?.capabilities ?? [];
  }

  get grantedWorkspaces(): readonly string[] {
    return this.granted?.workspaces ?? [];
  }

  get effectiveMaxConcurrency(): number {
    return this.granted?.maxConcurrency ?? 0;
  }

  async register(): Promise<boolean> {
    const outcome = await this.options.controlPlane.registerNode(
      buildRegistration(this.options.self, this.#credential()),
    );
    if (!outcome.accepted) {
      this.status = "offline";
      this.granted = undefined;
      return false;
    }
    this.granted = {
      capabilities: outcome.grantedCapabilities,
      workspaces: outcome.grantedWorkspaces,
      maxConcurrency: outcome.maxConcurrency,
    };
    this.heartbeatIntervalMs = outcome.heartbeatIntervalMs;
    this.status = "online";
    this.options.onControlPlaneAcknowledged?.(this.clock.now());
    return true;
  }

  #credential(): string | undefined {
    return (this.options.credential ?? (() => nodeCredentialFromEnv()))();
  }

  buildHeartbeat(): CredentialedNodeHeartbeat {
    const credential = this.#credential();
    return {
      nodeId: this.options.self.nodeId,
      status: this.status,
      activeRunCount: this.options.activeRunCount(),
      timestamp: this.clock.now(),
      // A heartbeat writes: it flips this node's status for every workspace
      // bound to it, so it is authenticated exactly like a registration.
      ...(credential === undefined ? {} : { credential }),
    };
  }

  async heartbeatOnce(): Promise<void> {
    const outcome = await this.options.controlPlane.heartbeatNode(
      this.buildHeartbeat(),
    );
    if (!outcome.acknowledged || outcome.directive === "re-register") {
      await this.register();
      return;
    }
    this.options.onControlPlaneAcknowledged?.(this.clock.now());
    if (outcome.directive === "drain") {
      this.status = "draining";
      this.options.onDirective?.("drain");
    } else if (outcome.directive === "shutdown") {
      this.status = "offline";
      this.stop();
      this.options.onDirective?.("shutdown");
    }
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.heartbeatOnce().catch(() => {
        // Heartbeat failures do not kill the node; the Control Plane will mark
        // it offline on timeout and Temporal will retry the affected runs.
      });
    }, this.heartbeatIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
