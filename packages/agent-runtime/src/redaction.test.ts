import { describe, expect, it } from "vitest";
import { AgentEventFactory } from "./event-stream.js";
import { REDACTED, redactDeep, redactError, redactSecrets } from "./redaction.js";

/**
 * Every sample below is an obvious dummy. Nothing here is, or resembles, a
 * usable credential: the point is the SHAPE, never the value.
 */
const PRIVATE_KEY_BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const RSA_PRIVATE_KEY_BEGIN = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");
const OPENSSH_PRIVATE_KEY_BEGIN = ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" ");
const PRIVATE_KEY_END = "-----END PRIVATE KEY-----";
const RSA_PRIVATE_KEY_END = "-----END RSA PRIVATE KEY-----";
const OPENSSH_PRIVATE_KEY_END = "-----END OPENSSH PRIVATE KEY-----";
const JWT_SAMPLE = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiJEVU1NWSJ9",
  "DUMMYsignature0",
].join(".");

const CREDENTIAL_SAMPLES: readonly (readonly [name: string, text: string, needle: string])[] = [
  ["anthropic key", "here is sk-ant-DUMMY-not-real-000000 ok", "sk-ant-DUMMY-not-real-000000"],
  ["openai key", "use sk-DUMMYnotarealkey0123456789", "sk-DUMMYnotarealkey0123456789"],
  ["aws access key id", "id AKIAIOSFODNN7EXAMPLE end", "AKIAIOSFODNN7EXAMPLE"],
  [
    "aws ini secret",
    "[default]\naws_secret_access_key = wJalrDUMMYnotarealsecret0123456789ab\n",
    "wJalrDUMMYnotarealsecret0123456789ab",
  ],
  [
    "pem private key",
    [
      RSA_PRIVATE_KEY_BEGIN,
      "MIIDUMMYnotarealkeyAAAAAAAAAAAAAAAAAAAAAA",
      RSA_PRIVATE_KEY_END,
    ].join("\n"),
    "MIIDUMMYnotarealkey",
  ],
  [
    "openssh private key",
    `${OPENSSH_PRIVATE_KEY_BEGIN}\nb3BlbnNzDUMMYnotreal\n${OPENSSH_PRIVATE_KEY_END}`,
    "b3BlbnNzDUMMYnotreal",
  ],
  ["github token", "GITHUB_TOKEN=ghp_DUMMYnotarealtoken0123456789", "ghp_DUMMYnotarealtoken0123456789"],
  ["github oauth token", "gho_DUMMYnotarealtoken0123456789", "gho_DUMMYnotarealtoken0123456789"],
  ["github user token", "ghu_DUMMYnotarealtoken0123456789", "ghu_DUMMYnotarealtoken0123456789"],
  ["github server token", "ghs_DUMMYnotarealtoken0123456789", "ghs_DUMMYnotarealtoken0123456789"],
  ["github refresh token", "ghr_DUMMYnotarealtoken0123456789", "ghr_DUMMYnotarealtoken0123456789"],
  [
    "github fine-grained pat",
    "github_pat_DUMMYnotarealtoken0123456789abcdef",
    "github_pat_DUMMYnotarealtoken0123456789abcdef",
  ],
  ["slack bot token", "xoxb-DUMMY-not-real-000000", "xoxb-DUMMY-not-real-000000"],
  ["slack user token", "xoxp-DUMMY-not-real-000000", "xoxp-DUMMY-not-real-000000"],
  ["google api key", "AIzaDUMMYnotarealkey1234567", "AIzaDUMMYnotarealkey1234567"],
  [
    "gcp service account json",
    JSON.stringify({
      type: "service_account",
      private_key: `${PRIVATE_KEY_BEGIN}\nMIIDUMMYnotarealkey\n${PRIVATE_KEY_END}\n`,
    }),
    "MIIDUMMYnotarealkey",
  ],
  [
    "jwt",
    JWT_SAMPLE,
    JWT_SAMPLE,
  ],
  ["bearer token", "Authorization: Bearer DUMMYnotarealbearer0", "DUMMYnotarealbearer0"],
  ["lowercase json key", '{"api_key": "dummy-not-real-value"}', "dummy-not-real-value"],
  ["lowercase password", "password: dummy-not-real-pass", "dummy-not-real-pass"],
  ["uppercase env assignment", "ANTHROPIC_API_KEY=dummy-not-real-value", "dummy-not-real-value"],
  ["yaml secret", "clientSecret: dummy-not-real-value", "dummy-not-real-value"],
];

