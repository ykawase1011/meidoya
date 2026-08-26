import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveWorkspaceScope, type IngressBinding, type WorkspaceScope } from "./scope.js";
import {
  mintScopeToken,
  scopeSecretFrom,
  verifyScopeToken,
  type ScopeTokenClaims,
  type VerifyOptions,
} from "./token.js";

const secret = scopeSecretFrom("server-side-secret");
const otherSecret = scopeSecretFrom("attacker-secret");

const binding: IngressBinding = {
  channel: "slack",
  accountRef: "personal",
  externalRef: "C_GRAMMARXIV",
  workspaceId: "work-grammarxiv",
  projects: ["grammarxiv", "shared-library"],
};

const claims: ScopeTokenClaims = {
  environmentId: "env-a",
  audience: "control-plane",
  bindingId: "slack:work-grammarxiv",
  bindingEpoch: 1,
  expiresAt: 10_000,
};

const verify: VerifyOptions = { environmentId: "env-a", audience: "control-plane", now: 1_500 };

function scopeOf(b: IngressBinding = binding, issuedAt = 1000) {
  const derived = deriveWorkspaceScope(b, issuedAt);
  if (!derived.ok) {
    throw new Error(derived.error.message);
  }
  return derived.scope;
}

function tokenOf(
  overrides: Partial<ScopeTokenClaims> = {},
  b: IngressBinding = binding,
  issuedAt = 1_000,
): string {
  return mintScopeToken(scopeOf(b, issuedAt), secret, { ...claims, ...overrides });
}

describe("scope derivation", () => {
  it("derives workspaceId and projects from the ingress binding only", () => {
    const scope = scopeOf();
    expect(scope.workspaceId).toBe("work-grammarxiv");
    expect(scope.projects).toEqual(["grammarxiv", "shared-library"]);
  });

  it("rejects empty workspace ids and duplicate projects", () => {
    expect(deriveWorkspaceScope({ ...binding, workspaceId: " " }, 1).ok).toBe(false);
    expect(deriveWorkspaceScope({ ...binding, projects: ["a", "a"] }, 1).ok).toBe(false);
  });
});

