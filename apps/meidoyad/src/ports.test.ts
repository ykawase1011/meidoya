import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspacePolicy } from "@meidoya/domain";
import type {
  CheckpointPolicyDecision,
  CheckpointPolicyPort,
  CheckpointPolicyQuery,
  InteractionPolicyPort,
} from "@meidoya/task-engine";
import { migrate, migrations, openDatabase } from "@meidoya/store-sqlite";

import type { BudgetLedgerState } from "@meidoya/execution-budget";
import {
  BUDGET_SNAPSHOT_EVENT,
  BudgetSnapshotUnreadableError,
  createCheckpointPolicyPort,
  createExecutionBudgetPort,
  createInteractionPolicyPort,
  createSqliteBudgetStateStore,
  type BudgetStateStore,
  type WorkspaceGatePolicy,
} from "./ports.js";
import { ControlEventBus } from "./events.js";
import { SerialWriteQueue } from "./write-queue.js";

const policy: WorkspacePolicy = {
  requestPolicy: { quickSoftDeadlineMs: 1000, defaultPipeline: "coding" },
  humanGates: {
    clarification: "when-needed",
    plan: "on-risk",
    review: "on-findings",
    sideEffect: "policy",
  },
  limits: {
    maxSteps: 4,
    maxStepVisits: 5,
    maxFixRounds: 2,
    maxReviewRounds: 2,
    maxNoProgressRounds: 2,
    maxParallelWorkers: 3,
    maxModelEscalations: 2,
    maxConsecutiveFailures: 3,
    maxWallTimeMs: 3_600_000,
  },
  execution: { preferredProfile: "mac-restricted", fallbackProfiles: [] },
};

function gatePolicy(overrides: Partial<WorkspaceGatePolicy> = {}): WorkspaceGatePolicy {
  return { policy, ...overrides };
}

/** The port decides synchronously; a promise here would be a contract change. */
function decide(port: CheckpointPolicyPort, query: CheckpointPolicyQuery): CheckpointPolicyDecision {
  const decision = port.evaluate(query);
  if (decision instanceof Promise) throw new Error("checkpoint policy must decide synchronously");
  return decision;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "meidoyad-ports-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkpoint policy port", () => {
  const port = createCheckpointPolicyPort((id) => (id === "ws" ? gatePolicy() : undefined));

  it("fails closed for a workspace it has no policy for", () => {
    // A missing policy is not permission to skip a human.
    expect(
      decide(port, { taskId: "t", workspaceId: "unknown", kind: "plan-approval" }),
    ).toMatchObject({ required: true });
  });

  it("never treats a limit checkpoint as optional", () => {
    expect(
      decide(port, { taskId: "t", workspaceId: "ws", kind: "limit-exceeded" }),
    ).toMatchObject({ required: true });
  });

  it("fires an on-risk plan gate at medium and high, not at low", () => {
    const at = (risk: "low" | "medium" | "high"): boolean =>
      decide(port, { taskId: "t", workspaceId: "ws", kind: "plan-approval", risk }).required;
    expect(at("low")).toBe(false);
    expect(at("medium")).toBe(true);
    expect(at("high")).toBe(true);
    // An unstated risk is treated as risky.
    expect(decide(port, { taskId: "t", workspaceId: "ws", kind: "plan-approval" }).required).toBe(
      true,
    );
  });

  it("honours a when-needed clarification gate only when it was asked for", () => {
    expect(
      decide(port, { taskId: "t", workspaceId: "ws", kind: "clarification" }).required,
    ).toBe(false);
    expect(
      decide(port, { taskId: "t", workspaceId: "ws", kind: "clarification", requested: true })
        .required,
    ).toBe(true);
  });

  it("uses human-facing Japanese choices without exposing the task id", () => {
    const decision = decide(port, {
      taskId: "task-internal-secret",
      workspaceId: "ws",
      kind: "clarification",
      requested: true,
    });
    expect(decision).toEqual({
      required: true,
      prompt: "作業を続けるため、確認が必要です。",
      choices: [
        { id: "approve", label: "承認" },
        { id: "add-instruction", label: "回答・指示を入力" },
        { id: "cancel", label: "キャンセル" },
      ],
    });
    expect(JSON.stringify(decision)).not.toContain("task-internal-secret");
  });

  it("fires an on-findings review gate only when there are findings", () => {
    const withFindings = (hasFindings: boolean): boolean =>
      decide(port, { taskId: "t", workspaceId: "ws", kind: "review-approval", hasFindings })
        .required;
    expect(withFindings(false)).toBe(false);
    expect(withFindings(true)).toBe(true);
  });

  it("cannot have a mandatory gate relaxed by the workspace policy", () => {
    const relaxed: WorkspacePolicy = {
      ...policy,
      humanGates: { ...policy.humanGates, plan: "never", review: "never" },
    };
    const mandated = createCheckpointPolicyPort(() =>
      gatePolicy({ policy: relaxed, mandatoryGates: { plan: "always", review: "always" } }),
    );
    expect(
      decide(mandated, { taskId: "t", workspaceId: "ws", kind: "plan-approval", risk: "low" })
        .required,
    ).toBe(true);
    expect(
      decide(mandated, {
        taskId: "t",
        workspaceId: "ws",
        kind: "review-approval",
        hasFindings: false,
      }).required,
    ).toBe(true);
  });

  it("stops for a security-mandated side effect even under the `policy` mode", () => {
    expect(
      decide(port, { taskId: "t", workspaceId: "ws", kind: "side-effect-approval" }).required,
    ).toBe(false);
    expect(
      decide(port, {
        taskId: "t",
        workspaceId: "ws",
        kind: "side-effect-approval",
        securityMandated: true,
      }).required,
    ).toBe(true);
  });
});

