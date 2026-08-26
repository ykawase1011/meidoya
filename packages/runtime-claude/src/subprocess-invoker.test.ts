import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialBoundaryError } from "./credentials.js";
import type { ClaudeInvokerEvent } from "./invoker.js";
import { SubprocessClaudeInvoker } from "./subprocess-invoker.js";

/** A stand-in `claude` binary: no real Claude Code install or network involved. */
function fakeBinary(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "meidoya-claude-"));
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function drain(iterable: AsyncIterable<ClaudeInvokerEvent>): Promise<ClaudeInvokerEvent[]> {
  const out: ClaudeInvokerEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe("SubprocessClaudeInvoker", () => {
  it("streams stream-json lines and reports the exit", async () => {
    const binPath = fakeBinary(
      "echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s-1\"}'",
    );
    const invoker = new SubprocessClaudeInvoker({ binPath, baseEnv: { PATH: process.env["PATH"] ?? "" } });
    const events = await drain(invoker.invoke({ runId: "r1", args: ["-p", "hi"] }));
    expect(events[0]).toMatchObject({ kind: "stdout" });
    expect(events.at(-1)).toMatchObject({ kind: "exit", code: 0, reason: "exit" });
  });

  it("passes prompts on stdin instead of exposing them in argv", async () => {
    const invoker = new SubprocessClaudeInvoker({ binPath: fakeBinary("cat") });
    const events = await drain(
      invoker.invoke({ runId: "stdin", args: ["-p"], stdin: "private task brief" }),
    );
    expect(events[0]).toEqual({ kind: "stdout", line: "private task brief" });
  });

  it("kills on timeout without leaving the child behind", async () => {
    const binPath = fakeBinary("sleep 30");
    const invoker = new SubprocessClaudeInvoker({ binPath, defaultTimeoutMs: 200 });
    const events = await drain(invoker.invoke({ runId: "r2", args: [] }));
    expect(events.at(-1)).toMatchObject({ kind: "exit", reason: "timeout" });
  }, 20_000);

  /**
   * The control for the Codex regression: assert that the node's credential
   * ACTUALLY reaches the child, not merely that some env was computed. The
   * child reports PRESENCE, never the value.
   */
  it("spawns the child with the node's credential and proxy settings", async () => {
    const binPath = fakeBinary(
      'echo "key=${ANTHROPIC_API_KEY:+present} proxy=${HTTPS_PROXY:+present}"',
    );
    const invoker = new SubprocessClaudeInvoker({
      binPath,
      baseEnv: {
        PATH: process.env["PATH"] ?? "",
        ANTHROPIC_API_KEY: "dummy-not-a-real-key",
        HTTPS_PROXY: "http://127.0.0.1:1",
      },
    });
    const events = await drain(invoker.invoke({ runId: "r4", args: [] }));
    expect(events[0]).toEqual({ kind: "stdout", line: "key=present proxy=present" });
  });

  it("refuses an invocation carrying a credential", async () => {
    const invoker = new SubprocessClaudeInvoker({ binPath: fakeBinary("true") });
    await expect(
      drain(invoker.invoke({ runId: "r3", args: [], env: { ANTHROPIC_API_KEY: "sk-x" } })),
    ).rejects.toBeInstanceOf(CredentialBoundaryError);
  });
});
