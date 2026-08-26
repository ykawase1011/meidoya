import type { ModelProfile } from "@meidoya/domain";

/** Section 7: economy -> standard -> high. */
export const MODEL_ESCALATION_ORDER: readonly ModelProfile[] = ["economy", "standard", "high"];

export function nextModelProfile(current: ModelProfile): ModelProfile | undefined {
  const index = MODEL_ESCALATION_ORDER.indexOf(current);
  if (index < 0) {
    return undefined;
  }
  return MODEL_ESCALATION_ORDER[index + 1];
}
