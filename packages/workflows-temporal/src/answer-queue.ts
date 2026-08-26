/**
 * The bound on `TaskWorkflow`'s queue of checkpoint answers.
 *
 * ## Why a queue exists at all
 *
 * A `answerCheckpoint` signal can arrive before the workflow knows which
 * checkpoint it is waiting on: the checkpoint row is visible to the API the
 * moment `db.createCheckpoint` commits, and the workflow only assigns
 * `pendingCheckpointId` after recording the wait state. So the handler cannot
 * pre-filter — it has to keep what arrives, and `runGate` picks out the answer
 * to ITS checkpoint by id.
 *
 * ## Why it has to be bounded
 *
 * Nothing else drains it. A workflow parked inside a two-hour Worker activity
 * reaches no gate, so every signal anyone sends it — a retried delivery, a
 * mis-addressed answer, an operator clicking twice, a buggy client in a loop —
 * accumulates in workflow memory for the life of the execution, and workflow
 * memory is replayed from history on every worker restart. An unbounded
 * signal-fed array is a slow leak that ends in a workflow too large to replay.
 *
 * ## The two rules, and why they are replay-safe
 *
 * 1. an answer REPLACES an earlier one for the same checkpoint (a re-answer is
 *    the operator's latest word, and a redelivered signal is the same word
 *    twice — neither deserves a second slot);
 * 2. beyond {@link MAX_QUEUED_ANSWERS} entries the OLDEST is dropped, because
 *    the answer a gate is about to want is by construction one of the most
 *    recent: the race this queue exists for is measured in milliseconds.
 *
 * Both are pure functions of the signal sequence, which replay delivers
 * identically, so the surviving set is the same on every replay and no command
 * changes. That is why this needs no patch id: it is workflow STATE, not a
 * command. (A history that had already queued more than {@link
 * MAX_QUEUED_ANSWERS} DISTINCT unanswered checkpoints and was waiting on the
 * oldest of them would replay differently — but for that the workflow would
 * have to be waiting on a checkpoint answered before 32 other checkpoints were
 * answered, and a gate consumes its answer within one workflow task of it
 * arriving.)
 */
export const MAX_QUEUED_ANSWERS = 32;

/** The shape this queue needs; `CheckpointAnswer` satisfies it. */
export type AddressedAnswer = { readonly checkpointId: string };

/**
 * Adds `incoming` to `queue` in place, under the two rules above.
 *
 * Pure apart from the mutation of `queue`: no clock, no IO, no randomness. It
 * runs inside workflow code, from a signal handler.
 */
export function recordCheckpointAnswer<T extends AddressedAnswer>(
  queue: T[],
  incoming: T,
  limit: number = MAX_QUEUED_ANSWERS,
): void {
  const existing = queue.findIndex((queued) => queued.checkpointId === incoming.checkpointId);
  if (existing >= 0) queue.splice(existing, 1);
  queue.push(incoming);
  // `limit` entries at most, oldest out first.
  if (queue.length > limit) queue.splice(0, queue.length - limit);
}
