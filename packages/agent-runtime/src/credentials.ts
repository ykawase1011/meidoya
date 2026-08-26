import { CREDENTIAL_ENV_KEYS } from "./redaction.js";

/**
 * The credential boundary shared by every vendor runtime adapter (09 section 3
 * / 10 section 9): the vendor credential lives on the Execution Node only, the
 * Control Plane may never ship one in, and no credential value may reach an
 * event, a log line or the DB.
 *
 * This used to live in `@meidoya/runtime-claude`, which meant the Claude
 * adapter had a `nodeLocalEnv` and the Codex adapter had nothing — and the
 * Codex adapter's silence is exactly how it ended up spawning `codex` with
 * `spawnBounded`'s minimal default environment (no `OPENAI_API_KEY`, no proxy,
 * no CA bundle) once that default stopped meaning "inherit". A single home for
 * the helper is what makes "every adapter builds its child env explicitly" a
 * thing a reviewer can check in one place.
 */
export class CredentialBoundaryError extends Error {
  constructor(public readonly keys: readonly string[]) {
    super(
      "Vendor credentials, and variables that redirect or inject code into the process holding" +
        ` them, are node-local and must not be passed from the Control Plane: ${keys.join(", ")}`,
    );
    this.name = "CredentialBoundaryError";
  }
}

/**
 * Variables that do not CARRY a credential but REDIRECT the process that holds
 * one — the other half of the same boundary, and the half this guard used to
 * miss entirely.
 *
 * Proven by real spawn against the previous version: an overlay of
 * `NODE_OPTIONS=--require /tmp/evil.js`, `HTTPS_PROXY=http://attacker` and
 * `ANTHROPIC_BASE_URL=https://attacker` passed `assertNoInjectedCredentials`
 * and landed in the vendor CLI's environment ALONGSIDE the live
 * `ANTHROPIC_API_KEY`. None of them is a credential; each is strictly worse
 * than shipping one in:
 *  - `NODE_OPTIONS` / `*_OPTIONS` is arbitrary code inside the process that
 *    holds the credential, before its first line runs.
 *  - `*_PROXY` sends every request — Authorization header included — to a host
 *    the overlay names.
 *  - `*_BASE_URL` / `*_API_BASE` / `*_ENDPOINT` point the vendor SDK itself at
 *    an attacker, which is round 5's defect restated as an env var.
 *  - `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` / `REQUESTS_CA_BUNDLE` make the
 *    interception above invisible to TLS.
 *  - `LD_PRELOAD` / `DYLD_*` inject code into any child, credential included.
 * Matched by SUFFIX/PREFIX rather than by exact name on purpose: the vendor
 * prefix (`ANTHROPIC_`, `OPENAI_`, `CODEX_`, whatever the next adapter uses) is
 * the part that varies, and enumerating it is how the credential list itself
 * kept needing another round.
 */
const REDIRECT_ENV_PATTERNS: readonly RegExp[] = [
  /(^|_)(HTTP|HTTPS|ALL|FTP|NO)_PROXY$/i,
  /(^|_)PROXY(_URL)?$/i,
  /_OPTIONS$/,
  /^NODE_OPTIONS$/,
  /(BASE_URL|API_BASE|API_URL|_ENDPOINT|_HOST|_GATEWAY)$/,
  /(CA_CERTS?|CA_BUNDLE|CERT_FILE|CERT_DIR|SSL_KEY_?FILE)$/,
  /^(LD_|DYLD_)/,
  /^(PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|BASH_ENV|ENV|GIT_SSH|GIT_SSH_COMMAND|GIT_EXTERNAL_DIFF|GIT_PROXY_COMMAND|SHELL)$/,
];

/** Names in `env` that redirect or inject code into a credential-holding process. */
export function redirectEnvKeysIn(env: NodeJS.ProcessEnv): readonly string[] {
  return Object.keys(env).filter(
    (key) => env[key] !== undefined && REDIRECT_ENV_PATTERNS.some((pattern) => pattern.test(key)),
  );
}

/**
 * The Control-Plane-to-node environment boundary.
 *
 * Refuses BOTH halves: a credential the Control Plane must never ship in, and a
 * variable that redirects or injects code into the process that already holds
 * the node's own credential (`REDIRECT_ENV_PATTERNS`). The name of this
 * function promises a boundary; before the redirect half existed it enforced
 * only the part that was easy to enumerate.
 */
export function assertNoInjectedCredentials(env: NodeJS.ProcessEnv | undefined): void {
  if (env === undefined) return;
  const offending = [
    ...CREDENTIAL_ENV_KEYS.filter((key) => env[key] !== undefined),
    ...redirectEnvKeysIn(env),
  ];
  if (offending.length > 0) throw new CredentialBoundaryError([...new Set(offending)]);
}

/**
 * Builds a vendor CLI's child environment from the node-local process env plus
 * a non-credential overlay supplied by the caller.
 *
 * Every subprocess invoker MUST call this and pass the result to
 * `spawnBounded` as `env`. Omitting `env` is not "inherit the parent" — it is
 * `minimalEnv()`, which has no credential in it at all (see `minimalEnv`), and
 * a vendor CLI spawned that way authenticates against nothing.
 */
export function nodeLocalEnv(
  base: NodeJS.ProcessEnv,
  overlay: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  assertNoInjectedCredentials(overlay);
  return { ...base, ...overlay };
}
