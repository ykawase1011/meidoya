import {
  CREDENTIAL_ENV_KEYS,
  CredentialBoundaryError,
  assertNoInjectedCredentials,
  nodeLocalEnv,
  redactSecrets,
} from "@meidoya/agent-runtime";

/**
 * 09 section 3 / 10 section 9: the Claude subscription credential lives on the
 * Execution Node only. The Control Plane may never ship one in, and no
 * credential value may reach an event, a log line or the DB.
 *
 * The boundary itself is implemented once, in `@meidoya/agent-runtime`, so the
 * Codex adapter is held to the same rule instead of quietly having none; these
 * are the Claude adapter's names for it.
 */
export { CREDENTIAL_ENV_KEYS, CredentialBoundaryError, assertNoInjectedCredentials, nodeLocalEnv };

/**
 * Redacts credential-shaped text. The implementation is shared across every
 * runtime adapter (`@meidoya/agent-runtime`) so there is exactly one pattern
 * set to keep current; this alias exists for callers that already know the
 * Claude adapter's name for it.
 */
export const redactCredentials = redactSecrets;