describe("execution budget port", () => {
  it("denies when there is no ledger to charge", async () => {
    const port = createExecutionBudgetPort({ policyOf: () => undefined });
    // Fail closed: an unknown budget must not be an unlimited one.
    await expect(port.charge({ taskId: "t", kind: "agent-run" })).resolves.toMatchObject({
      allowed: false,
      limit: "max_steps",
    });
  });

  it("charges a child task to its root, so children cannot mint budget", async () => {
    const parents: Record<string, string> = { child: "root", grandchild: "child" };
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      rootOf: (taskId) => {
        let current = taskId;
        while (parents[current] !== undefined) current = parents[current]!;
        return current;
      },
    });

    for (const taskId of ["root", "child", "grandchild", "child"]) {
      await expect(port.charge({ taskId, kind: "agent-run" })).resolves.toMatchObject({
        allowed: true,
      });
    }
    // max_steps is 4: the fifth charge is refused no matter who asks.
    await expect(port.charge({ taskId: "grandchild", kind: "agent-run" })).resolves.toMatchObject({
      allowed: false,
      limit: "max_steps",
    });
    expect(await port.snapshot("child")).toEqual({ stepsUsed: 4 });
  });

  it("stops a fix loop at max_fix_rounds", async () => {
    const port = createExecutionBudgetPort({ policyOf: () => policy });
    await expect(port.charge({ taskId: "t", kind: "fix-round" })).resolves.toMatchObject({
      allowed: true,
    });
    await expect(port.charge({ taskId: "t", kind: "fix-round" })).resolves.toMatchObject({
      allowed: true,
    });
    await expect(port.charge({ taskId: "t", kind: "fix-round" })).resolves.toMatchObject({
      allowed: false,
      limit: "max_fix_rounds",
    });
  });

  it("extends a budget exactly once", async () => {
    const port = createExecutionBudgetPort({ policyOf: () => policy });
    expect(await port.extendOnce("t")).toMatchObject({ ok: true });
    expect(await port.extendOnce("t")).toEqual({ ok: false, reason: "already-extended" });
  });

  it("resumes the spent total after a restart", async () => {
    const file = path.join(dir, "budget.sqlite");
    const db = openDatabase(file);
    migrate(db, migrations);
    db.prepare("INSERT INTO environments VALUES (?,?,?,?)").run("env", "UTC", 0, 0);
    db.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?,?)").run(
      "ws",
      "env",
      "execution",
      "ws",
      "active",
      "{}",
      0,
      0,
      0,
    );
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, origin, pipeline, title, intent_json, status,
                          temporal_workflow_id, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("root", "ws", "cli", "coding", "t", "{}", "planning", "task/root", 0, 0, 0);

    const append = (args: {
      taskId: string;
      eventType: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }): void => {
      db.prepare(
        `INSERT OR IGNORE INTO task_events
           (id, task_id, event_type, idempotency_key, payload_json, created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(
        args.idempotencyKey,
        args.taskId,
        args.eventType,
        args.idempotencyKey,
        JSON.stringify(args.payload),
        0,
      );
    };

    const first = createExecutionBudgetPort({
      policyOf: () => policy,
      store: createSqliteBudgetStateStore(db, append),
    });
    await first.charge({ taskId: "root", kind: "agent-run" });
    await first.charge({ taskId: "root", kind: "agent-run" });
    expect(await first.snapshot("root")).toEqual({ stepsUsed: 2 });

    // A brand new process reading the same database: the budget is not reset.
    const restarted = createExecutionBudgetPort({
      policyOf: () => policy,
      store: createSqliteBudgetStateStore(db, append),
    });
    expect(await restarted.snapshot("root")).toEqual({ stepsUsed: 2 });
    await restarted.charge({ taskId: "root", kind: "agent-run" });
    await restarted.charge({ taskId: "root", kind: "agent-run" });
    await expect(restarted.charge({ taskId: "root", kind: "agent-run" })).resolves.toMatchObject({
      allowed: false,
      limit: "max_steps",
    });
    db.close();
  });
});

/* ------------------------------------------------- resident ledger eviction */

/**
 * `ledgers` kept one `BudgetLedger` per root task for the daemon's lifetime: an
 * unbounded map on a process that runs for weeks. Bounding it is only safe
 * because every mutating path writes through to the store BEFORE it answers, so
 * an evicted ledger is rebuilt from the persisted snapshot with the spent total
 * intact. Get that wrong and eviction silently mints a fresh budget — the exact
 * failure 06 sections 4-5 make `max_steps` a ROOT budget to prevent.
 */
describe("resident budget ledgers are bounded", () => {
  /** An in-memory store that counts how often a root had to be re-read. */
  function countingStore(): {
    store: BudgetStateStore;
    loads: Map<string, number>;
    rows: Map<string, BudgetLedgerState>;
  } {
    const rows = new Map<string, BudgetLedgerState>();
    const loads = new Map<string, number>();
    return {
      rows,
      loads,
      store: {
        load(rootTaskId) {
          loads.set(rootTaskId, (loads.get(rootTaskId) ?? 0) + 1);
          return rows.get(rootTaskId);
        },
        save(rootTaskId, state) {
          rows.set(rootTaskId, state);
        },
      },
    };
  }

  it("evicts the coldest ledger and rebuilds it with the spent total intact", async () => {
    const { store, loads } = countingStore();
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store,
      maxResidentLedgers: 1,
    });

    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await port.charge({ taskId: "root-a", kind: "agent-run" });
    // Charging a second root evicts `root-a`: only one may stay resident.
    await port.charge({ taskId: "root-b", kind: "agent-run" });

    // The proof that it really was evicted: it has to be loaded again.
    expect(loads.get("root-a")).toBe(1);
    expect(await port.snapshot("root-a")).toEqual({ stepsUsed: 2 });
    expect(loads.get("root-a")).toBe(2);

    // And the restored ledger is the SAME budget, not a fresh one: max_steps is
    // 4, so only two charges are left.
    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await expect(port.charge({ taskId: "root-a", kind: "agent-run" })).resolves.toMatchObject({
      allowed: false,
      limit: "max_steps",
    });
  });

  it("keeps a one-time extension across an eviction", async () => {
    const { store } = countingStore();
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store,
      maxResidentLedgers: 1,
    });

    expect(await port.extendOnce("root-a")).toMatchObject({ ok: true });
    await port.charge({ taskId: "root-b", kind: "agent-run" }); // evicts root-a
    // A refilled ledger would grant the extension a second time.
    expect(await port.extendOnce("root-a")).toEqual({ ok: false, reason: "already-extended" });
  });

  it("holds the map at the bound however many roots it has ever seen", async () => {
    const { store, loads } = countingStore();
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store,
      maxResidentLedgers: 2,
    });

    for (let i = 0; i < 50; i += 1) {
      await port.charge({ taskId: `root-${i}`, kind: "agent-run" });
    }
    // Every root was loaded exactly once, so nothing was resident that should
    // have been evicted; and the two most recent are still hot.
    for (let i = 0; i < 50; i += 1) {
      expect(loads.get(`root-${i}`)).toBe(1);
    }
    expect(await port.snapshot("root-49")).toEqual({ stepsUsed: 1 });
    expect(loads.get("root-49")).toBe(1);
    // The coldest one is gone and must be re-read.
    expect(await port.snapshot("root-0")).toEqual({ stepsUsed: 1 });
    expect(loads.get("root-0")).toBe(2);
  });

  /**
   * Eviction is safe but not free — a reload is a database read on the write
   * connection. The victim must therefore be the LEAST RECENTLY USED root, not
   * merely the oldest one, or a long-running task that is charged constantly
   * gets evicted by a burst of short ones it is still competing with.
   */
  it("evicts the least recently USED root, not the first one inserted", async () => {
    const { store, loads } = countingStore();
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store,
      maxResidentLedgers: 2,
    });

    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await port.charge({ taskId: "root-b", kind: "agent-run" });
    // `root-a` is used again, so `root-b` becomes the coldest.
    expect(await port.snapshot("root-a")).toEqual({ stepsUsed: 1 });
    await port.charge({ taskId: "root-c", kind: "agent-run" });

    // `root-a` is still resident: no second load.
    expect(await port.snapshot("root-a")).toEqual({ stepsUsed: 1 });
    expect(loads.get("root-a")).toBe(1);
    // `root-b` was the victim.
    expect(await port.snapshot("root-b")).toEqual({ stepsUsed: 1 });
    expect(loads.get("root-b")).toBe(2);
  });

  /**
   * With no store there is nowhere for the spent total to live, so evicting
   * would hand the root a full budget again. A storeless port must therefore
   * NOT evict, whatever bound it is given.
   */
  it("never evicts when there is no store to restore from", async () => {
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      maxResidentLedgers: 1,
    });

    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await port.charge({ taskId: "root-b", kind: "agent-run" });

    expect(await port.snapshot("root-a")).toEqual({ stepsUsed: 2 });
  });

  /**
   * The window the write-through argument does not cover. `charge` mutates the
   * resident ledger SYNCHRONOUSLY and only then suspends on `store.save`, so
   * for the duration of that await the snapshot is one charge behind memory.
   * Evict in that window and the next charge for the same root reloads the
   * PRE-charge snapshot: two charges, one recorded — budget minted.
   *
   * Concurrency on one root is the normal case (06 section 5 charges the ROOT
   * for child tasks and subworkflows, and `db.chargeBudget` is a Temporal
   * activity served concurrently), so this is a real refill, not a curiosity.
   * Deterministic: the first `save` is held open explicitly and released by
   * hand — no timers, no sleeps.
   */
  it("does not lose a charge when eviction races an in-flight persist", async () => {
    const rows = new Map<string, BudgetLedgerState>();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdNext = true;
    const store: BudgetStateStore = {
      load: (rootTaskId) => rows.get(rootTaskId),
      save: async (rootTaskId, state) => {
        if (holdNext) {
          holdNext = false;
          await held;
        }
        rows.set(rootTaskId, state);
      },
    };
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store,
      maxResidentLedgers: 1,
    });

    // Suspended inside `save`, ledger already mutated, snapshot still empty.
    const first = port.charge({ taskId: "root-a", kind: "agent-run" });
    // A second root would evict `root-a` — and used to.
    await port.charge({ taskId: "root-b", kind: "agent-run" });
    // A SECOND charge on the same root, still inside the first one's persist:
    // if the eviction landed, this reloads the pre-charge snapshot and reports
    // `stepsUsed: 1` for what is the second step. Two charges, one recorded.
    const second = port.charge({ taskId: "root-a", kind: "agent-run" });
    release();

    await expect(first).resolves.toMatchObject({ allowed: true, stepsUsed: 1 });
    await expect(second).resolves.toMatchObject({ allowed: true, stepsUsed: 2 });
    // `max_steps` is 4, so the two remaining charges are the LAST two: the
    // in-flight step was really spent, not merely reported.
    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await expect(port.charge({ taskId: "root-a", kind: "agent-run" })).resolves.toMatchObject({
      allowed: false,
      limit: "max_steps",
    });
  });

  /**
   * Same window, no concurrency needed: a `save` that THROWS leaves the charge
   * in memory and nowhere else.
   *
   * This test used to assert that the charge STAYED (`stepsUsed: 2` on the next
   * charge) and that the root was pinned resident until some later persist
   * succeeded. Both halves were wrong, and together they were defects #4 and
   * #5. `db.chargeBudget` is a RETRYABLE activity: an unacknowledged charge
   * comes straight back, so keeping the mutation charged the same logical step
   * twice. And the pin was cleared only by a later successful persist for the
   * same root, which for a finished task never comes — one blip pinned a root
   * for the life of the process, a store outage pinned every root, and with
   * nothing evictable the eviction pass then had only the entry it had just
   * inserted left to take (#3).
   *
   * The charge is now ROLLED BACK instead: the failure is still propagated, and
   * the retry pays for the step exactly once.
   */
  it("rolls a charge back when its persist fails, so the retry cannot pay twice", async () => {
    const rows = new Map<string, BudgetLedgerState>();
    let failNext = true;
    const store: BudgetStateStore = {
      load: (rootTaskId) => rows.get(rootTaskId),
      save: (rootTaskId, state) => {
        if (failNext) {
          failNext = false;
          throw new Error("disk full");
        }
        rows.set(rootTaskId, state);
      },
    };
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store,
      maxResidentLedgers: 1,
    });

    await expect(port.charge({ taskId: "root-a", kind: "agent-run" })).rejects.toThrow("disk full");
    // Nothing was persisted and nothing is counted: memory matches the store.
    expect(await port.snapshot("root-a")).toEqual({ stepsUsed: 0 });

    // The retry the activity's retry policy issues. One logical step, one charge.
    await expect(port.charge({ taskId: "root-a", kind: "agent-run" })).resolves.toMatchObject({
      allowed: true,
      stepsUsed: 1,
    });
    // And the whole budget is still there: max_steps is 4, so three more.
    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await expect(port.charge({ taskId: "root-a", kind: "agent-run" })).resolves.toMatchObject({
      allowed: false,
      limit: "max_steps",
    });
  });

  /**
   * The other half of the rollback: a root whose persist failed must not be
   * pinned resident forever. Rolling the mutation back is what earns that —
   * memory is no longer ahead of the store, so the entry is an ordinary cache
   * entry again and the next eviction may take it.
   *
   * `unpersisted` used to hold it instead, and was cleared only by a later
   * SUCCESSFUL persist for the same root. A finished task never persists again,
   * so one transient failure leaked a resident ledger permanently and a store
   * outage leaked every root at once — 2000 roots stayed resident under
   * `maxResidentLedgers: 2`.
   */
  it("does not pin a root whose persist failed, however many of them fail", async () => {
    const rows = new Map<string, BudgetLedgerState>();
    const loads = new Map<string, number>();
    const store: BudgetStateStore = {
      load: (rootTaskId) => {
        loads.set(rootTaskId, (loads.get(rootTaskId) ?? 0) + 1);
        return rows.get(rootTaskId);
      },
      save: (rootTaskId, state) => {
        // A store outage: every write fails, for every root.
        if (rootTaskId.startsWith("blip-")) throw new Error("store is down");
        rows.set(rootTaskId, state);
      },
    };
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store,
      maxResidentLedgers: 2,
    });

    for (let i = 0; i < 200; i += 1) {
      await expect(port.charge({ taskId: `blip-${i}`, kind: "agent-run" })).rejects.toThrow(
        "store is down",
      );
    }
    // If failed roots were pinned, none of these would ever be evicted and each
    // would still be resident — one load apiece. They were evicted, so every
    // one of them has to be read again.
    for (let i = 0; i < 200; i += 1) {
      expect(await port.snapshot(`blip-${i}`)).toEqual({ stepsUsed: 0 });
      expect(loads.get(`blip-${i}`)).toBe(2);
    }
  });

  /**
   * The pin's OWN signal. `persist` unpins in a `finally`, and while a failed
   * persist also left the root retained by `unpersisted` that `finally` could
   * be mutated to unpin on success only and nothing went red. With the two
   * mechanisms folded into one, a leaked pin is directly observable: the root
   * would never be evicted again.
   */
  it("releases the pin when a persist fails, not only when it succeeds", async () => {
    const rows = new Map<string, BudgetLedgerState>();
    const loads = new Map<string, number>();
    let failNext = true;
    const store: BudgetStateStore = {
      load: (rootTaskId) => {
        loads.set(rootTaskId, (loads.get(rootTaskId) ?? 0) + 1);
        return rows.get(rootTaskId);
      },
      save: (rootTaskId, state) => {
        if (failNext) {
          failNext = false;
          throw new Error("disk full");
        }
        rows.set(rootTaskId, state);
      },
    };
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store,
      maxResidentLedgers: 1,
    });

    await expect(port.charge({ taskId: "root-a", kind: "agent-run" })).rejects.toThrow("disk full");
    // A second root must be able to take `root-a`'s place; a leaked pin would
    // keep `root-a` resident and the map above its bound forever.
    await port.charge({ taskId: "root-b", kind: "agent-run" });
    expect(await port.snapshot("root-a")).toEqual({ stepsUsed: 0 });
    expect(loads.get("root-a")).toBe(2);
  });

  /**
   * Defect #3: the eviction pass ran as a side effect of INSERTING the entry it
   * was about to hand out.
   *
   * A `Map` iterates in insertion order, so the key just (re-)inserted is the
   * LAST candidate the pass considers — and when every colder key is retained
   * (a persist in flight) it is the only one left to take. `ledgerFor` then
   * returned a ledger that was no longer in the map, so the next charge for the
   * same root reloaded the snapshot and started again from it.
   *
   * The signal is residency: charging `root-a` while a colder root is pinned
   * must not make `root-a` reload itself afterwards.
   */
  it("never evicts the entry it is about to hand out, however cold the rest are", async () => {
    const rows = new Map<string, BudgetLedgerState>();
    const loads = new Map<string, number>();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let holdNext = true;
    const store: BudgetStateStore = {
      load: (rootTaskId) => {
        loads.set(rootTaskId, (loads.get(rootTaskId) ?? 0) + 1);
        return rows.get(rootTaskId);
      },
      save: async (rootTaskId, state) => {
        if (holdNext) {
          holdNext = false;
          entered();
          await held;
        }
        rows.set(rootTaskId, state);
      },
    };
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store,
      maxResidentLedgers: 1,
    });

    // `root-x` is pinned: its persist is suspended, so it may not be evicted.
    const pinned = port.charge({ taskId: "root-x", kind: "agent-run" });
    await inFlight;

    // The only bound-restoring victim available is `root-a` itself.
    await expect(port.charge({ taskId: "root-a", kind: "agent-run" })).resolves.toMatchObject({
      allowed: true,
      stepsUsed: 1,
    });
    expect(loads.get("root-a")).toBe(1);
    // It was handed out, so it stays: a second load here is the eviction that
    // must not have happened.
    expect(await port.snapshot("root-a")).toEqual({ stepsUsed: 1 });
    expect(loads.get("root-a")).toBe(1);

    release();
    await expect(pinned).resolves.toMatchObject({ allowed: true, stepsUsed: 1 });
  });

  /**
   * The same defect, priced in budget rather than in loads, against real SQLite
   * and the production DEFERRED write path (`SerialWriteQueue`, which is how
   * `createDaemon` wires `appendTaskEvent`).
   *
   * The deferral is the whole point: with a synchronous insert the reload after
   * a self-eviction happens to read the row the first charge just wrote, and
   * the arithmetic comes out right by accident. Defer the write — as production
   * does — and the second charge reads a snapshot that has not landed yet, both
   * charges report `stepsUsed: 1`, one row survives, and a step is minted.
   *
   * Deterministic: the queue is blocked by hand and released by hand, and both
   * charges are issued before the release. No timers, no sleeps.
   */
  it("does not mint a step when two charges race a deferred write", async () => {
    const db = openDatabase(path.join(dir, "deferred.sqlite"));
    migrate(db, migrations);
    db.prepare("INSERT INTO environments VALUES (?,?,?,?)").run("env", "UTC", 0, 0);
    db.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?,?)").run(
      "ws",
      "env",
      "execution",
      "ws",
      "active",
      "{}",
      0,
      0,
      0,
    );
    for (const id of ["root-a", "root-x"]) {
      db.prepare(
        `INSERT INTO tasks (id, workspace_id, origin, pipeline, title, intent_json, status,
                            temporal_workflow_id, version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, "ws", "cli", "coding", id, "{}", "planning", `task/${id}`, 0, 0, 0);
    }

    const queue = new SerialWriteQueue();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let holdNext = true;
    // Exactly the daemon's wiring: every append goes through the serial write
    // queue, so `save` resolves only once the row is really in the database.
    const append = (args: {
      taskId: string;
      eventType: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }): Promise<void> =>
      queue.enqueue(async () => {
        if (holdNext) {
          holdNext = false;
          entered();
          await held;
        }
        db.prepare(
          `INSERT OR IGNORE INTO task_events
             (id, task_id, event_type, idempotency_key, payload_json, created_at)
           VALUES (?,?,?,?,?,?)`,
        ).run(
          args.idempotencyKey,
          args.taskId,
          args.eventType,
          args.idempotencyKey,
          JSON.stringify(args.payload),
          0,
        );
      });

    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store: createSqliteBudgetStateStore(db, append),
      maxResidentLedgers: 1,
    });

    // `root-x` holds the write queue open, and is pinned while it does.
    const pinned = port.charge({ taskId: "root-x", kind: "agent-run" });
    await blocked;

    // Two charges on one root — 06 section 5 has children and subworkflows
    // charge the ROOT, and `db.chargeBudget` is served concurrently — issued
    // while `root-a` is the only evictable entry in the map.
    const first = port.charge({ taskId: "root-a", kind: "agent-run" });
    const second = port.charge({ taskId: "root-a", kind: "agent-run" });
    release();

    await expect(first).resolves.toMatchObject({ allowed: true, stepsUsed: 1 });
    // The step the self-eviction used to swallow.
    await expect(second).resolves.toMatchObject({ allowed: true, stepsUsed: 2 });
    await expect(pinned).resolves.toMatchObject({ allowed: true, stepsUsed: 1 });
    await queue.drain();

    // And the database agrees, so a restart cannot recover the minted step:
    // both charges are in the newest snapshot.
    const restarted = createExecutionBudgetPort({
      policyOf: () => policy,
      store: createSqliteBudgetStateStore(db, append),
    });
    expect(await restarted.snapshot("root-a")).toEqual({ stepsUsed: 2 });
    db.close();
  });

  /**
   * The ordering guarantee, made explicit instead of incidental.
   *
   * The port hands `store.save` a `snapshot()` taken at charge time. Nothing in
   * that contract says a store applies two saves for one root in the order it
   * received them, and the port used to have no version, no compare-and-swap
   * and no serialization: safety rested entirely on
   * `createSqliteBudgetStateStore` assigning its sequence number synchronously
   * and on the repository's queue being FIFO. A store that ordered
   * asynchronously would have clobbered a newer snapshot with an older one, and
   * the port would have been the last place anyone looked.
   *
   * So the port now serializes a root's mutations end to end: snapshot N+1 is
   * not even HANDED to the store until snapshot N has been acknowledged. This
   * test watches for the overlap directly.
   */
  it("never hands a root's snapshot to the store while an earlier one is in flight", async () => {
    const rows = new Map<string, BudgetLedgerState>();
    const inFlight = new Set<string>();
    const overlapped: string[] = [];
    const seen: number[] = [];
    const store: BudgetStateStore = {
      load: (rootTaskId) => rows.get(rootTaskId),
      save: async (rootTaskId, state) => {
        if (inFlight.has(rootTaskId)) overlapped.push(rootTaskId);
        inFlight.add(rootTaskId);
        seen.push(state.stepsUsed);
        // The suspension every real store has between accepting a write and
        // acknowledging it.
        await Promise.resolve();
        inFlight.delete(rootTaskId);
        rows.set(rootTaskId, state);
      },
    };
    const port = createExecutionBudgetPort({ policyOf: () => policy, store });

    const charges = [
      port.charge({ taskId: "root-a", kind: "agent-run" }),
      port.charge({ taskId: "root-a", kind: "agent-run" }),
      port.charge({ taskId: "root-a", kind: "agent-run" }),
    ];
    await Promise.all(charges);

    expect(overlapped).toEqual([]);
    // And they arrived in charge order, which is what makes "newest write wins"
    // mean "newest state wins".
    expect(seen).toEqual([1, 2, 3]);
    expect(rows.get("root-a")?.stepsUsed).toBe(3);
  });

  /**
   * The property the serialization above must NOT have broken: check-and-charge
   * is atomic, so a budget cannot be overspent by charging it concurrently.
   * `max_steps` is 4 and twelve charges are issued at once; exactly four may be
   * allowed, and the store must agree with the answers given.
   */
  it("allows exactly max_steps charges however many arrive at once", async () => {
    const rows = new Map<string, BudgetLedgerState>();
    const store: BudgetStateStore = {
      load: (rootTaskId) => rows.get(rootTaskId),
      save: async (rootTaskId, state) => {
        await Promise.resolve();
        rows.set(rootTaskId, state);
      },
    };
    const port = createExecutionBudgetPort({ policyOf: () => policy, store });

    const decisions = await Promise.all(
      Array.from({ length: 12 }, (_unused, i) =>
        port.charge({ taskId: "root-a", stepKey: `step-${i}`, kind: "agent-run" }),
      ),
    );

    expect(decisions.filter((d) => d.allowed).length).toBe(4);
    expect(decisions.filter((d) => !d.allowed).every((d) => d.limit === "max_steps")).toBe(true);
    expect(rows.get("root-a")?.stepsUsed).toBe(4);
    expect(await port.snapshot("root-a")).toEqual({ stepsUsed: 4 });
  });

  it("survives eviction across the real SQLite-backed store", async () => {
    const db = openDatabase(path.join(dir, "evict.sqlite"));
    migrate(db, migrations);
    db.prepare("INSERT INTO environments VALUES (?,?,?,?)").run("env", "UTC", 0, 0);
    db.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?,?)").run(
      "ws",
      "env",
      "execution",
      "ws",
      "active",
      "{}",
      0,
      0,
      0,
    );
    for (const id of ["root-a", "root-b"]) {
      db.prepare(
        `INSERT INTO tasks (id, workspace_id, origin, pipeline, title, intent_json, status,
                            temporal_workflow_id, version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, "ws", "cli", "coding", id, "{}", "planning", `task/${id}`, 0, 0, 0);
    }
    const append = (args: {
      taskId: string;
      eventType: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }): void => {
      db.prepare(
        `INSERT OR IGNORE INTO task_events
           (id, task_id, event_type, idempotency_key, payload_json, created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(
        args.idempotencyKey,
        args.taskId,
        args.eventType,
        args.idempotencyKey,
        JSON.stringify(args.payload),
        0,
      );
    };

    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store: createSqliteBudgetStateStore(db, append),
      maxResidentLedgers: 1,
    });

    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await port.charge({ taskId: "root-a", kind: "agent-run" });
    await port.charge({ taskId: "root-b", kind: "agent-run" }); // evicts root-a
    await port.charge({ taskId: "root-a", kind: "agent-run" }); // evicts root-b, reloads root-a

    expect(await port.snapshot("root-a")).toEqual({ stepsUsed: 3 });
    expect(await port.snapshot("root-b")).toEqual({ stepsUsed: 1 });
    db.close();
  });
});

