/**
 * Credential redaction for everything a runtime adapter emits (09 section 3,
 * 10 section 9).
 *
 * WHY this lives in `agent-runtime` and not in a vendor adapter: redaction is a
 * property of the *runtime event boundary*, not of one vendor. Every adapter
 * turns vendor bytes into `AgentEvent`s through `AgentEventFactory`, and that
 * factory redacts, so a new adapter (or a new event field on an existing one)
 * is covered without anyone remembering to call a helper.
 *
 * WHERE it may run (this is load-bearing, read before moving a call):
 * - on FREE TEXT that is already known not to be a machine-readable document
 *   (a message, a log line, an error), and
 * - on PARSED values (`redactDeep`), after the document has been decoded.
 *
 * It must NOT run on a serialized document before that document is parsed.
 * A rule that redacts an assignment keeps the key and any quoting, so a quoted
 * JSON value survives as valid JSON — but a BARE value cannot: `{"token": 1}`
 * necessarily becomes `{"token": [redacted]}`, which no longer parses. That is
 * why the adapters parse vendor lines first and redact the decoded values, and
 * why `AgentEventFactory` deep-redacts `structuredOutput` rather than its
 * serialization. Redacting first silently corrupted every structured payload
 * whose field names happened to look credential-ish.
 *
 * Rules of the road for the patterns below:
 * - every rule is anchored on a literal prefix or an explicit key word, so a
 *   pass is linear in the input length: no nested quantifiers, no alternation
 *   inside a repetition that can match the same text two ways, and no
 *   unbounded `[\s\S]*` tail. These run on streamed model output, so
 *   catastrophic backtracking would be a DoS.
 * - a key-name rule anchors on the KEY WORD itself and validates what precedes
 *   it with a one-character lookbehind, instead of consuming a variable-length
 *   prefix. That is both cheaper (no prefix backtracking at every offset) and
 *   more precise (`monkeys`, `keyboard`, `tokenizer`, `keywords` are words, not
 *   key names).
 *
 * KNOWN LIMIT — a credential split across two separately-redacted chunks (say
 * the first half arrives in one `message` event and the rest in the next) is
 * not caught: each chunk is individually clean. A carry-over buffer would only
 * half-help, because the leading half has already been emitted by the time the
 * trailing half arrives; the only real fix is to withhold output until a
 * boundary, which would break streaming. The mitigations that do work are
 * upstream: credentials never cross the Control Plane boundary at all
 * (`assertNoInjectedCredentials`), and the adapters emit vendor messages whole
 * rather than token-by-token.
 */

export const REDACTED = "[redacted]";

/** Marker for a reference cycle met while walking a value; never a real datum. */
export const CIRCULAR = "[circular]";

/** Marker for a value below the depth cap; see `MAX_DEPTH`. */
export const TRUNCATED = "[truncated]";

/**
 * Environment variables that carry a credential. The Control Plane may never
 * ship one to a node, and a value of one may never reach an event or the DB.
 */
export const CREDENTIAL_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
];

type Rule = {
  readonly pattern: RegExp;
  readonly replace: (...args: string[]) => string;
};

const whole = (): string => REDACTED;

/** Keeps `key=` / `"key":` and the value's quoting; replaces only the value. */
function assignment(_match: string, head: string, value: string): string {
  if (value.startsWith('"')) return `${head}"${REDACTED}"`;
  if (value.startsWith("'")) return `${head}'${REDACTED}'`;
  return `${head}${REDACTED}`;
}

/**
 * Value shapes an assignment can take: quoted (JSON/ini/shell) or bare. The
 * leading lookahead keeps redaction idempotent: without it a second rule would
 * match the `[redacted]` a first rule just wrote and leave a stray bracket.
 */
const ASSIGNED_VALUE = `(?!\\[redacted\\])(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;}\\]]+)`;

/** Words that make the value on the right-hand side a secret by convention. */
const SECRET_WORDS = [
  "key",
  "secret",
  "token",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "authorization",
] as const;

const capitalize = (word: string): string => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;

/** `Key|Secret|…|KEY|SECRET|…` — the shapes a camelCase component can take. */
const CAMEL_SECRET_WORDS = [
  ...SECRET_WORDS.map(capitalize),
  ...SECRET_WORDS.map((word) => word.toUpperCase()),
].join("|");

/**
 * What may follow the key word and still be part of the same key name: an
 * optional plural, then any number of separator-joined components
 * (`secret_access_key`, `api.key.id`). A LETTER may not follow directly — that
 * is what makes `keyboard`, `tokenizer` and `keywords` ordinary words. A
 * camelCase continuation (`tokenCount`) is likewise not a key name here; when
 * the name really is one (`awsSecretKey`) the trailing component matches on its
 * own, so nothing is lost.
 */