describe("scope token", () => {
  it("round-trips a minted token with its claims", () => {
    const verified = verifyScopeToken(tokenOf(), secret, verify);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.scope.workspaceId).toBe("work-grammarxiv");
      expect(verified.scope.projects).toEqual(["grammarxiv", "shared-library"]);
      expect(verified.claims).toEqual(claims);
    }
  });

  it("refuses to mint without a domain", () => {
    expect(() => mintScopeToken(scopeOf(), secret, { ...claims, environmentId: "" })).toThrow();
    expect(() => mintScopeToken(scopeOf(), secret, { ...claims, audience: "" })).toThrow();
    expect(() => mintScopeToken(scopeOf(), secret, { ...claims, bindingId: "" })).toThrow();
  });

  it("rejects a token signed with a different secret", () => {
    const forged = mintScopeToken(scopeOf(), otherSecret, claims);
    expect(verifyScopeToken(forged, secret, verify)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a token whose payload was tampered with", () => {
    const parts = tokenOf().split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        v: 2,
        e: "env-a",
        a: "control-plane",
        w: "work-it",
        p: ["product-a"],
        b: "slack:work-grammarxiv",
        k: 1,
        i: 1_000,
        x: 10_000,
      }),
      "utf8",
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${parts[1] ?? ""}`;
    expect(verifyScopeToken(tampered, secret, verify)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a hand-written token with no signature", () => {
    const payload = Buffer.from(
      JSON.stringify({ v: 2, e: "env-a", a: "control-plane", w: "work-it", p: [], b: "b", k: 1, i: 0, x: 1 }),
      "utf8",
    ).toString("base64url");
    expect(verifyScopeToken(payload, secret, verify).ok).toBe(false);
    expect(verifyScopeToken(`${payload}.`, secret, verify)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyScopeToken(`${payload}.AAAA`, secret, verify)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects garbage and wrong-version tokens", () => {
    expect(verifyScopeToken("", secret, verify)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyScopeToken("a.b.c", secret, verify)).toEqual({ ok: false, reason: "malformed" });
    // A v1 token (no environment, audience, binding or expiry) is not accepted.
    const legacy = Buffer.from(
      JSON.stringify({ v: 1, w: "work-it", p: [], i: 0 }),
      "utf8",
    ).toString("base64url");
    expect(verifyScopeToken(`${legacy}.AAAA`, secret, verify)).toEqual({
      ok: false,
      reason: "unsupported-version",
    });
  });

  it("enforces the signed lifetime without needing an explicit maxAge", () => {
    const token = tokenOf({ expiresAt: 5_000 });
    expect(verifyScopeToken(token, secret, { ...verify, now: 4_999 }).ok).toBe(true);
    expect(verifyScopeToken(token, secret, { ...verify, now: 5_000 })).toEqual({
      ok: false,
      reason: "expired",
    });
    // Ten years on, still expired — the old code accepted this.
    expect(verifyScopeToken(token, secret, { ...verify, now: 5_000 + 315_360_000_000 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a not-yet-valid token, including one stamped ten years ahead", () => {
    expect(verifyScopeToken(tokenOf(), secret, { ...verify, now: 500 })).toEqual({
      ok: false,
      reason: "not-yet-valid",
    });
    const future = 315_360_000_000;
    const ahead = tokenOf({ expiresAt: future + 10_000 }, binding, future);
    expect(verifyScopeToken(ahead, secret, { ...verify, now: 1_500 })).toEqual({
      ok: false,
      reason: "not-yet-valid",
    });
  });

  it("still honours an explicit maxAge clamp on top of the signed expiry", () => {
    expect(verifyScopeToken(tokenOf(), secret, { ...verify, now: 5_000, maxAgeMs: 1_000 })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verifyScopeToken(tokenOf(), secret, { ...verify, now: 1_500, maxAgeMs: 1_000 }).ok).toBe(
      true,
    );
  });

  it("does not verify a token outside the environment or audience it was minted for", () => {
    const token = tokenOf();
    expect(verifyScopeToken(token, secret, { ...verify, environmentId: "env-b" })).toEqual({
      ok: false,
      reason: "wrong-domain",
    });
    expect(verifyScopeToken(token, secret, { ...verify, audience: "node-plane" })).toEqual({
      ok: false,
      reason: "wrong-domain",
    });
    // And the other direction: a token minted for B does not verify against A.
    const forB = mintScopeToken(scopeOf(), secret, {
      ...claims,
      environmentId: "env-b",
      audience: "node-plane",
    });
    expect(verifyScopeToken(forB, secret, verify)).toEqual({ ok: false, reason: "wrong-domain" });
  });

  describe("the MAC is bound to the transmitted body", () => {
    /** Re-encode a token's body from `edit`, keeping the original MAC. */
    function reencode(edit: (payload: Record<string, unknown>) => unknown): string {
      const [body, mac] = tokenOf().split(".");
      const payload = JSON.parse(
        Buffer.from(body ?? "", "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      return `${Buffer.from(JSON.stringify(edit(payload)), "utf8").toString("base64url")}.${mac ?? ""}`;
    }

    it("rejects a body carrying extra keys the parser would have dropped", () => {
      // The attacker holds one valid token and only adds fields.
      expect(
        verifyScopeToken(
          reencode((p) => ({ ...p, admin: true, p2: ["everything"] })),
          secret,
          verify,
        ),
      ).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects a re-ordered body and a re-ordered project list", () => {
      expect(
        verifyScopeToken(
          reencode((p) => ({ x: p["x"], i: p["i"], k: p["k"], b: p["b"], p: p["p"], w: p["w"], a: p["a"], e: p["e"], v: p["v"] })),
          secret,
          verify,
        ),
      ).toEqual({ ok: false, reason: "malformed" });
      expect(
        verifyScopeToken(
          reencode((p) => ({ ...p, p: [...(p["p"] as string[])].reverse() })),
          secret,
          verify,
        ),
      ).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects a body re-spelled in a different base64 encoding", () => {
      const [body, mac] = tokenOf().split(".");
      // Node's base64 decoder tolerates stray padding, so these decode to the
      // very same JSON — but they are not the encoding we minted, so they are
      // not the same token.
      for (const respelled of [`${body ?? ""}=`, `${body ?? ""}==`]) {
        expect(Buffer.from(respelled, "base64url").toString("utf8")).toBe(
          Buffer.from(body ?? "", "base64url").toString("utf8"),
        );
        expect(verifyScopeToken(`${respelled}.${mac ?? ""}`, secret, verify)).toEqual({
          ok: false,
          reason: "malformed",
        });
      }
    });

    it("rejects every other spelling of the MAC half, not just of the body", () => {
      // The body half was bound to its bytes; the MAC half was not, so Node's
      // lenient base64url decoder accepted several strings for ONE minted
      // token — and the identity claim below is what a replay cache or a
      // per-token rate limit would be keyed on.
      const [body, mac] = tokenOf().split(".");
      const bytes = Buffer.from(mac ?? "", "base64url");
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const respellings = [
        `${mac ?? ""}=`,
        `${mac ?? ""}==`,
        // Trailing bits are not significant, so several final characters decode
        // to the very same digest.
        ...[...alphabet]
          .map((c) => `${(mac ?? "").slice(0, -1)}${c}`)
          .filter((s) => s !== mac && Buffer.from(s, "base64url").equals(bytes)),
      ];
      // If this ever hits zero the test has stopped testing anything.
      expect(respellings.length).toBeGreaterThan(2);

      for (const respelled of respellings) {
        expect(Buffer.from(respelled, "base64url").equals(bytes)).toBe(true);
        expect(verifyScopeToken(`${body ?? ""}.${respelled}`, secret, verify)).toEqual({
          ok: false,
          reason: "malformed",
        });
      }
      // No compatibility break: the string actually minted still verifies.
      expect(verifyScopeToken(tokenOf(), secret, verify).ok).toBe(true);
    });

    it("makes the token string a stable identity for a given payload", () => {
      // Exactly one accepted encoding per payload: safe to key a replay cache
      // or an audit log on the token itself.
      expect(tokenOf()).toBe(tokenOf());
      expect(verifyScopeToken(tokenOf(), secret, verify).ok).toBe(true);
    });
  });

  it("normalises project order so signature checking is order-independent", () => {
    const a = mintScopeToken(scopeOf({ ...binding, projects: ["b", "a"] }), secret, claims);
    const b = mintScopeToken(scopeOf({ ...binding, projects: ["a", "b"] }), secret, claims);
    expect(a).toBe(b);
  });

  it("mints the canonical order even from a scope that is NOT already sorted", () => {
    // The test above only proves `makeScope` sorts: every scope it can build is
    // sorted before minting ever sees it, so the mint's own canonicalisation
    // had no coverage at all. The brand is compile-time only, so a raw scope
    // reaches `mintScopeToken` in whatever order it was handed.
    const raw = (projects: readonly string[]): WorkspaceScope =>
      ({ workspaceId: "work-grammarxiv", projects, issuedAt: 1_000 }) as unknown as WorkspaceScope;

    const unsorted = mintScopeToken(raw(["shared-library", "grammarxiv"]), secret, claims);
    expect(unsorted).toBe(mintScopeToken(raw(["grammarxiv", "shared-library"]), secret, claims));
    // And it is the canonical BODY, so the minted token verifies: an unsorted
    // project list in the signed bytes would be rejected as non-canonical.
    const verified = verifyScopeToken(unsorted, secret, verify);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.scope.projects).toEqual(["grammarxiv", "shared-library"]);
    }
  });
});

/**
 * Everything below was written to kill a mutant the mutation gate found alive:
 * a check in `token.ts` that could be deleted outright with this file green.
 * See `docs/mutation-testing.md`. Each `it` names the guard it pins.
 */
describe("guards the suite used to leave undefended", () => {
  describe("scopeSecretFrom", () => {
    it("keeps the key as bytes, whichever form the secret arrives in", () => {
      // Nothing asserted that a `string` secret is utf8-encoded rather than
      // stored as-is, so both branches of the encode could be deleted: Node's
      // `createHmac` happily takes a string key and produces the same digest
      // for ASCII, which is why the signature tests never noticed.
      const fromText = scopeSecretFrom("server-side-secret");
      expect(fromText.key).toBeInstanceOf(Uint8Array);
      expect([...fromText.key]).toEqual([...new TextEncoder().encode("server-side-secret")]);

      // And the documented Uint8Array form was never exercised at all: passing
      // one through `TextEncoder.encode` would stringify it to "115,101,..."
      // and silently change the signing key.
      const fromBytes = scopeSecretFrom(new TextEncoder().encode("server-side-secret"));
      expect(mintScopeToken(scopeOf(), fromBytes, claims)).toBe(
        mintScopeToken(scopeOf(), fromText, claims),
      );
    });

    it("refuses an empty secret in either form", () => {
      // The throw was reachable and correct; no test ever took it.
      expect(() => scopeSecretFrom("")).toThrow(/must not be empty/);
      expect(() => scopeSecretFrom(new Uint8Array(0))).toThrow(/must not be empty/);
    });
  });

  describe("verifyScopeToken's parse floor", () => {
    /**
     * A body in exactly the canonical encoding, signed with the real secret —
     * i.e. what an insider with the key, or a future version of this code,
     * could actually present. Field values are arbitrary on purpose: the point
     * is to reach the shape checks with a MAC that would otherwise verify.
     */
    function signed(fields: Record<string, unknown>): string {
      const projects = fields["p"];
      const canonical = JSON.stringify({
        v: fields["v"],
        e: fields["e"],
        a: fields["a"],
        w: fields["w"],
        p: Array.isArray(projects) ? [...(projects as unknown[])].sort() : projects,
        b: fields["b"],
        k: fields["k"],
        i: fields["i"],
        x: fields["x"],
      });
      const body = Buffer.from(canonical, "utf8").toString("base64url");
      const mac = createHmac("sha256", "server-side-secret")
        .update(canonical, "utf8")
        .digest()
        .toString("base64url");
      return `${body}.${mac}`;
    }

    const wellFormed = {
      v: 2,
      e: "env-a",
      a: "control-plane",
      w: "work-grammarxiv",
      p: ["grammarxiv"],
      b: "slack:work-grammarxiv",
      k: 1,
      i: 1_000,
      x: 10_000,
    };

    it("agrees with itself: the hand-signed control token verifies", () => {
      // Without this the cases below could all be passing for the wrong
      // reason — a broken signing helper rather than a working guard.
      expect(verifyScopeToken(signed(wellFormed), secret, verify).ok).toBe(true);
    });

    it("rejects a body that is not a JSON object at all", () => {
      // `null` is the sharp one: with the null check gone, destructuring it
      // throws a TypeError out of `verifyScopeToken` instead of returning a
      // rejection, so every caller sees a crash rather than a denial.
      for (const body of ["null", "[1,2]", "5", '"a string"']) {
        const encoded = Buffer.from(body, "utf8").toString("base64url");
        expect(verifyScopeToken(`${encoded}.AAAA`, secret, verify)).toEqual({
          ok: false,
          reason: "malformed",
        });
      }
    });

    it("rejects a signed body whose version is not a number", () => {
      // Reported as malformed, not unsupported-version: the version peek only
      // trusts a numeric `v`, and the shape check is what enforces that.
      expect(verifyScopeToken(signed({ ...wellFormed, v: "2" }), secret, verify)).toEqual({
        ok: false,
        reason: "malformed",
      });
    });

    it.each([
      ["environment", { e: 5 }],
      ["audience", { a: 5 }],
      ["binding id", { b: 5 }],
      ["workspace id", { w: 5 }],
      ["binding epoch", { k: "1" }],
      ["issued-at", { i: "1000" }],
      ["expiry", { x: "10000" }],
    ])("rejects a signed body whose %s has the wrong type", (_name, override) => {
      // Each of these has a downstream consumer that would take the wrong-typed
      // value and do something plausible-looking with it: a numeric `e` falls
      // through to the domain check and reports wrong-domain, a string `i`
      // compares as a number and passes the freshness bounds outright. The
      // parse floor is what stops that, and none of it was pinned.
      expect(verifyScopeToken(signed({ ...wellFormed, ...override }), secret, verify)).toEqual({
        ok: false,
        reason: "malformed",
      });
    });

    it("rejects a signed body whose project list is not a list of strings", () => {
      // Sorted numerically-before-alphabetically so the body IS canonical and
      // the MAC verifies; the only thing standing between this and a scope
      // built from `[5, "grammarxiv"]` is the element type check.
      expect(
        verifyScopeToken(signed({ ...wellFormed, p: [5, "grammarxiv"] }), secret, verify),
      ).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects a signed body the scope constructor would refuse", () => {
      // `makeScope` re-validates what the signature already vouched for, and
      // that re-validation had no test: with it removed, `scope.scope` is
      // undefined and verification returns ok:true carrying nothing.
      expect(verifyScopeToken(signed({ ...wellFormed, w: " " }), secret, verify)).toEqual({
        ok: false,
        reason: "malformed",
      });
      expect(
        verifyScopeToken(signed({ ...wellFormed, p: ["dup", "dup"] }), secret, verify),
      ).toEqual({ ok: false, reason: "malformed" });
    });
  });

  it("rejects a valid token with anything appended after a third separator", () => {
    // `"a.b.c"` was already tested — but it is malformed for an unrelated
    // reason (neither half decodes), so the two-part check itself was
    // undefended. Only the first two parts are ever read, so without it ONE
    // minted token has unboundedly many accepted spellings, and "the token
    // string is a stable identity" is what a replay cache would be keyed on.
    const token = tokenOf();
    expect(verifyScopeToken(token, secret, verify).ok).toBe(true);
    for (const suffix of [".", ".junk", `.${token}`]) {
      expect(verifyScopeToken(`${token}${suffix}`, secret, verify)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });
});
