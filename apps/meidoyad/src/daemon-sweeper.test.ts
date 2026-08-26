import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCheckpointSweeper,
  gatePolicyOutputFor,
  withVerificationStepRecording,
} from "./daemon.js";
import { parseControlPlaneConfig, resolveControlPlaneConfig } from "./config.js";
import { VerificationUnavailableError } from "./ports.js";

/**
 * The daemon's two unguarded survival properties, extracted from `startDaemon`
 * so they can be asserted without a Temporal worker:
 *
 *   * the checkpoint delivery sweep — a loop whose failure mode is silence,
 *     exactly like the notification publisher that once died unnoticed;
 *   * the `runVerification` wrapper, whose failure branch decides whether a
 *     verification that never ran can satisfy the completion gate.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Flushes microtasks plus one macrotask turn — no wall-clock waiting. */
async function settle(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const EMPTY = { scanned: 0, delivered: 0, failed: 0, backlog: 0, awaitingCorroboration: 0 };

describe("checkpoint delivery sweeper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never runs two sweeps at once", async () => {
    let running = 0;
    let overlapped = false;
    const gate = deferred<void>();
    const sweeper = createCheckpointSweeper({
      intervalMs: 1_000,
      log: () => {},
      reconcile: async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await gate.promise;
        running -= 1;
        return EMPTY;
      },
    });

    sweeper.sweep();
    sweeper.sweep();
    sweeper.sweep();
    await settle();
    gate.resolve();
    await sweeper.stop();

    expect(overlapped).toBe(false);
  });

  /**
   * One transient failure must not end the loop. If the sweep's `catch`
   * re-raised, the rejected promise would become the tail every later sweep
   * chains onto, and no checkpoint answer would ever be recovered again for
   * the life of the process — silently.
   */
  it("survives a failing sweep and keeps sweeping", async () => {
    const logged: string[] = [];
    let calls = 0;
    const sweeper = createCheckpointSweeper({
      intervalMs: 1_000,
      log: (message) => logged.push(message),
      reconcile: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporal is unreachable");
        return { scanned: 1, delivered: 1, failed: 0, backlog: 0, awaitingCorroboration: 0 };
      },
    });

    sweeper.sweep();
    await settle();
    expect(calls).toBe(1);
    expect(logged.join("")).toMatch(/sweep failed \(will retry\).*temporal is unreachable/);

    sweeper.sweep();
    await settle();
    expect(calls).toBe(2);
    expect(logged.join("")).toMatch(/1 re-delivered/);
    await sweeper.stop();
  });

  it("does not start a sweep that was queued before stop()", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const sweeper = createCheckpointSweeper({
      intervalMs: 1_000,
      log: () => {},
      reconcile: async () => {
        calls += 1;
        await gate.promise;
        return EMPTY;
      },
    });

    sweeper.sweep(); // starts, then blocks on the gate
    await settle();
    sweeper.sweep(); // queued behind it
    expect(calls).toBe(1);

    const stopping = sweeper.stop();
    gate.resolve();
    await stopping;

    // The queued sweep reached the front of the queue only after stop().
    expect(calls).toBe(1);
  });

  it("waits for the in-flight sweep before stop() resolves", async () => {
    let finished = false;
    const gate = deferred<void>();
    const sweeper = createCheckpointSweeper({
      intervalMs: 1_000,
      log: () => {},
      reconcile: async () => {
        await gate.promise;
        finished = true;
        return EMPTY;
      },
    });

    sweeper.sweep();
    await settle();

    const stopping = sweeper.stop();
    // Resolved on a later macrotask: a `stop()` that does not await the sweep
    // settles in the microtask queue, before this ever runs.
    setTimeout(() => gate.resolve(), 0);
    await stopping;

    expect(finished).toBe(true);
  });

  it("unrefs its timer and clears it on stop, so an idle daemon can exit", async () => {
    const unref = vi.fn();
    const fakeTimer = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(fakeTimer as unknown as NodeJS.Timeout);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    const sweeper = createCheckpointSweeper({
      intervalMs: 4_242,
      log: () => {},
      reconcile: async () => EMPTY,
    });
    sweeper.start();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 4_242);
    expect(unref).toHaveBeenCalledTimes(1);

    await sweeper.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimer);
  });

  it("runs a startup sweep so a previous process's backlog is not left waiting", async () => {
    let calls = 0;
    const sweeper = createCheckpointSweeper({
      intervalMs: 60_000,
      log: () => {},
      reconcile: async () => {
        calls += 1;
        return EMPTY;
      },
    });
    sweeper.start();
    await settle();
    expect(calls).toBe(1);
    await sweeper.stop();
  });
});

/* ----------------------------------------------------- quality gate catalog */