const KEY_TAIL = `[sS]?(?:[_.\\-][A-Za-z0-9_.\\-]{0,40})?`;

/** `"…":` / `…=` / `…: ` — the closing quote is optional, the operator is not. */
const KEY_TO_VALUE = `["'\`]?\\s*[:=]\\s*`;

/** A real newline, or the `\n` escape a PEM block carries inside a JSON string. */
const PEM_SEP = `(?:\\\\n|\\r?\\n)`;
/**
 * One line of a PEM block: base64 armour, or a legacy `Proc-Type:` / `DEK-Info:`
 * header. Optional, so an unrecognised line simply ends the block rather than
 * being swallowed. Every part is length-bounded and anchored on a separator, so
 * the whole pattern is linear — no lazy `[\s\S]*` scan per header occurrence.
 */
const PEM_BODY_LINE = `(?:[A-Za-z0-9+/=]{1,4096}|[A-Za-z][A-Za-z-]{0,20}: ?[^\\r\\n]{0,200})?`;
const PEM_LABEL = `(?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?`;

const RULES: readonly Rule[] = [
  // PEM blocks: RSA / EC / OPENSSH / PKCS#8 / ENCRYPTED.
  //
  // The tail used to be `|[\s\S]*$`, which ate the rest of the text after any
  // mention of a header: "replace the -----BEGIN PRIVATE KEY----- header, then
  // deploy" became "replace the [redacted]". A block is now matched by its
  // actual SHAPE — header, armour lines, optional END — so a block truncated by
  // a cut stream is still redacted through its body, while a header merely
  // mentioned in prose (no newline, no armour) redacts to the header alone and
  // the sentence survives.
  {
    pattern: new RegExp(
      `-----BEGIN ${PEM_LABEL}-----(?:${PEM_SEP}${PEM_BODY_LINE})*(?:${PEM_SEP}?-----END ${PEM_LABEL}-----)?`,
      "gi",
    ),
    replace: whole,
  },
  // Anthropic / OpenAI style keys, including project and org scoped variants.
  { pattern: /\bsk-(?:ant-|proj-|org-|live-|test-)?[A-Za-z0-9_-]{8,}/gi, replace: whole },
  // GitHub personal / OAuth / user / server / refresh tokens and fine-grained PATs.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/gi, replace: whole },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi, replace: whole },
  // Slack bot / user / app / refresh / legacy tokens.
  { pattern: /\bxox[baprse]-[A-Za-z0-9-]{8,}/gi, replace: whole },
  // Google API keys.
  { pattern: /\bAIza[A-Za-z0-9_-]{10,}\b/gi, replace: whole },
  // AWS access key ids (all documented unique-id prefixes).
  {
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA)[A-Z0-9]{16}\b/g,
    replace: whole,
  },
  // JWTs (header.payload.signature). Segment lengths are capped so a long run
  // of base64url characters cannot make the `.`-seeking backtrack quadratic.
  {
    pattern: /\bey[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{6,4096}\.[A-Za-z0-9_-]{6,1024}/g,
    replace: whole,
  },
  // `Authorization: Bearer <token>` and Basic credentials.
  {
    pattern: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_m: string, scheme: string) => `${scheme} ${REDACTED}`,
  },
  // Known credential environment variables in `KEY=value` / `KEY: value` form.
  {
    pattern: new RegExp(
      `\\b(${CREDENTIAL_ENV_KEYS.join("|")})(\\s*[:=]\\s*)(${ASSIGNED_VALUE})`,
      "gi",
    ),
    replace: (_m: string, key: string, sep: string, value: string) =>
      assignment(_m, `${key}${sep}`, value),
  },
  // Generic `…key|secret|token|password… = value` in ini, env, YAML and JSON,
  // where the key word starts a name component (`key`, `api_key`, `X-API-KEY`).
  // The lookbehind is what stops `monkeys:` and `turkeys=` from matching: the
  // key word may not continue a preceding word.
  {
    pattern: new RegExp(
      `(?<![A-Za-z0-9])((?:${SECRET_WORDS.join("|")})${KEY_TAIL}${KEY_TO_VALUE})(${ASSIGNED_VALUE})`,
      "gi",
    ),
    replace: assignment,
  },
  // The same, for a camelCase component (`clientSecret`, `apiKey`, and the
  // trailing component of `awsSecretKey`). Case is significant here, so this
  // cannot share the case-insensitive rule above. No lookbehind: a capitalised
  // word at a position the rule above already covers is redacted by that rule,
  // so restricting this one to mid-word positions would only cost a scan.
  {
    pattern: new RegExp(
      `((?:${CAMEL_SECRET_WORDS})${KEY_TAIL}${KEY_TO_VALUE})(${ASSIGNED_VALUE})`,
      "g",
    ),
    replace: assignment,
  },
];

