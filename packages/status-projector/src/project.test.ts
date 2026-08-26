import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StatusSnapshot } from "./model.js";
import { projectStatusMarkdown } from "./project.js";
import { REDACTED, scrub } from "./scrub.js";
import { writeStatusFile } from "./write.js";

const HOME = "/Users/tester";

const snapshot: StatusSnapshot = {
  environmentId: "personal",
  generatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  workspaces: [
    {
      workspaceId: "work-it",
      displayName: "Work IT",
      tasks: [
        {
          taskId: "task-2",
          title: "Ship product-b release",
          status: "waiting_plan_approval",
          pipeline: "coding",
          origin: "chat",
          updatedAt: Date.UTC(2026, 0, 2, 2, 0, 0),
          openCheckpoint: { kind: "plan-approval", prompt: "Approve the plan?" },
          artifacts: [],
        },
        {
          taskId: "task-1",
          title: "Investigate flaky test",
          status: "running",
          pipeline: "coding",
          origin: "cli",
          updatedAt: Date.UTC(2026, 0, 2, 1, 0, 0),
          currentPhase: "verifying",
          artifacts: [
            {
              artifactId: "a-private",
              kind: "log",
              path: `${HOME}/.local/share/meidoya/artifacts/work-it/task-1/run.log`,
              sha256: "aaaa1111bbbb2222",
              visibility: "private",
            },
            {
              artifactId: "a-summary",
              kind: "review",
              path: `${HOME}/.local/share/meidoya/artifacts/work-it/task-1/review.md`,
              sha256: "cccc3333dddd4444",
              visibility: "summary",
              summary: "2 minor findings",
            },
            {
              artifactId: "a-user",
              kind: "report",
              path: `${HOME}/Workspace/Repositories/product-a/REPORT.md`,
              sha256: "eeee5555ffff6666",
              visibility: "user",
            },
          ],
        },
      ],
      schedules: [
        {
          scheduleId: "sched-1",
          name: "daily digest",
          cron: "0 9 * * *",
          timezone: "Asia/Tokyo",
          enabled: true,
          delivery: "on-change",
          lastRunAt: Date.UTC(2026, 0, 1, 0, 0, 0),
          lastOutcome: "no-change",
        },
      ],
    },
    {
      workspaceId: "work-grammarxiv",
      displayName: "GrammarXiv",
      tasks: [],
      schedules: [],
    },
  ],
  nodes: [
    {
      nodeId: "mac-main",
      profile: "mac-restricted",
      platform: "darwin",
      status: "online",
      activeRunCount: 1,
      maxConcurrency: 4,
      allowedWorkspaces: ["work-it"],
    },
  ],
};

const options = { home: HOME };

/**
 * Verification and worker steps run ONLY on an execution node (10 sections
 * 1-3). When no node is online for a workspace, its active tasks sit in
 * `running`/`verifying` indefinitely — correct behaviour, but from STATUS.md
 * alone it used to be indistinguishable from a wedged task, so an operator had
 * no way to know the fix was "start a node" rather than "debug the daemon".
 */
describe("parked waiting for an execution node", () => {
  const withNodes = (
    nodes: StatusSnapshot["nodes"],
  ): StatusSnapshot => ({ ...structuredClone(snapshot), nodes });

  it("says so, and names the offline node, when nothing is polling the queue", () => {
    const output = projectStatusMarkdown(
      withNodes([
        {
          nodeId: "mac-main",
          profile: "mac-restricted",
          platform: "darwin",
          status: "offline",
          activeRunCount: 0,
          maxConcurrency: 4,
          allowedWorkspaces: ["work-it"],
        },
      ]),
      options,
    );
    expect(output).toContain("PARKED — waiting for an execution node");
    expect(output).toContain("bound nodes: mac-main (offline)");
    // It is not a human gate: an operator must not go looking for a checkpoint.
    expect(output).toContain("need no human answer");
    // The notice belongs to the workspace whose node is down, above its tasks.
    const parked = output.indexOf("PARKED");
    expect(output.indexOf("work-it")).toBeLessThan(parked);
    expect(parked).toBeLessThan(output.indexOf("Investigate flaky test"));
  });

  it("says when no node is bound at all", () => {
    const output = projectStatusMarkdown(withNodes([]), options);
    expect(output).toContain("no execution node is bound to this workspace");
  });

  it("stays silent while a bound node is online", () => {
    // The base snapshot: mac-main online for work-it.
    expect(projectStatusMarkdown(snapshot, options)).not.toContain("PARKED");
  });

  it("stays silent for a workspace with no active tasks", () => {
    // work-grammarxiv has no tasks and no node; nothing is waiting, so an
    // alarm there would be noise on every idle workspace.
    const output = projectStatusMarkdown(withNodes([]), options);
    const grammarxiv = output.slice(
      output.indexOf("## Workspace: GrammarXiv"),
      output.indexOf("## Workspace: Work IT"),
    );
    expect(grammarxiv).not.toContain("PARKED");
  });

  it("is deterministic and independent of node ordering", () => {
    const nodes: StatusSnapshot["nodes"] = [
      {
        nodeId: "mac-spare",
        profile: "mac-restricted",
        platform: "darwin",
        status: "draining",
        activeRunCount: 0,
        maxConcurrency: 1,
        allowedWorkspaces: ["work-it"],
      },
      {
        nodeId: "mac-main",
        profile: "mac-restricted",
        platform: "darwin",
        status: "offline",
        activeRunCount: 0,
        maxConcurrency: 4,
        allowedWorkspaces: ["work-it"],
      },
    ];
    const a = projectStatusMarkdown(withNodes(nodes), options);
    const b = projectStatusMarkdown(withNodes([...nodes].reverse()), options);
    expect(a).toBe(b);
    expect(a).toContain("bound nodes: mac-main (offline), mac-spare (draining)");
  });
});