describe("redactSecrets", () => {
  for (const [name, text, needle] of CREDENTIAL_SAMPLES) {
    it(`redacts a ${name}`, () => {
      const out = redactSecrets(text);
      // Never interpolate the sample into the assertion message.
      expect(out.includes(needle), `${name} survived redaction`).toBe(false);
      expect(out).toContain("[redacted]");
    });
  }

  it("keeps the key and the quoting so redacted JSON stays parseable", () => {
    const out = redactSecrets('{"api_key":"dummy-not-real-value","keep":1}');
    expect(JSON.parse(out)).toEqual({ api_key: "[redacted]", keep: 1 });
  });

  it("leaves ordinary prose alone", () => {
    const prose = "The worker finished the migration and opened a pull request.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("is idempotent", () => {
    for (const [, text] of CREDENTIAL_SAMPLES) {
      const once = redactSecrets(text);
      expect(redactSecrets(once)).toBe(once);
    }
  });

  /**
   * Regression for the PEM rule's old `|[\s\S]*$` tail, which deleted the whole
   * remainder of the text after any MENTION of a header. Prose that names the
   * marker is prose, not a key.
   */
  it("does not delete the rest of a sentence that merely mentions a PEM header", () => {
    const prose = `replace the ${PRIVATE_KEY_BEGIN} header. Then run the deploy script and tell the operator.`;
    const out = redactSecrets(prose);
    expect(out).toBe(
      "replace the [redacted] header. Then run the deploy script and tell the operator.",
    );
    expect(out).toContain("Then run the deploy script");
  });

  it("still redacts a PEM body a truncated stream cut short", () => {
    const cut = `${RSA_PRIVATE_KEY_BEGIN}\nMIIDUMMYnotarealkeyAAAA\nBBBBnotarealkeyCCCC`;
    const out = redactSecrets(cut);
    expect(out.includes("MIIDUMMYnotarealkey"), "a truncated PEM body survived").toBe(false);
    expect(out.includes("BBBBnotarealkeyCCCC"), "a truncated PEM body survived").toBe(false);
  });

  /**
   * Regression for the confirmed corruption: the key-name rule had no word
   * boundaries, so `key`/`token`/`secret` matched as SUBSTRINGS and any field
   * whose name merely contained one lost its value. `PlannedStep.key` is
   * literally named `key`, so every execution plan was mangled.
   */
  const NOT_KEY_NAMES: readonly string[] = [
    '{"monkeys": 12}',
    '{"keyboard": "dvorak"}',
    '{"tokenizer": "bpe"}',
    '{"keywords": ["a","b"]}',
    '{"tokenCount": 1234}',
    '{"turkeys": 3}',
    '{"keeper": "sam"}',
    "monkeys: 12",
    "tokenCount = 1234",
  ];
  for (const sample of NOT_KEY_NAMES) {
    it(`leaves ${sample} alone — it is a word, not a key name`, () => {
      expect(redactSecrets(sample)).toBe(sample);
    });
  }

  const REAL_KEY_NAMES: readonly string[] = [
    '{"key": "dummy-not-real-value"}',
    '{"api_key": "dummy-not-real-value"}',
    '{"apiKey": "dummy-not-real-value"}',
    '{"clientSecret": "dummy-not-real-value"}',
    '{"awsSecretKey": "dummy-not-real-value"}',
    '{"x-api-key": "dummy-not-real-value"}',
    '{"secret_access_key_id": "dummy-not-real-value"}',
    "PASSWORD=dummy-not-real-value",
    "passphrase: dummy-not-real-value",
    "credentials = dummy-not-real-value",
  ];
  for (const sample of REAL_KEY_NAMES) {
    it(`still redacts the value of ${sample}`, () => {
      const out = redactSecrets(sample);
      expect(out.includes("dummy-not-real-value"), "a credential value survived").toBe(false);
      expect(out).toContain("[redacted]");
    });
  }

  it("completes quickly on a large adversarial input (no catastrophic backtracking)", () => {
    // Shapes chosen to stress each rule's prefix: near-miss key names, a long
    // run of base64url characters with no dot, an unterminated PEM header.
    const adversarial = [
      "secret_key_".repeat(20_000),
      "ey".repeat(50_000),
      "a".repeat(200_000),
      PRIVATE_KEY_BEGIN,
      "A".repeat(200_000),
      "xoxb-".repeat(20_000),
    ].join("\n");
    expect(adversarial.length).toBeGreaterThan(500_000);

    const started = performance.now();
    redactSecrets(adversarial);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1_000);
  });

  /**
   * The bounded-tail PEM rule replaced an unbounded one. A text full of headers
   * that are never terminated is the shape that would make a naive lazy scan
   * quadratic, so it gets its own budget.
   */
  it("completes quickly on a text full of unterminated PEM headers", () => {
    const adversarial = [
      `${PRIVATE_KEY_BEGIN} `.repeat(20_000),
      `${OPENSSH_PRIVATE_KEY_BEGIN}\n`.repeat(20_000),
    ].join("\n");
    expect(adversarial.length).toBeGreaterThan(500_000);

    const started = performance.now();
    redactSecrets(adversarial);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("redactDeep", () => {
  it("walks nested structured output", () => {
    const out = redactDeep({
      list: [{ note: "token is ghp_DUMMYnotarealtoken0123456789" }],
      count: 2,
      flag: null,
    });
    expect(JSON.stringify(out)).not.toContain("ghp_DUMMY");
    expect(out).toMatchObject({ count: 2, flag: null });
  });

  it("leaves a structured payload whose field names look credential-ish intact", () => {
    const plan = {
      steps: [
        { key: "step-1", dependsOn: [] as string[], tokenCount: 12 },
        { key: "step-2", dependsOn: ["step-1"], tokenCount: 34 },
      ],
      keywords: ["monkeys", "keyboard"],
    };
    expect(redactDeep(plan)).toEqual(plan);
  });

  it("redacts arbitrary values stored under credential-bearing field names", () => {
    const taskToken = ["ephemeral", "temporal", "value"].join("-");
    const out = redactDeep({
      taskToken,
      nested: {
        authorization: "opaque-value",
        clientSecret: "another-opaque-value",
      },
      tokenCount: 42,
      key: "step-1",
    });
    expect(out).toEqual({
      taskToken: REDACTED,
      nested: {
        authorization: REDACTED,
        clientSecret: REDACTED,
      },
      tokenCount: 42,
      key: "step-1",
    });
    expect(JSON.stringify(out)).not.toContain(taskToken);
  });

  it("does not throw on a reference cycle", () => {
    const node: Record<string, unknown> = { name: "root" };
    node["self"] = node;
    node["children"] = [node];

    const out = redactDeep(node) as Record<string, unknown>;
    expect(out["name"]).toBe("root");
    expect(out["self"]).toBe("[circular]");
    expect((out["children"] as unknown[])[0]).toBe("[circular]");
  });

  it("redacts the same object twice when it is shared but not cyclic", () => {
    const shared = { note: "hello" };
    const out = redactDeep({ a: shared, b: shared }) as Record<string, unknown>;
    expect(out).toEqual({ a: { note: "hello" }, b: { note: "hello" } });
  });

  it("does not blow the stack on a very deep payload", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 5_000; i++) deep = { next: deep };
    expect(() => redactDeep(deep)).not.toThrow();
    expect(JSON.stringify(redactDeep(deep))).toContain("[truncated]");
  });

  /**
   * Regression for a redaction BYPASS: walking a Buffer as an index map turned
   * `Buffer.from(secret)` into `{"0":115,…}`, from which the secret was
   * recoverable byte for byte with `Buffer.from(Object.values(out))`.
   */
  it("never emits a byte container as a recoverable index map", () => {
    const secret = "sk-ant-DUMMY-not-real-000000";
    for (const container of [
      Buffer.from(secret, "utf8"),
      new Uint8Array(Buffer.from(secret, "utf8")),
      new TextEncoder().encode(secret).buffer,
    ]) {
      const out = redactDeep({ blob: container }) as { blob: unknown };
      expect(out.blob).toBe("[redacted]");
      expect(JSON.stringify(out).includes(secret), "a byte container leaked").toBe(false);
      // The whole point: the bytes must not be reconstructible from the output.
      expect(Object.values(out.blob as object).length).toBe(REDACTED.length);
    }
  });

  it("hands back a byte container that holds no credential", () => {
    const bytes = Buffer.from([0, 1, 2, 3, 255]);
    expect((redactDeep({ blob: bytes }) as { blob: unknown }).blob).toEqual(bytes);
  });

  it("keeps Map, Set and Date instead of flattening them to {}", () => {
    const when = new Date("2020-01-02T03:04:05.000Z");
    const out = redactDeep({
      map: new Map<string, unknown>([["a", 1]]),
      set: new Set([1, 2]),
      when,
    }) as { map: Map<string, unknown>; set: Set<number>; when: Date };

    expect(out.map).toBeInstanceOf(Map);
    expect(out.map.get("a")).toBe(1);
    expect(out.set).toBeInstanceOf(Set);
    expect([...out.set]).toEqual([1, 2]);
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.getTime()).toBe(when.getTime());
  });

  it("redacts Map keys and values, and Set members", () => {
    const secret = "ghp_DUMMYnotarealtoken0123456789";
    const out = redactDeep({
      map: new Map([[secret, secret]]),
      set: new Set([secret]),
    });
    const seen = JSON.stringify(out, (_k, v: unknown) =>
      v instanceof Map ? [...v] : v instanceof Set ? [...v] : v,
    );
    expect(seen.includes("ghp_DUMMY"), "a Map/Set leaked a credential").toBe(false);
  });

  it("redacts object KEYS, not only values", () => {
    const secret = "ghp_DUMMYnotarealtoken0123456789";
    const out = redactDeep({ [secret]: "fine" }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual([REDACTED]);
  });

  it("keeps non-enumerable own properties instead of dropping them", () => {
    const value = {};
    Object.defineProperty(value, "hidden", { value: "kept", enumerable: false });
    expect(redactDeep(value)).toEqual({ hidden: "kept" });
  });

  /**
   * `JSON.parse('{"__proto__": …}')` produces a real own `__proto__` property.
   * Copying it with `out[key] = …` runs `Object.prototype`'s setter and moves
   * the accumulator's prototype instead of storing data.
   */
  it("does not let a __proto__ key pollute the accumulator", () => {
    const parsed: unknown = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    const out = redactDeep(parsed) as Record<string, unknown>;

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(out["ok"]).toBe(1);
  });

  it("does not invoke getters while walking", () => {
    let called = 0;
    const value = {
      get boom(): string {
        called += 1;
        throw new Error("a getter must not run during redaction");
      },
      fine: 1,
    };
    expect(redactDeep(value)).toEqual({ fine: 1 });
    expect(called).toBe(0);
  });

  it("redacts an Error it meets, rather than serializing it to {}", () => {
    const out = redactDeep({
      err: new Error("failed with sk-ant-DUMMY-not-real-000000"),
    }) as { err: Error };
    expect(out.err).toBeInstanceOf(Error);
    expect(out.err.message).not.toContain("sk-ant-DUMMY");
  });
});

describe("redactError", () => {
  it("redacts the message and the stack, and drops the cause chain", () => {
    const raw = new Error("spawn failed with ANTHROPIC_API_KEY=sk-ant-DUMMY-not-real-000000", {
      cause: new Error("sk-ant-DUMMY-not-real-000000"),
    });
    raw.name = "SpawnError";
    const safe = redactError(raw);

    expect(safe.name).toBe("SpawnError");
    expect(safe.message).not.toContain("sk-ant-DUMMY");
    expect(safe.stack ?? "").not.toContain("sk-ant-DUMMY");
    expect((safe as { cause?: unknown }).cause).toBeUndefined();
  });

  it("handles a non-Error throw", () => {
    expect(redactError("sk-ant-DUMMY-not-real-000000").message).not.toContain("sk-ant-DUMMY");
  });
});

describe("AgentEventFactory", () => {
  it("redacts every free-text field, so no adapter can forget to", () => {
    const factory = new AgentEventFactory("run-1", () => 0);
    const secret = "sk-ant-DUMMY-not-real-000000";

    const message = factory.make({ type: "message", text: `key ${secret}` });
    const log = factory.make({ type: "log", level: "warn", message: `stderr ${secret}` });
    const question = factory.make({ type: "awaiting-user", question: `is ${secret} right?` });
    const result = factory.make({
      type: "result",
      status: "succeeded",
      text: `done ${secret}`,
      structuredOutput: { note: secret },
    });

    for (const event of [message, log, question, result]) {
      expect(JSON.stringify(event).includes(secret), "event leaked a credential").toBe(false);
    }
    expect(log.level).toBe("warn");
    expect(result.status).toBe("succeeded");
  });

  /**
   * CHOKEPOINT REGRESSION. The adapters deliberately do NOT redact any more —
   * redacting a vendor line before it is parsed destroyed every structured
   * payload — so `make` is the only thing standing between vendor output and
   * the event bus. Narrowing it back to a hand-maintained list of "known text
   * fields" fails open the moment a field is added or turns out to hold an
   * object. Deleting the redaction from `make` must turn this red.
   */
  it("redacts EVERY field it is not explicitly told to pass through", () => {
    const factory = new AgentEventFactory("run-1", () => 0);
    const secret = "ghp_DUMMYnotarealtoken0123456789";

    const event = factory.make({
      type: "result",
      status: "failed",
      // `errorClass` and `text` are vendor-derived; `structuredOutput` nests.
      errorClass: `boom ${secret}`,
      text: `done ${secret}`,
      retryable: true,
      structuredOutput: { deep: [{ note: secret }], map: { [secret]: secret } },
    } as never) as Record<string, unknown>;

    expect(JSON.stringify(event).includes(secret), "an event field leaked").toBe(false);
    // Pass-through fields must still be exactly what the adapter set.
    expect(event["status"]).toBe("failed");
    expect(event["retryable"]).toBe(true);
    expect(event["type"]).toBe("result");
  });

  it("still emits an event when a payload is hostile enough to break the walker", () => {
    const factory = new AgentEventFactory("run-1", () => 0);
    const cyclic: Record<string, unknown> = { note: "hi" };
    cyclic["self"] = cyclic;

    const event = factory.make({
      type: "result",
      status: "succeeded",
      structuredOutput: cyclic,
    });
    expect(event.type).toBe("result");
    expect(event.sequence).toBe(0);
  });

  it("leaves identifiers untouched and keeps sequencing", () => {
    const factory = new AgentEventFactory("run-1", () => 7);
    const session = factory.make({ type: "session", externalSessionId: "s-42" });
    const phase = factory.make({ type: "phase", phase: "tool-result" });

    expect(session).toEqual({
      type: "session",
      externalSessionId: "s-42",
      runId: "run-1",
      sequence: 0,
      timestamp: 7,
    });
    expect(phase.sequence).toBe(1);
  });
});
