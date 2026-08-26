import readline from "node:readline";
import type { ControlPlaneClient } from "./client.js";

export type OpenCheckpoint = {
  checkpointId: string;
  kind: string;
  prompt: string;
  choices: { id: string; label: string }[];
};

export type TaskDetail = {
  taskId: string;
  title: string;
  status: string;
  pipeline: string;
  createdAt: number;
  updatedAt: number;
  intentSummary: string;
  projects: string[];
  openCheckpoint?: OpenCheckpoint;
};

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** Exactly the attached-CLI shape from 07 section 7. */
export function renderCheckpointPrompt(taskId: string, kind: string): string {
  return [
    `Task ${taskId} is waiting for ${kind.replace(/-/g, " ")}.`,
    "",
    "[A] Approve",
    "[E] Add instruction",
    "[C] Cancel",
    "> ",
  ].join("\n");
}

export type CheckpointAnswer =
  | { action: "approve" }
  | { action: "instruct"; text: string }
  | { action: "cancel" };

export type LineReader = {
  question(prompt: string): Promise<string>;
  close(): void;
};

export function stdinReader(): LineReader {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    question: (prompt) => new Promise<string>((resolve) => rl.question(prompt, resolve)),
    close: () => rl.close(),
  };
}

export async function askCheckpoint(
  reader: LineReader,
  taskId: string,
  kind: string,
): Promise<CheckpointAnswer> {
  for (;;) {
    const answer = (await reader.question(renderCheckpointPrompt(taskId, kind))).trim().toLowerCase();
    if (answer === "a" || answer === "approve") return { action: "approve" };
    if (answer === "c" || answer === "cancel") return { action: "cancel" };
    if (answer === "e" || answer === "instruction" || answer === "add instruction") {
      const text = (await reader.question("Instruction: ")).trim();
      return { action: "instruct", text };
    }
    process.stdout.write("Please answer A, E or C.\n");
  }
}

const APPROVAL_KINDS = new Set(["plan-approval", "review-approval", "side-effect-approval"]);

/**
 * Optimistic concurrency: `checkpoint.answer` requires the version the caller
 * saw, and TaskDetail carries only the summary, so read it just before writing.
 */
export async function checkpointVersion(
  client: ControlPlaneClient,
  checkpointId: string,
): Promise<number> {
  const record = (await client.scoped("checkpoint.get", { checkpointId })) as { version: number };
  return record.version;
}

/**
 * Sends the answer through `checkpoint.answer`. Approval checkpoints accept only
 * approve/reject, so "add instruction" is delivered as a rejection carrying the
 * instruction text rather than being silently dropped.
 */
export async function sendCheckpointAnswer(
  client: ControlPlaneClient,
  checkpoint: OpenCheckpoint,
  answer: CheckpointAnswer,
  expectedVersion: number,
): Promise<void> {
  const approval = APPROVAL_KINDS.has(checkpoint.kind);
  if (answer.action === "approve") {
    await client.scoped("checkpoint.answer", {
      checkpointId: checkpoint.checkpointId,
      decision: approval ? "approve" : "answer",
      ...(approval ? {} : { answer: "Approve" }),
      expectedVersion,
    });
    return;
  }
  if (answer.action === "instruct") {
    await client.scoped("checkpoint.answer", {
      checkpointId: checkpoint.checkpointId,
      decision: approval ? "reject" : "answer",
      answer: answer.text,
      expectedVersion,
    });
    return;
  }
  await client.scoped("checkpoint.answer", {
    checkpointId: checkpoint.checkpointId,
    decision: approval ? "reject" : "answer",
    ...(approval ? {} : { answer: "Cancel" }),
    expectedVersion,
  });
}

export type AttachOptions = {
  client: ControlPlaneClient;
  taskId: string;
  reader?: LineReader;
  /** Detached watch never prompts; it only reports. */
  interactive: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  out?: (line: string) => void;
};

/**
 * Follows a task to a terminal state. The CLI holds no agent process: it polls
 * the Control Plane projection and reacts to Control Plane events only.
 */
export async function attachToTask(options: AttachOptions): Promise<TaskDetail> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const poll = options.pollIntervalMs ?? 200;
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  let lastStatus: string | undefined;
  const answeredCheckpoints = new Set<string>();

  const stopListening = options.client.onNotification((event, payload) => {
    if (event !== "task.event") return;
    const record = payload as { taskId?: string; type?: string };
    if (record.taskId !== options.taskId || typeof record.type !== "string") return;
    out(`[${options.taskId}] event ${record.type}`);
  });

  try {
    for (;;) {
      const task = (await options.client.scoped("task.get", {
        taskId: options.taskId,
      })) as TaskDetail;

      if (task.status !== lastStatus) {
        lastStatus = task.status;
        out(`[${task.taskId}] ${task.status}`);
      }

      if (TERMINAL_STATUSES.has(task.status)) return task;

      const checkpoint = task.openCheckpoint;
      if (checkpoint !== undefined && !answeredCheckpoints.has(checkpoint.checkpointId)) {
        if (!options.interactive) {
          out(
            `[${task.taskId}] waiting for ${checkpoint.kind} (${checkpoint.checkpointId}): ${checkpoint.prompt}`,
          );
          out(
            `Answer with: meidoya task answer ${task.taskId} --checkpoint ${checkpoint.checkpointId} "Approve"`,
          );
          return task;
        }
        const reader = options.reader;
        if (reader === undefined) throw new Error("interactive attach needs a line reader");
        const answer = await askCheckpoint(reader, task.taskId, checkpoint.kind);
        const version = await checkpointVersion(options.client, checkpoint.checkpointId);
        await sendCheckpointAnswer(options.client, checkpoint, answer, version);
        answeredCheckpoints.add(checkpoint.checkpointId);
        if (answer.action === "cancel") {
          await options.client.scoped("task.cancel", {
            taskId: task.taskId,
            reason: "cancelled at checkpoint",
          });
        }
      }

      if (Date.now() > deadline) throw new Error(`timed out waiting for task ${options.taskId}`);
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  } finally {
    stopListening();
  }
}
