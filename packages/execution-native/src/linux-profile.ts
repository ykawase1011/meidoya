import path from "node:path";
import type { ResolvedNodeConfig } from "./config.js";
import { expandTilde } from "./paths.js";

export type LinuxIsolation =
  | { kind: "dedicated-user"; user: string }
  | { kind: "rootless-container"; image?: string };

export type LinuxHardeningPlan = {
  isolation: LinuxIsolation;
  readOnlyRootFilesystem: boolean;
  allowedRoots: string[];
  /** Only these are writable; everything else is mounted read-only. */
  writablePaths: string[];
  network: { policy: "none" | "restricted" | "open"; allowedDomains: string[] };
  warnings: string[];
};

/**
 * linux-restricted profile (10-execution-nodes-and-security.md section 4).
 * Produces the hardening plan the node supervisor applies, plus warnings for
 * every recommendation that is not met.
 */
export function planLinuxHardening(
  resolved: ResolvedNodeConfig,
  tmpDir = "/tmp",
): LinuxHardeningPlan {
  const linux = resolved.config.linux;
  const warnings: string[] = [];

  let isolation: LinuxIsolation;
  if (linux?.rootless_container === true) {
    isolation = { kind: "rootless-container" };
  } else if (linux?.os_user !== undefined && linux.os_user.length > 0) {
    if (linux.os_user === "root") {
      warnings.push("linux.os_user must not be root");
    }
    isolation = { kind: "dedicated-user", user: linux.os_user };
  } else {
    warnings.push(
      "no dedicated OS user or rootless container configured; running as the invoking user is not isolation",
    );
    isolation = { kind: "dedicated-user", user: "meidoya-node" };
  }

  const readOnlyRootFilesystem = linux?.read_only_root_filesystem ?? true;
  if (!readOnlyRootFilesystem) {
    warnings.push("read-only root filesystem is recommended");
  }

  const configured = (linux?.writable_paths ?? []).map((p) =>
    expandTilde(p, resolved.home),
  );
  const writablePaths = dedupe([
    ...resolved.allowedRoots,
    ...configured,
    tmpDir,
  ]).filter((p) => {
    if (p === path.parse(p).root) {
      warnings.push(`refusing writable path ${p}`);
      return false;
    }
    return true;
  });

  const network = {
    policy: resolved.config.network.policy,
    allowedDomains: [...resolved.config.network.allowed_domains].sort(),
  };
  if (network.policy === "open") {
    warnings.push("network policy 'open' bypasses the domain allowlist");
  }
  if (network.policy === "restricted" && network.allowedDomains.length === 0) {
    warnings.push("network policy is 'restricted' but the allowlist is empty");
  }

  return {
    isolation,
    readOnlyRootFilesystem,
    allowedRoots: [...resolved.allowedRoots].sort(),
    writablePaths,
    network,
    warnings,
  };
}

export function isDomainAllowed(
  plan: LinuxHardeningPlan,
  host: string,
): boolean {
  if (plan.network.policy === "none") return false;
  if (plan.network.policy === "open") return true;
  const lower = host.toLowerCase();
  return plan.network.allowedDomains.some(
    (domain) =>
      lower === domain.toLowerCase() || lower.endsWith(`.${domain.toLowerCase()}`),
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
