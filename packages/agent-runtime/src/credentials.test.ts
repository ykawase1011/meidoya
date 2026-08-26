import { describe, expect, it } from "vitest";

import {
  assertNoInjectedCredentials,
  CredentialBoundaryError,
  nodeLocalEnv,
  redirectEnvKeysIn,
} from "./credentials.js";

/**
 * The OTHER half of the credential boundary (09 section 3 / 10 section 9).
 *
 * `nodeLocalEnv` merges a caller-supplied overlay on top of the node's own
 * environment, which is where the vendor credential lives. It refused a key
 * that CARRIES a credential and nothing else — so an overlay of
 * `NODE_OPTIONS=--require /tmp/evil.js`, `HTTPS_PROXY=http://attacker` and
 * `ANTHROPIC_BASE_URL=https://attacker` passed the guard and landed in the
 * child alongside a live `ANTHROPIC_API_KEY`. Each of those is arbitrary code
 * in, or exfiltration out of, the credential-holding process.
 *
 * No real credential appears here and no assertion echoes a value.
 */
describe("credential boundary: redirect-class variables", () => {
  const DUMMY = "dummy-not-a-real-credential";

  it("refuses an overlay that redirects the credential-holding process", () => {
    for (const key of [
      "NODE_OPTIONS",
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "ANTHROPIC_BASE_URL",
      "OPENAI_BASE_URL",
      "OPENAI_API_BASE",
      "CODEX_ENDPOINT",
      "SSL_CERT_FILE",
      "NODE_EXTRA_CA_CERTS",
      "REQUESTS_CA_BUNDLE",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "PERL5OPT",
      "RUBYOPT",
      "PYTHONSTARTUP",
      "BASH_ENV",
      "GIT_SSH_COMMAND",
    ]) {
      expect(() => nodeLocalEnv({ ANTHROPIC_API_KEY: DUMMY }, { [key]: "x" }), key).toThrow(
        CredentialBoundaryError,
      );
      expect(() => assertNoInjectedCredentials({ [key]: "x" }), key).toThrow(
        CredentialBoundaryError,
      );
    }
  });

  it("names the offending keys without echoing their values", () => {
    try {
      nodeLocalEnv({}, { HTTPS_PROXY: "http://attacker.example", NODE_OPTIONS: "--require /x" });
      expect.unreachable("expected a CredentialBoundaryError");
    } catch (error) {
      const boundary = error as CredentialBoundaryError;
      expect(boundary.keys).toEqual(expect.arrayContaining(["HTTPS_PROXY", "NODE_OPTIONS"]));
      expect(boundary.message).not.toContain("attacker.example");
      expect(boundary.message).not.toContain("--require");
    }
  });

  it("still passes an overlay that redirects nothing", () => {
    expect(nodeLocalEnv({ PATH: "/bin" }, { MEIDOYA_RUN_ID: "run-1" })).toEqual({
      PATH: "/bin",
      MEIDOYA_RUN_ID: "run-1",
    });
    expect(redirectEnvKeysIn({ PATH: "/bin", CI: "1", MEIDOYA_RUN_ID: "run-1" })).toEqual([]);
    // The node's OWN environment is not an overlay: only what the caller adds
    // is checked, or a node could never hold a proxy setting of its own.
    expect(nodeLocalEnv({ HTTPS_PROXY: "http://corp.example" }, {}).HTTPS_PROXY).toBe(
      "http://corp.example",
    );
  });

  it("still refuses a credential the Control Plane ships in", () => {
    expect(() => nodeLocalEnv({}, { ANTHROPIC_API_KEY: DUMMY })).toThrow(CredentialBoundaryError);
    expect(() => nodeLocalEnv({}, { GITHUB_TOKEN: DUMMY })).toThrow(CredentialBoundaryError);
  });
});
