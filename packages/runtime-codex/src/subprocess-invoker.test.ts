import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialBoundaryError } from "@meidoya/agent-runtime";
import { SubprocessCodexInvoker } from "./subprocess-invoker.js";
import type { CodexInvokerEvent } from "./invoker.js";

/** A stand-in `codex` binary: no real Codex install or network is involved. */
function fakeBinary(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "meidoya-codex-"));
  const path = join(dir, "codex");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function drain(iterable: AsyncIterable<CodexInvokerEvent>): Promise<CodexInvokerEvent[]> {
  const out: CodexInvokerEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe("SubprocessCodexInvoker", () => {
  it("streams stdout lines and reports the exit", async () => {
    const binPath = fakeBinary('echo \'{"type":"thread.started","thread_id":"t-1"}\'; echo done 1>&2');
    const invoker = new SubprocessCodexInvoker({ binPath });
    const events = await drain(invoker.invoke({ runId: "r1", args: ["exec", "--json"] }));

    expect(events[0]).toEqual({
      kind: "stdout",
      line: '{"type":"thread.started","thread_id":"t-1"}',
    });
    expect(events.at(-1)).toMatchObject({ kind: "exit", code: 0, reason: "exit" });
  });

  it("passes prompts on stdin instead of exposing them in argv", async () => {
    const invoker = new SubprocessCodexInvoker({ binPath: fakeBinary("cat") });
    const events = await drain(
      invoker.invoke({ runId: "stdin", args: ["exec", "-"], stdin: "private task brief" }),
    );
    expect(events[0]).toEqual({ kind: "stdout", line: "private task brief" });
  });

  it("stops a long-running invocation on cancel", async () => {
    const binPath = fakeBinary('echo start; sleep 30');
    const invoker = new SubprocessCodexInvoker({ binPath });
    const iterator = invoker.invoke({ runId: "r2", args: [] })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ kind: "stdout", line: "start" });

    await invoker.cancel("r2");
    const rest: CodexInvokerEvent[] = [];
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
      rest.push(next.value);
    }
    expect(rest.at(-1)).toMatchObject({ kind: "exit", reason: "cancelled" });
  }, 20_000);

  it("kills on timeout", async () => {
    const binPath = fakeBinary("sleep 30");
    const invoker = new SubprocessCodexInvoker({ binPath, defaultTimeoutMs: 200 });
    const events = await drain(invoker.invoke({ runId: "r3", args: [] }));
    expect(events.at(-1)).toMatchObject({ kind: "exit", reason: "timeout" });
  }, 20_000);

  /**
   * The regression the sixth review found, and the reason it went unnoticed:
   * nothing asserted that the vendor CLI is spawned with an environment it can
   * authenticate from. `spawnBounded` defaults an absent `env` to
   * `minimalEnv()`, and this invoker only spread `env` when the invocation
   * carried one — which `createRuntimes` never does — so every Worker step and
   * every Manager review spawned `codex` with PATH/HOME/LANG and nothing else.
   *
   * The child reports PRESENCE, never the value: a failure message must not
   * carry a credential even a dummy one.
   */
  it("spawns the child with the node's credential and proxy settings", async () => {
    const binPath = fakeBinary(
      'echo "key=${OPENAI_API_KEY:+present} proxy=${HTTPS_PROXY:+present}' +
        ' ca=${NODE_EXTRA_CA_CERTS:+present} cfg=${XDG_CONFIG_HOME:+present}"',
    );
    const invoker = new SubprocessCodexInvoker({
      binPath,
      baseEnv: {
        PATH: process.env["PATH"] ?? "",
        OPENAI_API_KEY: "dummy-not-a-real-key",
        HTTPS_PROXY: "http://127.0.0.1:1",
        NODE_EXTRA_CA_CERTS: "/dev/null",
        XDG_CONFIG_HOME: "/dev/null",
      },
    });
    const events = await drain(invoker.invoke({ runId: "r4", args: [] }));
    expect(events[0]).toEqual({
      kind: "stdout",
      line: "key=present proxy=present ca=present cfg=present",
    });
  });

  it("still passes a non-credential overlay on top of the node env", async () => {
    const binPath = fakeBinary('echo "run=${MEIDOYA_RUN_ID} key=${OPENAI_API_KEY:+present}"');
    const invoker = new SubprocessCodexInvoker({
      binPath,
      baseEnv: { PATH: process.env["PATH"] ?? "", OPENAI_API_KEY: "dummy-not-a-real-key" },
    });
    const events = await drain(
      invoker.invoke({ runId: "r5", args: [], env: { MEIDOYA_RUN_ID: "r5" } }),
    );
    expect(events[0]).toEqual({ kind: "stdout", line: "run=r5 key=present" });
  });

  it("refuses an invocation carrying a credential", async () => {
    const invoker = new SubprocessCodexInvoker({ binPath: fakeBinary("true") });
    await expect(
      drain(invoker.invoke({ runId: "r6", args: [], env: { OPENAI_API_KEY: "dummy" } })),
    ).rejects.toBeInstanceOf(CredentialBoundaryError);
  });
});