/**
 * Replaces credential-shaped substrings with `[redacted]`.
 *
 * Idempotent: redacting already-redacted text is a no-op beyond re-matching the
 * placeholder, which redacts to itself.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(
      rule.pattern,
      rule.replace as (substring: string, ...args: unknown[]) => string,
    );
  }
  return out;
}

/**
 * Depth cap for `redactDeep`. Structured outputs are shallow; anything deeper
 * is either an attack or a mistake, and recursing into it risks a stack
 * overflow inside the event factory — which has no error path.
 */
const MAX_DEPTH = 64;

/**
 * Recursively redacts every string in a parsed value: object values, object
 * KEYS, array elements, `Map` keys and values, `Set` members.
 *
 * Fail-closed by construction:
 * - a reference cycle yields `[circular]` instead of a `RangeError` (this ran
 *   inside `AgentEventFactory.make`, which has no try/catch, so a cyclic
 *   payload used to take down the run);
 * - byte containers (`Buffer`, any `TypedArray`, `DataView`) are NOT walked as
 *   index maps. Walking them turned `Buffer.from(secret)` into
 *   `{"0":115,…}` — every byte preserved, the redaction trivially undone by
 *   `Buffer.from(Object.values(out))`. A container whose bytes decode to
 *   anything credential-shaped is replaced wholesale;
 * - `Map`, `Set` and `Date` keep their type instead of flattening to `{}`;
 * - properties are written with `defineProperty`, so a `__proto__` key from
 *   `JSON.parse` becomes an ordinary own property instead of reassigning the
 *   accumulator's prototype;
 * - accessors are not invoked. Running an arbitrary getter during redaction is
 *   a side effect we will not take; such properties are dropped.
 */
export function redactDeep(value: unknown): unknown {
  return redactValue(value, new Set<object>(), 0);
}

function isStructuredCredentialKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "set_cookie" ||
    normalized === "password" ||
    normalized === "passwd" ||
    normalized === "passphrase" ||
    normalized === "credential" ||
    normalized === "credentials" ||
    normalized === "secret" ||
    normalized.endsWith("_secret") ||
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_private_key") ||
    normalized.endsWith("_secret_key")
  );
}

function redactBytes(view: ArrayBufferView): unknown {
  const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  const text = bytes.toString("utf8");
  // A container is only interesting if its *decoded* form is credential-shaped;
  // otherwise it is binary payload and is handed back untouched.
  return redactSecrets(text) === text ? view : REDACTED;
}

function redactValue(value: unknown, seen: Set<object>, depth: number): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") {
    // number / boolean / bigint / undefined / symbol / function: no text to
    // redact, and functions never survive the serialization boundary anyway.
    return value;
  }

  if (seen.has(value)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return TRUNCATED;

  if (value instanceof Error) return redactError(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return value;
  if (ArrayBuffer.isView(value)) return redactBytes(value);
  if (value instanceof ArrayBuffer) return redactBytes(new Uint8Array(value));

  // Tracked only for the duration of this branch, so a value referenced twice
  // in a DAG is redacted twice rather than reported as a cycle.
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, seen, depth + 1));
    }
    if (value instanceof Map) {
      const out = new Map<unknown, unknown>();
      for (const [k, v] of value) {
        out.set(redactValue(k, seen, depth + 1), redactValue(v, seen, depth + 1));
      }
      return out;
    }
    if (value instanceof Set) {
      const out = new Set<unknown>();
      for (const item of value) out.add(redactValue(item, seen, depth + 1));
      return out;
    }

    const out: Record<string, unknown> = {};
    // `getOwnPropertyNames`, not `Object.entries`: a non-enumerable own
    // property is still data that would otherwise be silently dropped.
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      Object.defineProperty(out, redactSecrets(key), {
        value: isStructuredCredentialKey(key)
          ? REDACTED
          : redactValue(descriptor.value, seen, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Returns an error whose message and stack are redacted. A thrown exception is
 * an egress like any other: a spawn failure or a parse error can quote the
 * offending text verbatim. The original error is deliberately NOT attached as
 * `cause`, because a cause chain is exactly how the raw value gets logged again.
 */
export function redactError(error: unknown): Error {
  if (error instanceof Error) {
    const redacted = new Error(redactSecrets(error.message));
    redacted.name = error.name;
    if (typeof error.stack === "string") redacted.stack = redactSecrets(error.stack);
    return redacted;
  }
  return new Error(redactSecrets(typeof error === "string" ? error : String(error)));
}