/* ---------------------------------------- the store's own unbounded cache */

/**
 * The resident ledgers were not the only per-root map that grew forever: the
 * SQLite store keeps the last sequence number it wrote for each root, and that
 * map had no bound either. Forgetting an entry has to cost nothing but a read —
 * `save` falls back to the newest row in the table — so the cap is safe, but
 * only if the fallback really is exercised and really is right.
 */
describe("the store's per-root sequence cache is bounded", () => {
  const state: BudgetLedgerState = {
    rootTaskId: "root",
    startedAt: 0,
    stepsUsed: 1,
    stepVisits: {},
    fixRounds: 0,
    reviewRounds: 0,
    consecutiveFailures: 0,
    modelEscalations: 0,
    extensionsUsed: 0,
    extraSteps: 0,
    noProgress: { repeatCount: 0 },
  };

  it("forgets the coldest root and recovers its sequence from the table", async () => {
    const newest = new Map<string, string>();
    const reads = new Map<string, number>();
    const db = {
      prepare: () => ({
        get: (...params: unknown[]): unknown => {
          const taskId = params[0] as string;
          reads.set(taskId, (reads.get(taskId) ?? 0) + 1);
          const payload = newest.get(taskId);
          return payload === undefined ? undefined : { payload_json: payload };
        },
      }),
    };
    const store = createSqliteBudgetStateStore(db, (args) => {
      newest.set(args.taskId, JSON.stringify(args.payload));
    });

    // More roots than the cache can hold.
    for (let i = 0; i < 1100; i += 1) await store.save(`root-${i}`, state);

    // A hot root's sequence is still remembered: its first save read the table
    // once and nothing has had to read it again.
    await store.save("root-1099", state);
    expect(reads.get("root-1099")).toBe(1);

    // The coldest one was dropped, so its next save re-reads...
    await store.save("root-0", state);
    expect(reads.get("root-0")).toBe(2);
    // ...and gets the same answer the cache would have given: sequence 2, not a
    // second sequence 1 that `INSERT OR IGNORE` would have silently dropped.
    expect(JSON.parse(newest.get("root-0") ?? "{}")).toMatchObject({ seq: 2 });
  });
});

