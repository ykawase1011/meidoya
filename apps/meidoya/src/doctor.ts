import { accessSync, constants } from "node:fs";
import net from "node:net";
import path from "node:path";
import { ControlPlaneClient, DEFAULT_SOCKET_PATH } from "./client.js";
import { readSessionCredential } from "./credentials.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export type DoctorCheck = {
  readonly status: DoctorStatus;
  readonly name: string;
  readonly detail: string;
};

export type DoctorReport = {
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: number;
};

export type DoctorOptions = {
  readonly configFile: string;
  readonly nodeConfigFile: string;
  readonly temporalAddress?: string;
  readonly socketPath?: string;
  readonly profile?: string;
  readonly env?: NodeJS.ProcessEnv;
};

type DoctorClient = Pick<ControlPlaneClient, "systemInfo" | "hello" | "scoped" | "close">;

export type DoctorDependencies = {
  readonly fileAccessible?: (file: string, mode: number) => boolean;
  readonly executable?: (name: string, env: NodeJS.ProcessEnv) => string | undefined;
  readonly temporal?: (address: string) => Promise<void>;
  readonly credential?: (
    profile: string | undefined,
    socketPath: string,
    env: NodeJS.ProcessEnv,
  ) => string | undefined;
  readonly connect?: (socketPath: string) => Promise<DoctorClient>;
  readonly nodeVersion?: string;
};

function accessible(file: string, mode: number): boolean {
  try {
    accessSync(file, mode);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (name.includes(path.sep)) return accessible(name, constants.X_OK) ? name : undefined;
  for (const directory of (env["PATH"] ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, name);
    if (accessible(candidate, constants.X_OK)) return candidate;
  }
  return undefined;
}

export function parseTemporalAddress(address: string): { host: string; port: number } {
  const value = address.trim();
  const ipv6 = /^\[([^\]]+)]:(\d+)$/.exec(value);
  const simple = /^([^:]+):(\d+)$/.exec(value);
  const host = ipv6?.[1] ?? simple?.[1];
  const rawPort = ipv6?.[2] ?? simple?.[2];
  const port = Number(rawPort);
  if (host === undefined || rawPort === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid Temporal address ${JSON.stringify(address)}; expected host:port`);
  }
  return { host, port };
}

function probeTemporal(address: string): Promise<void> {
  const { host, port } = parseTemporalAddress(address);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const finish = (error?: Error): void => {
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.setTimeout(2_000, () => finish(new Error("connection timed out")));
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

function check(status: DoctorStatus, name: string, detail: string): DoctorCheck {
  return { status, name, detail };
}

export async function runDoctor(
  options: DoctorOptions,
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const socketPath = options.socketPath ?? env["MEIDOYA_SOCKET"] ?? DEFAULT_SOCKET_PATH;
  const profile = options.profile ?? env["MEIDOYA_PROFILE"];
  const temporalAddress =
    options.temporalAddress ?? env["MEIDOYA_TEMPORAL_ADDRESS"] ?? "127.0.0.1:7233";
  const canAccess = dependencies.fileAccessible ?? accessible;
  const locate = dependencies.executable ?? findExecutable;
  const checks: DoctorCheck[] = [];

  const major = Number((dependencies.nodeVersion ?? process.versions.node).split(".")[0]);
  checks.push(
    Number.isInteger(major) && major >= 20
      ? check("ok", "node", `Node.js ${dependencies.nodeVersion ?? process.versions.node}`)
      : check("fail", "node", `Node.js >=20 required; found ${dependencies.nodeVersion ?? process.versions.node}`),
  );

  checks.push(
    canAccess(options.configFile, constants.R_OK)
      ? check("ok", "control config", options.configFile)
      : check("fail", "control config", `not readable: ${options.configFile}`),
  );
  checks.push(
    canAccess(options.nodeConfigFile, constants.R_OK)
      ? check("ok", "node config", options.nodeConfigFile)
      : check(
          "warn",
          "node config",
          `not present on this CLI host (remote execution is supported): ${options.nodeConfigFile}`,
        ),
  );

  const runtimes = [
    ["codex", env["MEIDOYA_CODEX_BIN"] ?? "codex"],
    ["claude", env["MEIDOYA_CLAUDE_BIN"] ?? "claude"],
  ] as const;
  let runtimeCount = 0;
  for (const [name, binary] of runtimes) {
    const found = locate(binary, env);
    if (found === undefined) checks.push(check("warn", `${name} runtime`, `${binary} not executable`));
    else {
      runtimeCount += 1;
      checks.push(check("ok", `${name} runtime`, found));
    }
  }
  if (runtimeCount === 0) checks.push(check("fail", "agent runtime", "install Codex or Claude Code"));

  try {
    await (dependencies.temporal ?? probeTemporal)(temporalAddress);
    checks.push(check("ok", "temporal", temporalAddress));
  } catch (error) {
    checks.push(check("fail", "temporal", `${temporalAddress}: ${(error as Error).message}`));
  }

  const credentialReader = dependencies.credential ?? readSessionCredential;
  if (profile === undefined || profile.trim() === "") {
    checks.push(check("fail", "CLI profile", "set MEIDOYA_PROFILE or pass --profile"));
  } else {
    checks.push(check("ok", "CLI profile", profile));
  }

  let credential: string | undefined;
  try {
    credential = credentialReader(profile, socketPath, env);
    checks.push(
      credential === undefined
        ? check("fail", "session credential", "not provisioned; start meidoyad first")
        : check("ok", "session credential", "private credential found"),
    );
  } catch (error) {
    checks.push(check("fail", "session credential", (error as Error).message));
  }

  let client: DoctorClient | undefined;
  try {
    client = await (dependencies.connect ?? ControlPlaneClient.connect)(socketPath);
    const info = await client.systemInfo();
    checks.push(
      check(
        "ok",
        "control plane",
        `${socketPath} (control v${String(info.controlProtocolVersion)}, node v${String(info.nodeProtocolVersion)})`,
      ),
    );
    if (profile !== undefined && credential !== undefined) {
      const session = await client.hello(profile, credential);
      checks.push(check("ok", "session", `${session.workspaceId} as ${session.role}`));
      const status = (await client.scoped("workspace.status.read", {})) as {
        nodes: { nodeId: string; status: string }[];
      };
      const online = status.nodes.filter((node) => node.status === "online");
      checks.push(
        online.length > 0
          ? check("ok", "execution node", online.map((node) => node.nodeId).join(", "))
          : check("fail", "execution node", "no online node serves this workspace"),
      );
    }
  } catch (error) {
    checks.push(check("fail", "control plane", `${socketPath}: ${(error as Error).message}`));
  } finally {
    client?.close();
  }

  return { checks, exitCode: checks.some((item) => item.status === "fail") ? 1 : 0 };
}

export function formatDoctorReport(report: DoctorReport): string {
  return report.checks
    .map((item) => `[${item.status.padEnd(4)}] ${item.name}: ${item.detail}`)
    .join("\n");
}
