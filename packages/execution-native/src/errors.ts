export type SandboxDenialReason =
  | "outside-allowed-roots"
  | "sensitive-path"
  | "symlink-not-allowed"
  | "unresolvable-path"
  | "not-found"
  | "home-fallback-denied"
  | "invalid-root";

export class SandboxViolationError extends Error {
  readonly reason: SandboxDenialReason;
  readonly requested: string;
  readonly resolved: string | undefined;

  constructor(
    reason: SandboxDenialReason,
    requested: string,
    message: string,
    resolved?: string,
  ) {
    super(`${message} (requested: ${requested})`);
    this.name = "SandboxViolationError";
    this.reason = reason;
    this.requested = requested;
    this.resolved = resolved;
  }
}
