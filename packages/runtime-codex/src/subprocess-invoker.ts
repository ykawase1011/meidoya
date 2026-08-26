import { nodeLocalEnv, spawnBounded, type BoundedProcessHandle } from "@meidoya/agent-runtime";
import type { CodexInvocation, CodexInvoker, CodexInvokerEvent } from "./invoker.js";

export type SubprocessCodexInvokerOptions = {
  /** Configurable path so no Codex SDK dependency is baked in. */
  readonly binPath?: string;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxOutputBytes?: number;
  /** Node-local base env; defaults to this process's env. */
  readonly baseEnv?: NodeJS.ProcessEnv;
};

export class SubprocessCodexInvoker implements CodexInvoker {
  readonly #binPath: string;
  readonly #options: SubprocessCodexInvokerOptions;
  readonly #running = new Map<string, BoundedProcessHandle>();

  constructor(options: SubprocessCodexInvokerOptions = {}) {
    this.#binPath = options.binPath ?? "codex";
    this.#options = options;
  }

  async *invoke(invocation: CodexInvocation): AsyncIterable<CodexInvokerEvent> {
    const timeoutMs = invocation.timeoutMs ?? this.#options.defaultTimeoutMs;
    const maxOutputBytes = invocation.maxOutputBytes ?? this.#options.defaultMaxOutputBytes;
    // ALWAYS explicit, never conditional. `...(invocation.env === undefined ? {}
    // : { env })` looks like "inherit unless told otherwise" and is not:
    // `spawnBounded` defaults an absent `env` to `minimalEnv()`, so an
    // invocation that named no env — which is every invocation `createRuntimes`
    // builds — spawned the vendor CLI with no OPENAI_API_KEY, no HTTPS_PROXY,
    // no NODE_EXTRA_CA_CERTS and no XDG_CONFIG_HOME. The credentials are FOR
    // this process; it is the one caller that must say so out loud.
    const env = nodeLocalEnv(this.#options.baseEnv ?? process.env, invocation.env ?? {});

    const handle = spawnBounded({
      command: this.#binPath,
      args: invocation.args,
      // Deliberately NOT `killOnOverflow`: passing the stdout byte cap on a
      // long but healthy run only means we stop storing the transcript, and
      // killing the agent for it would be worse than the truncation. The case
      // that DOES kill — a single unbounded line, the one shape that can OOM
      // the node — is unconditional inside `spawnBounded`.
      env,
      ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    });
    this.#running.set(invocation.runId, handle);

    try {
      for await (const line of handle.stdoutLines()) {
        yield { kind: "stdout", line };
      }
      const result = await handle.wait();
      if (result.stderr.length > 0) yield { kind: "stderr", text: result.stderr };
      yield { kind: "exit", code: result.code, reason: result.reason, stderr: result.stderr };
    } finally {
      this.#running.delete(invocation.runId);
      handle.kill("SIGKILL");
    }
  }

  async cancel(runId: string): Promise<void> {
    const handle = this.#running.get(runId);
    if (handle === undefined) return;
    handle.kill();
    await handle.wait();
    this.#running.delete(runId);
  }
}
