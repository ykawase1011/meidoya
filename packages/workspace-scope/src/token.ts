import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProjectId, ScopeToken, WorkspaceId } from "@meidoya/domain";
import { makeScope, type WorkspaceScope } from "./scope.js";

/**
 * v2 adds domain separation (environment + audience), an explicit expiry and
 * the issuing binding's revocation epoch. A v1 token is not accepted: it
 * carried none of those, so there is no safe way to interpret one.
 */
const TOKEN_VERSION = 2;

export type ScopeSecret = {
  readonly key: Uint8Array;
};

export function scopeSecretFrom(secret: string | Uint8Array): ScopeSecret {
  const key = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  if (key.length === 0) {
    throw new Error("scope secret must not be empty");
  }
  return { key };
}

/**
 * Everything a token asserts beyond the workspace scope itself.
 *
 * - `environmentId` / `audience` are the domain separation: a token minted for
 *   one environment or purpose does not verify anywhere else, even though the
 *   HMAC key might be shared by accident (backup restore, copied data dir).
 * - `bindingId` + `bindingEpoch` are what makes revocation possible: the issuer
 *   bumps the epoch when the binding is disabled, removed or re-provisioned,
 *   and every outstanding token stops resolving.
 * - `expiresAt` is a hard, signed lifetime.
 */
export type ScopeTokenClaims = {
  readonly environmentId: string;
  readonly audience: string;
  readonly bindingId: string;
  readonly bindingEpoch: number;
  readonly expiresAt: number;
};

type TokenPayload = {
  v: number;
  e: string;
  a: string;
  w: WorkspaceId;
  p: ProjectId[];
  b: string;
  k: number;
  i: number;
  x: number;
};

/**
 * Fixed key order + sorted projects: the canonical form is what is signed and
 * what is re-derived on verify.
 *
 * Re-deriving alone would only bind the MAC to the nine known fields, not to
 * the bytes actually transmitted — a holder of one valid token could add
 * unknown keys, re-order the object or re-spell the base64 and keep a verifying
 * token. `isCanonicalBody` closes that: verification rejects any body that is
 * not already byte-for-byte the encoding this function would have produced, so
 * a payload has exactly one valid token string.
 */
function canonicalPayload(payload: TokenPayload): string {
  return JSON.stringify({
    v: payload.v,
    e: payload.e,
    a: payload.a,
    w: payload.w,
    p: [...payload.p].sort(),
    b: payload.b,
    k: payload.k,
    i: payload.i,
    x: payload.x,
  });
}

/**
 * True when `raw` is the exact encoding this implementation would have emitted
 * for `payload`. Compared on the base64url text, so JSON key order, unknown
 * extra keys, project order and base64 spelling (padding, the non-url
 * alphabet, stray whitespace) are all covered by the one check.
 */
function isCanonicalBody(raw: string, payload: TokenPayload): boolean {
  return b64url(Buffer.from(canonicalPayload(payload), "utf8")) === raw;
}

function sign(secret: ScopeSecret, canonical: string): Buffer {
  return createHmac("sha256", secret.key).update(canonical, "utf8").digest();
}

function b64url(input: Buffer): string {
  return input.toString("base64url");
}

export function mintScopeToken(
  scope: WorkspaceScope,
  secret: ScopeSecret,
  claims: ScopeTokenClaims,
): ScopeToken {
  if (claims.environmentId === "" || claims.audience === "" || claims.bindingId === "") {
    throw new Error("scope token claims must name an environment, audience and binding");
  }
  const payload: TokenPayload = {
    v: TOKEN_VERSION,
    e: claims.environmentId,
    a: claims.audience,
    w: scope.workspaceId,
    // Deliberately NOT sorted here: `canonicalPayload` is the single place
    // canonical order is decided, and it sorts. A second sort on this line was
    // unreachable by any test — removing it or leaving it produced byte-identical
    // tokens — which is exactly the kind of enforcement that has no signal.
    p: [...scope.projects],
    b: claims.bindingId,
    k: claims.bindingEpoch,
    i: scope.issuedAt,
    x: claims.expiresAt,
  };
  const canonical = canonicalPayload(payload);
  const body = b64url(Buffer.from(canonical, "utf8"));
  const mac = b64url(sign(secret, canonical));
  return `${body}.${mac}`;
}

