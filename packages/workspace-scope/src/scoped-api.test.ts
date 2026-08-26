import { describe, expect, it } from "vitest";
import { createScopedApi, type ScopedCreateTaskCommand } from "./scoped-api.js";
import { deriveWorkspaceScope } from "./scope.js";
import { mintScopeToken, scopeSecretFrom, type ScopeTokenClaims } from "./token.js";

const CLAIMS: ScopeTokenClaims = {
  environmentId: "test-env",
  audience: "control-plane",
  bindingId: "slack:work-grammarxiv",
  bindingEpoch: 1,
  expiresAt: 3_600_000,
};

const VERIFY = { environmentId: "test-env", audience: "control-plane", now: 2_000 } as const;

const secret = scopeSecretFrom("server-side-secret");
const attackerSecret = scopeSecretFrom("model-guessed-secret");

function tokenFor(workspaceId: string, projects: string[], signWith = secret): string {
  const derived = deriveWorkspaceScope(
    {
      channel: "slack",
      accountRef: "personal",
      externalRef: "C1",
      workspaceId,
      projects,
    },
    1_000,
  );
  if (!derived.ok) {
    throw new Error(derived.error.message);
  }
  return mintScopeToken(derived.scope, signWith, CLAIMS);
}

function apiWithSink() {
  const seen: ScopedCreateTaskCommand[] = [];
  const api = createScopedApi<ScopedCreateTaskCommand>({
    secret,
    createTask: (command) => {
      seen.push(command);
      return command;
    },
    verify: VERIFY,
  });
  return { api, seen };
}

const validInput = {
  title: "fix the parser",
  summary: "fix the parser",
  projects: ["grammarxiv"],
  origin: "chat",
  pipeline: "coding",
} as const;

describe("createTask", () => {
  it("takes the workspaceId from the verified token, never from input", () => {
    const { api, seen } = apiWithSink();
    const result = api.createTask(tokenFor("work-grammarxiv", ["grammarxiv"]), { ...validInput });
    expect(result.ok).toBe(true);
    expect(seen[0]?.workspaceId).toBe("work-grammarxiv");
  });

  it("rejects input that carries a workspaceId field at all", () => {
    const { api, seen } = apiWithSink();
    const hostile = { ...validInput, workspaceId: "work-it" } as unknown as typeof validInput;
    const result = api.createTask(tokenFor("work-grammarxiv", ["grammarxiv"]), hostile);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "workspace-id-in-input",
        message: expect.any(String) as unknown as string,
      },
    });
    expect(seen).toHaveLength(0);
  });

  it("rejects an undefined workspaceId field too", () => {
    const { api } = apiWithSink();
    const hostile = { ...validInput, workspaceId: undefined } as unknown as typeof validInput;
    const result = api.createTask(tokenFor("work-grammarxiv", ["grammarxiv"]), hostile);
    expect(result.ok).toBe(false);
  });

  it("rejects a forged token", () => {
    const { api, seen } = apiWithSink();
    const result = api.createTask(tokenFor("work-it", ["product-a"], attackerSecret), {
      ...validInput,
      projects: ["product-a"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-scope-token");
      expect(result.error.tokenRejection).toBe("bad-signature");
    }
    expect(seen).toHaveLength(0);
  });

  it("rejects projects outside the bound scope", () => {
    const { api, seen } = apiWithSink();
    const result = api.createTask(tokenFor("work-grammarxiv", ["grammarxiv"]), {
      ...validInput,
      projects: ["product-a"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("project-out-of-scope");
    }
    expect(seen).toHaveLength(0);
  });

  it("does not leak an expired token into a command", () => {
    const seen: ScopedCreateTaskCommand[] = [];
    const api = createScopedApi<ScopedCreateTaskCommand>({
      secret,
      createTask: (command) => {
        seen.push(command);
        return command;
      },
      verify: { ...VERIFY, now: 100_000, maxAgeMs: 1_000 },
    });
    expect(api.createTask(tokenFor("work-grammarxiv", ["grammarxiv"]), { ...validInput }).ok).toBe(
      false,
    );
    expect(seen).toHaveLength(0);
  });
});
