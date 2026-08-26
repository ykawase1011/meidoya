import type {
  ArtifactRef,
  EvidenceRef,
  VerificationCommandSelection,
  VerificationPlan,
} from "@meidoya/domain";

import type { ArtifactProbePort, CommandRunnerPort } from "./ports.js";

export type VerificationCommandGroup = {
  name: string;
  commands: VerificationCommandSelection[];
};

export type VerificationCommandOutcome = {
  name: string;
  command: string;
  exitCode: number;
  durationMs: number;
  failureSignature?: string;
  evidence?: EvidenceRef;
};

export type VerificationGroupResult = {
  name: string;
  status: "passed" | "failed";
  commands: VerificationCommandOutcome[];
};

export type VerificationResult = {
  status: "passed" | "failed";
  groups: VerificationGroupResult[];
  missingArtifacts: string[];
  artifacts: ArtifactRef[];
  evidence: EvidenceRef[];
  /** Stable signature used by no-progress detection (06 section 6). */
  failureSignature?: string;
};

/**
 * `group:name` splits a plan into command groups; an ungrouped command forms its
 * own group. Grouping is deterministic so replays produce identical results.
 */
export function toCommandGroups(plan: VerificationPlan): VerificationCommandGroup[] {
  const groups: VerificationCommandGroup[] = [];
  const index = new Map<string, VerificationCommandGroup>();
  for (const cmd of plan.commands) {
    const sep = cmd.name.indexOf(":");
    const groupName = sep > 0 ? cmd.name.slice(0, sep) : cmd.name;
    let group = index.get(groupName);
    if (!group) {
      group = { name: groupName, commands: [] };
      index.set(groupName, group);
      groups.push(group);
    }
    group.commands.push(cmd);
  }
  return groups;
}

export type VerificationRunOptions = {
  cwd?: string;
  /** Artifact paths the plan promised to produce (05 section 10). */
  expectedArtifacts?: string[];
};

/**
 * 05 section 7: the verdict comes from exit codes and artifact evidence only —
 * never from an LLM judgement.
 */
export async function runVerification(
  plan: VerificationPlan,
  ports: { commands: CommandRunnerPort; artifacts: ArtifactProbePort },
  options: VerificationRunOptions = {},
): Promise<VerificationResult> {
  const groups: VerificationGroupResult[] = [];
  const artifacts: ArtifactRef[] = [];
  const evidence: EvidenceRef[] = [];
  const failureParts: string[] = [];

  for (const group of toCommandGroups(plan)) {
    const outcomes: VerificationCommandOutcome[] = [];
    let groupFailed = false;
    for (const cmd of group.commands) {
      // Only the gate NAME crosses this boundary; the runner owns the argv.
      const spec =
        options.cwd === undefined ? { name: cmd.name } : { name: cmd.name, cwd: options.cwd };
      const execution = await ports.commands.run(spec);
      const outcome: VerificationCommandOutcome = {
        name: cmd.name,
        command: execution.resolvedCommand ?? cmd.name,
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
      };
      if (execution.failureSignature !== undefined) {
        outcome.failureSignature = execution.failureSignature;
      }
      if (execution.evidence !== undefined) {
        outcome.evidence = execution.evidence;
        evidence.push(execution.evidence);
      }
      if (execution.artifacts) artifacts.push(...execution.artifacts);
      if (execution.exitCode !== 0) {
        groupFailed = true;
        failureParts.push(
          `${cmd.name}#${execution.failureSignature ?? `exit${execution.exitCode}`}`,
        );
      }
      outcomes.push(outcome);
    }
    groups.push({ name: group.name, status: groupFailed ? "failed" : "passed", commands: outcomes });
  }

  const missingArtifacts: string[] = [];
  for (const path of options.expectedArtifacts ?? []) {
    if (!(await ports.artifacts.exists(path))) missingArtifacts.push(path);
  }
  if (missingArtifacts.length > 0) {
    failureParts.push(`missing-artifacts#${missingArtifacts.slice().sort().join(",")}`);
  }

  // 05 section 7: the verdict is evidence, and zero commands are zero evidence.
  // "Did these no commands fail?" has the answer `no`, and returning `passed`
  // for it made an empty plan the easiest way to complete a task: every caller
  // that substituted `{ commands: [] }` for a missing plan — the workflow used
  // to — turned the quality gate into a formality. An empty plan fails, and
  // says why.
  const vacuous = groups.length === 0;
  if (vacuous) failureParts.push("verification#no-commands");

  const failed =
    vacuous || groups.some((g) => g.status === "failed") || missingArtifacts.length > 0;
  const result: VerificationResult = {
    status: failed ? "failed" : "passed",
    groups,
    missingArtifacts,
    artifacts,
    evidence,
  };
  if (failed) result.failureSignature = failureParts.join("|");
  return result;
}
