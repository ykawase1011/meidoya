import fs from "node:fs";
import path from "node:path";
import type { StatusSnapshot } from "./model.js";
import { projectStatusMarkdown, type ProjectionOptions } from "./project.js";

export type WriteResult = {
  path: string;
  changed: boolean;
  bytes: number;
};

/**
 * Atomic, idempotent write: unchanged state must not touch the file, so
 * watchers and git see no churn.
 */
export function writeStatusFile(
  filePath: string,
  snapshot: StatusSnapshot,
  options: ProjectionOptions = {},
): WriteResult {
  const content = projectStatusMarkdown(snapshot, options);
  const existing = readIfExists(filePath);
  if (existing === content) {
    return { path: filePath, changed: false, bytes: Buffer.byteLength(content) };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return { path: filePath, changed: true, bytes: Buffer.byteLength(content) };
}

function readIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}
