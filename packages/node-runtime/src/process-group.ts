import type { ProcessGroupKiller } from "./ports.js";

/**
 * POSIX process-group kill. Agent CLIs spawn children (git, test runners); a
 * plain pid kill leaves them running, so the node always signals -pgid.
 */
export class PosixProcessGroupKiller implements ProcessGroupKiller {
  constructor(
    private readonly kill: (pid: number, signal: NodeJS.Signals) => void = (
      pid,
      signal,
    ) => {
      process.kill(pid, signal);
    },
  ) {}

  killGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
    if (!Number.isInteger(pgid) || pgid <= 1) {
      throw new Error(`refusing to signal process group ${pgid}`);
    }
    try {
      this.kill(-pgid, signal);
    } catch (error) {
      // ESRCH: the group already exited. Anything else is a real problem.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

/** Options every agent subprocess must be spawned with. */
export const DETACHED_SPAWN_OPTIONS = {
  detached: true,
  windowsHide: true,
} as const;
