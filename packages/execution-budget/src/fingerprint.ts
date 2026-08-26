import { createHash } from "node:crypto";

export type ManagerDecisionClass =
  | "complete"
  | "fix"
  | "additional_review"
  | "request_checkpoint"
  | "abort";

/** Section 6 fingerprint inputs. */
export type ProgressInputs = {
  gitDiffHash: string;
  verificationFailureSignature: string;
  reviewFindingIds: readonly string[];
  artifactHashes: readonly string[];
  managerDecisionClass: ManagerDecisionClass;
};

export function progressFingerprint(inputs: ProgressInputs): string {
  const canonical = JSON.stringify({
    d: inputs.gitDiffHash,
    v: inputs.verificationFailureSignature,
    f: [...inputs.reviewFindingIds].sort(),
    a: [...inputs.artifactHashes].sort(),
    m: inputs.managerDecisionClass,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export type NoProgressState = {
  lastFingerprint?: string;
  repeatCount: number;
};

export type NoProgressObservation = {
  fingerprint: string;
  /** Number of consecutive repeats after the first occurrence. */
  repeatCount: number;
  noProgress: boolean;
};

/**
 * repeatCount counts *repeats*, not occurrences: the first fingerprint is
 * progress by definition, so a threshold of 2 fires on the third identical
 * round in a row.
 */
export class NoProgressDetector {
  #lastFingerprint: string | undefined;
  #repeatCount = 0;

  constructor(
    private readonly threshold: number,
    state?: NoProgressState,
  ) {
    this.#lastFingerprint = state?.lastFingerprint;
    this.#repeatCount = state?.repeatCount ?? 0;
  }

  observe(inputs: ProgressInputs): NoProgressObservation {
    const fingerprint = progressFingerprint(inputs);
    if (this.#lastFingerprint === fingerprint) {
      this.#repeatCount += 1;
    } else {
      this.#lastFingerprint = fingerprint;
      this.#repeatCount = 0;
    }
    return {
      fingerprint,
      repeatCount: this.#repeatCount,
      noProgress: this.#repeatCount >= this.threshold,
    };
  }

  snapshot(): NoProgressState {
    return {
      ...(this.#lastFingerprint === undefined ? {} : { lastFingerprint: this.#lastFingerprint }),
      repeatCount: this.#repeatCount,
    };
  }
}