describe("STATUS.md projection", () => {
  it("is deterministic for unchanged state", () => {
    const a = projectStatusMarkdown(snapshot, options);
    const b = projectStatusMarkdown(structuredClone(snapshot), options);
    expect(a).toBe(b);
  });

  it("is byte-identical regardless of input ordering", () => {
    const shuffled: StatusSnapshot = {
      ...snapshot,
      workspaces: [...snapshot.workspaces].reverse().map((w) => ({
        ...w,
        tasks: [...w.tasks].reverse().map((t) => ({
          ...t,
          artifacts: [...t.artifacts].reverse(),
        })),
        schedules: [...w.schedules].reverse(),
      })),
      nodes: [...snapshot.nodes].reverse(),
    };
    expect(projectStatusMarkdown(shuffled, options)).toBe(
      projectStatusMarkdown(snapshot, options),
    );
  });

  it("does not vary with the host timezone", () => {
    const output = projectStatusMarkdown(snapshot, options);
    expect(output).toContain("generated: 2026-01-02T03:04:05Z");
  });

  it("orders workspaces, tasks and sections stably", () => {
    const output = projectStatusMarkdown(snapshot, options);
    expect(output.indexOf("work-grammarxiv")).toBeLessThan(
      output.indexOf("work-it"),
    );
    expect(output.indexOf("### Active tasks")).toBeLessThan(
      output.indexOf("### Waiting on a human"),
    );
  });

  it("keeps internal progress in STATUS.md", () => {
    const output = projectStatusMarkdown(snapshot, options);
    expect(output).toContain("phase: verifying");
    expect(output).toContain("awaiting plan-approval");
  });

  it("respects artifact visibility", () => {
    const output = projectStatusMarkdown(snapshot, options);
    expect(output).not.toContain("a-private");
    expect(output).not.toContain("run.log");
    expect(output).toContain("a-summary");
    expect(output).toContain("2 minor findings");
    expect(output).not.toContain("review.md");
    expect(output).toContain("a-user");
    expect(output).toContain("REPORT.md");
  });

  it("never emits absolute host paths", () => {
    const output = projectStatusMarkdown(snapshot, options);
    expect(output).not.toContain(HOME);
    expect(output).not.toMatch(/(?<![\w~.])\/Users\//);
  });
});

describe("scrubbing", () => {
  it("redacts common secret shapes", () => {
    const input = [
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123",
      "OPENAI key sk-abcdefghijklmnopqrstuvwx",
      "Authorization: Bearer abcdefghijklmnopqrst",
      "api_key = 'super-secret-value'",
      "AWS AKIAIOSFODNN7EXAMPLE here",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const output = scrub(input, { home: HOME });
    for (const secret of [
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "sk-abcdefghijklmnopqrstuvwx",
      "super-secret-value",
      "AKIAIOSFODNN7EXAMPLE",
      "BEGIN OPENSSH PRIVATE KEY",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain(REDACTED);
  });

  it("replaces the home directory and labelled roots", () => {
    const output = scrub(`${HOME}/Workspace/Repositories/product-a/src/main.ts`, {
      home: HOME,
      pathLabels: { [`${HOME}/Workspace/Repositories`]: "<repos>" },
    });
    expect(output).toBe("<repos>/product-a/src/main.ts");
  });

  it("truncates unlabelled absolute paths", () => {
    expect(scrub("/var/folders/xy/zz/T/meidoya/run.log", { home: HOME })).toBe(
      ".../meidoya/run.log",
    );
  });
});

describe("writeStatusFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "meidoya-status-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes once and is a no-op for unchanged state", () => {
    const file = path.join(dir, "nested", "STATUS.md");
    const first = writeStatusFile(file, snapshot, options);
    expect(first.changed).toBe(true);

    const second = writeStatusFile(file, snapshot, options);
    expect(second.changed).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(
      projectStatusMarkdown(snapshot, options),
    );
  });

  it("rewrites when state changes", () => {
    const file = path.join(dir, "STATUS.md");
    writeStatusFile(file, snapshot, options);
    const changed = writeStatusFile(
      file,
      { ...snapshot, generatedAt: snapshot.generatedAt + 60_000 },
      options,
    );
    expect(changed.changed).toBe(true);
  });
});