function configYaml(qualityGates: string): string {
  return `schema_version: 1

environment:
  id: test-env
  timezone: UTC
  data_dir: /tmp/meidoya-gate-test

control_plane:
  listen:
    unix_socket: /tmp/meidoya-gate-test/meidoya.sock
  sqlite:
    path: /tmp/meidoya-gate-test/meidoya.sqlite
  temporal:
    address: 127.0.0.1:7233
    namespace: default
    control_task_queue: meidoya/control

workspaces:
  work-it:
    ingress:
      cli:
        profile: work-it
    projects:
      product-a:
        workspace_ref: product-a
${qualityGates}`;
}

function workspaceOf(yaml: string) {
  const resolved = resolveControlPlaneConfig(parseControlPlaneConfig(yaml));
  const workspace = resolved.workspaces[0];
  if (workspace === undefined) throw new Error("no workspace parsed");
  return workspace;
}

/**
 * The node refuses a verification whose catalog is absent or empty, and that
 * refusal is the whole protection for an unconfigured workspace. Substituting
 * the built-in defaults here would run `npm test` from a checkout a `repo.write`
 * worker can edit, in a workspace whose operator configured no gates at all.
 */
describe("quality gate catalog sent to the workflow", () => {
  it("sends nothing for a workspace that configured no quality gates", () => {
    const output = gatePolicyOutputFor(workspaceOf(configYaml("")));
    expect(output.qualityGates).toBeUndefined();
    expect("qualityGates" in output).toBe(false);
  });

  it("sends the operator's catalog verbatim when one is configured", () => {
    const output = gatePolicyOutputFor(
      workspaceOf(
        configYaml(
          "    quality_gates:\n      commands:\n" +
            "        - name: test\n          command: make check\n",
        ),
      ),
    );
    expect(
      (output.qualityGates ?? []).map((gate) => ({ name: gate.name, argv: [...gate.argv] })),
    ).toEqual([
      { name: "test", argv: ["make", "check"] },
    ]);
  });
});

/* ------------------------------------------------ runVerification recording */

type Recorded = { taskId: string; stepKey: string; outcome: "succeeded" | "failed" };

const INPUT = {
  taskId: "task-v",
  workspaceId: "work-it",
  stepKey: "verify",
  plan: { commands: [{ name: "test" }] },
  qualityGates: [{ name: "test", argv: ["npm", "test"] }],
} as unknown as Parameters<ReturnType<typeof withVerificationStepRecording>>[0];

const PASSED = {
  status: "passed" as const,
  groups: [],
  missingArtifacts: [],
  artifacts: [],
  evidence: [],
};

describe("runVerification step recording", () => {
  it("records the step as failed and re-raises when verification never ran", async () => {
    const recorded: Recorded[] = [];
    const activity = withVerificationStepRecording(
      async () => {
        throw new VerificationUnavailableError("no execution node is bound to this workspace");
      },
      (taskId, stepKey, outcome) => {
        recorded.push({ taskId, stepKey, outcome });
      },
      () => {},
    );

    // The error must reach the workflow. Swallowing it — recording `succeeded`
    // and answering `{status:"passed"}` — would let a verification that never
    // executed satisfy both `required-steps-terminal` and
    // `verification-policy-satisfied`, completing a `coding` task unverified.
    await expect(activity(INPUT)).rejects.toThrow(/no execution node/);
    expect(recorded).toEqual([{ taskId: "task-v", stepKey: "verify", outcome: "failed" }]);
  });

  it("announces a control-plane verification refusal instead of failing quietly", async () => {
    const messages: string[] = [];
    const activity = withVerificationStepRecording(
      async () => {
        throw new VerificationUnavailableError("verification reached the control plane");
      },
      () => {},
      (message) => messages.push(message),
    );

    await expect(activity(INPUT)).rejects.toThrow();
    expect(messages.join("")).toMatch(/verification reached the control plane/);
  });

  it("re-raises an ordinary transport error too, and still records the step", async () => {
    const recorded: Recorded[] = [];
    const activity = withVerificationStepRecording(
      async () => {
        throw new Error("ECONNRESET");
      },
      (taskId, stepKey, outcome) => {
        recorded.push({ taskId, stepKey, outcome });
      },
      () => {},
    );

    await expect(activity(INPUT)).rejects.toThrow(/ECONNRESET/);
    expect(recorded).toEqual([{ taskId: "task-v", stepKey: "verify", outcome: "failed" }]);
  });

  it("records a passing verification as succeeded and a failing one as failed", async () => {
    const recorded: Recorded[] = [];
    const record = (taskId: string, stepKey: string, outcome: "succeeded" | "failed"): void => {
      recorded.push({ taskId, stepKey, outcome });
    };

    const passing = withVerificationStepRecording(async () => PASSED, record, () => {});
    await expect(passing(INPUT)).resolves.toMatchObject({ status: "passed" });

    const failing = withVerificationStepRecording(
      async () => ({ ...PASSED, status: "failed" as const }),
      record,
      () => {},
    );
    await expect(failing(INPUT)).resolves.toMatchObject({ status: "failed" });

    expect(recorded.map((r) => r.outcome)).toEqual(["succeeded", "failed"]);
  });
});