export type ScopeTokenRejection =
  | "malformed"
  | "unsupported-version"
  | "bad-signature"
  | "wrong-domain"
  | "expired"
  | "not-yet-valid";

export type ScopeTokenVerification =
  | { ok: true; scope: WorkspaceScope; claims: ScopeTokenClaims }
  | { ok: false; reason: ScopeTokenRejection };

/**
 * Verification always needs a clock and a domain: there is no "skip the time
 * bounds" mode, because that is exactly how a token ends up living forever.
 */
export type VerifyOptions = {
  environmentId: string;
  audience: string;
  now: number;
  /** Optional extra clamp on top of the token's own signed expiry. */
  maxAgeMs?: number;
  /** Tolerance for a token issued slightly ahead of this clock. Default 0. */
  clockSkewMs?: number;
};

/** The version is read before the shape is validated, so an older token is
 * reported as unsupported rather than malformed. */
function peekVersion(raw: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const v = (parsed as Record<string, unknown>)["v"];
    return typeof v === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}

function parsePayload(raw: string): TokenPayload | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  const { v, e, a, w, p, b, k, i, x } = candidate;
  if (typeof v !== "number") return undefined;
  if (typeof e !== "string" || typeof a !== "string" || typeof b !== "string") return undefined;
  if (typeof w !== "string" || typeof k !== "number") return undefined;
  if (typeof i !== "number" || typeof x !== "number") return undefined;
  if (!Array.isArray(p) || p.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return { v, e, a, w, p: p as ProjectId[], b, k, i, x };
}

export function verifyScopeToken(
  token: ScopeToken,
  secret: ScopeSecret,
  options: VerifyOptions,
): ScopeTokenVerification {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }
  const body = parts[0];
  const mac = parts[1];
  if (body === undefined || mac === undefined || body === "" || mac === "") {
    return { ok: false, reason: "malformed" };
  }
  const version = peekVersion(body);
  if (version !== undefined && version !== TOKEN_VERSION) {
    return { ok: false, reason: "unsupported-version" };
  }
  const payload = parsePayload(body);
  if (payload === undefined) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.v !== TOKEN_VERSION) {
    return { ok: false, reason: "unsupported-version" };
  }
  // Bind the MAC to the transmitted bytes. `parsePayload` deliberately drops
  // unknown keys, so without this a valid token could be decorated with
  // arbitrary JSON, re-ordered, or re-spelled in base64 and still verify. The
  // check needs no secret, so running it before the MAC leaks nothing.
  if (!isCanonicalBody(body, payload)) {
    return { ok: false, reason: "malformed" };
  }

  const expected = sign(secret, canonicalPayload(payload));
  let presented: Buffer;
  try {
    presented = Buffer.from(mac, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // Bind the MAC half to its transmitted bytes too, exactly as the body half is
  // bound above. Node's base64url decoder is lenient (stray `=` padding, the
  // non-url alphabet, and several spellings of the final character all decode
  // to the same digest), so without this ONE minted token had six accepted
  // string forms — and "the token string is a stable identity" is the invariant
  // a per-token replay cache or rate limit would be keyed on. Re-encoding what
  // we decoded and demanding the presented text back is the whole check.
  if (b64url(presented) !== mac) {
    return { ok: false, reason: "malformed" };
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  // Domain separation is checked after the MAC so an attacker learns nothing
  // about the environment from an unsigned guess.
  if (payload.e !== options.environmentId || payload.a !== options.audience) {
    return { ok: false, reason: "wrong-domain" };
  }

  const now = options.now;
  const skew = options.clockSkewMs ?? 0;
  if (payload.i - skew > now) {
    return { ok: false, reason: "not-yet-valid" };
  }
  if (now >= payload.x + skew) {
    return { ok: false, reason: "expired" };
  }
  if (options.maxAgeMs !== undefined && now - payload.i > options.maxAgeMs) {
    return { ok: false, reason: "expired" };
  }

  const scope = makeScope(payload.w, payload.p, payload.i);
  if (!scope.ok) {
    return { ok: false, reason: "malformed" };
  }
  return {
    ok: true,
    scope: scope.scope,
    claims: {
      environmentId: payload.e,
      audience: payload.a,
      bindingId: payload.b,
      bindingEpoch: payload.k,
      expiresAt: payload.x,
    },
  };
}
