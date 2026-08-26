import os from "node:os";

export type ScrubOptions = {
  home?: string;
  /** Absolute prefixes replaced by a stable label, e.g. { "/x/repos": "<repos>" }. */
  pathLabels?: Record<string, string>;
  extraSecretPatterns?: RegExp[];
};

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
];

export const REDACTED = "[redacted]";

/**
 * Private-by-default projection: STATUS.md is a human artifact that may be
 * pasted around, so secrets and absolute host paths never reach it.
 */
export function scrub(input: string, options: ScrubOptions = {}): string {
  let output = input;

  for (const pattern of [
    ...SECRET_PATTERNS,
    ...(options.extraSecretPatterns ?? []),
  ]) {
    output = output.replace(new RegExp(pattern.source, pattern.flags), (match) =>
      /^(?:api[_-]?key|secret|token|password|passwd)/i.test(match)
        ? `${match.split(/[:=]/)[0]?.trimEnd() ?? "secret"}: ${REDACTED}`
        : REDACTED,
    );
  }

  const labels = Object.entries(options.pathLabels ?? {}).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [prefix, label] of labels) {
    output = output.split(prefix).join(label);
  }

  const home = options.home ?? os.homedir();
  if (home.length > 1) {
    output = output.split(home).join("~");
  }

  // Anything still absolute is a host path: keep only the trailing segments.
  output = output.replace(
    /(?<=^|[\s(\[`"',])\/(?:[A-Za-z0-9._-]+\/){1,}[A-Za-z0-9._-]+/gm,
    (match) => {
      const parts = match.split("/").filter((p) => p.length > 0);
      return parts.length <= 2 ? `.../${parts.join("/")}` : `.../${parts.slice(-2).join("/")}`;
    },
  );

  return output;
}

export function scrubPath(input: string, options: ScrubOptions = {}): string {
  return scrub(input, options);
}