/* ------------------------------------------- corrupt budget snapshots (#20) */

/**
 * A persisted snapshot that EXISTS but cannot be read is not an empty budget.
 *
 * `ledgers` is in-memory only, so the store is the sole memory of what a root
 * task has spent. When `load` answered `undefined` for a snapshot it merely
 * failed to decode, every control-plane restart handed the task a full budget
 * again: `chargeBudget` re-charged from zero, `limit-exceeded` never fired, and
 * nothing was logged. A schema change renaming `state` was enough to trigger it
 * on perfectly valid JSON.
 */
describe("a budget snapshot that cannot be read fails closed", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meidoya-budget-corrupt-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seeded(): {
    db: ReturnType<typeof openDatabase>;
    append: (args: {
      taskId: string;
      eventType: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }) => void;
  } {
    const db = openDatabase(path.join(dir, "budget.sqlite"));
    migrate(db, migrations);
    db.prepare("INSERT INTO environments VALUES (?,?,?,?)").run("env", "UTC", 0, 0);
    db.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?,?)").run(
      "ws",
      "env",
      "execution",
      "ws",
      "active",
      "{}",
      0,
      0,
      0,
    );
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, origin, pipeline, title, intent_json, status,
                          temporal_workflow_id, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("root", "ws", "cli", "coding", "t", "{}", "planning", "task/root", 0, 0, 0);
    const append = (args: {
      taskId: string;
      eventType: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }): void => {
      db.prepare(
        `INSERT OR REPLACE INTO task_events
           (id, task_id, event_type, idempotency_key, payload_json, created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(
        args.idempotencyKey,
        args.taskId,
        args.eventType,
        args.idempotencyKey,
        JSON.stringify(args.payload),
        0,
      );
    };
    return { db, append };
  }

  /** Overwrites the newest snapshot payload with something unreadable. */
  function corruptSnapshot(db: ReturnType<typeof openDatabase>, payload: string): void {
    db.prepare(
      `UPDATE task_events SET payload_json = ?
        WHERE event_type = ? AND task_id = 'root'`,
    ).run(payload, BUDGET_SNAPSHOT_EVENT);
  }

  it("refuses to resume a root whose snapshot payload is not JSON", async () => {
    const { db, append } = seeded();
    const store = createSqliteBudgetStateStore(db, append);
    const first = createExecutionBudgetPort({ policyOf: () => policy, store });
    await first.charge({ taskId: "root", kind: "agent-run" });
    await first.charge({ taskId: "root", kind: "agent-run" });

    corruptSnapshot(db, "{not json");

    // A brand new process — the in-memory ledger is gone, so the store is the
    // only memory of the two steps already spent.
    const restarted = createExecutionBudgetPort({
      policyOf: () => policy,
      store: createSqliteBudgetStateStore(db, append),
    });
    await expect(restarted.charge({ taskId: "root", kind: "agent-run" })).rejects.toThrow(
      /unreadable/,
    );
    db.close();
  });

  it("refuses to resume a root whose snapshot carries no `state` (valid JSON)", async () => {
    const { db, append } = seeded();
    const store = createSqliteBudgetStateStore(db, append);
    const first = createExecutionBudgetPort({ policyOf: () => policy, store });
    await first.charge({ taskId: "root", kind: "agent-run" });
    await first.charge({ taskId: "root", kind: "agent-run" });

    // Exactly what a field rename would produce: well-formed JSON the reader
    // does not understand.
    corruptSnapshot(db, JSON.stringify({ seq: 2, ledgerState: { stepsUsed: 2 } }));

    const restarted = createExecutionBudgetPort({
      policyOf: () => policy,
      store: createSqliteBudgetStateStore(db, append),
    });
    await expect(restarted.charge({ taskId: "root", kind: "agent-run" })).rejects.toThrow(
      /unreadable/,
    );
    // The budget was NOT silently refilled: nothing reports a fresh ledger.
    expect(() => restarted.snapshot("root")).toThrow(BudgetSnapshotUnreadableError);
    db.close();
  });

  it("still treats a genuinely absent snapshot as a fresh budget", async () => {
    const { db, append } = seeded();
    const port = createExecutionBudgetPort({
      policyOf: () => policy,
      store: createSqliteBudgetStateStore(db, append),
    });
    expect(port.snapshot("root")).toEqual({ stepsUsed: 0 });
    await expect(port.charge({ taskId: "root", kind: "agent-run" })).resolves.toMatchObject({
      allowed: true,
      stepsUsed: 1,
    });
    db.close();
  });
});

/**
 * 07 section 4: one active message per checkpoint version, repeats EDIT it. The
 * ledger that decides "repeat" is process-local, and it used to be written by
 * `emit` itself — before any transaction. So the very first thing an activity
 * retry saw was its own uncommitted attempt: attempt 1's transaction throws
 * (SQLITE_BUSY, or the write queue closed during shutdown), Temporal retries
 * with the same event, and `emit` degraded the post into an `update-message`
 * aimed at a row that was never inserted. The operator got a reaction and no
 * explanation, and the update dead-lettered.
 */
describe("the interaction policy's emit ledger records what is DURABLE", () => {
  const checkpointEvent = (eventId: string) => ({
    id: eventId,
    taskId: "t1",
    workspaceId: "ws",
    type: "WaitingPlanApproval" as const,
    payload: { checkpointId: "cp_1", checkpointVersion: 1, prompt: "Approve?" },
    createdAt: 1,
  });

  /** The port derives synchronously; a promise here would be a contract change. */
  const messageActions = (port: InteractionPolicyPort, id: string) => {
    const intents = port.emit(checkpointEvent(id));
    if (intents instanceof Promise) throw new Error("interaction policy must emit synchronously");
    return { intents, actions: intents.map((intent) => intent.action) };
  };

  it("re-posts after an attempt whose transaction never committed", () => {
    const port = createInteractionPolicyPort({ events: new ControlEventBus() });

    // Attempt 1: intents derived, transaction throws, nothing is durable.
    const first = messageActions(port, "evt-1");
    expect(first.actions).toContain("post-thread-message");

    // Attempt 2: the SAME activity retried by Temporal. It must post again —
    // there is no row to edit.
    const retry = messageActions(port, "evt-1");
    expect(retry.actions).toContain("post-thread-message");
    expect(retry.actions).not.toContain("update-message");
  });

  it("edits once the intents from the first attempt really committed", () => {
    const port = createInteractionPolicyPort({ events: new ControlEventBus() });

    const first = messageActions(port, "evt-1");
    port.recordEmitted(first.intents);

    const repeat = messageActions(port, "evt-2");
    expect(repeat.actions).toContain("update-message");
    expect(repeat.actions).not.toContain("post-thread-message");
  });
});
