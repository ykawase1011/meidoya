import type { TaskStatus } from "@meidoya/domain";

export type ControlEvent = {
  workspaceId: string;
  taskId: string;
  type: string;
  status?: TaskStatus;
  checkpoint?: {
    checkpointId: string;
    kind: string;
    prompt: string;
    version: number;
    choices: { id: string; label: string }[];
  };
  payload?: Record<string, unknown>;
  at: number;
};

export type ControlEventListener = (event: ControlEvent) => void;

/**
 * In-process fan-out of domain events to connected Control Plane clients.
 * Subscribers only ever see events for the workspace their scope token names,
 * so the CLI can follow a task without holding an agent process.
 */
export class ControlEventBus {
  readonly #listeners = new Set<ControlEventListener>();
  readonly #onListenerError: (error: unknown, event: ControlEvent) => void;

  /**
   * `onListenerError` is where a subscriber's failure is REPORTED. It is not
   * where one is handled: this bus is in-process and non-durable, it has no
   * retry, and a listener that throws has simply not run. That is survivable
   * for a UI stream and it is not survivable for the listener that opens a
   * task's conversation, so anything whose work must actually happen needs a
   * reconciler of its own (see `reconcileConversations`) rather than trust in
   * this fan-out.
   *
   * Swallowing the throw silently was the part that made that indistinguishable
   * from success, for both kinds of subscriber at once.
   */
  constructor(
    options: { onListenerError?: (error: unknown, event: ControlEvent) => void } = {},
  ) {
    this.#onListenerError =
      options.onListenerError ??
      ((error, event) =>
        void process.stderr.write(
          `meidoyad: a control-event subscriber threw on ${event.type} (task ${event.taskId}); ` +
            `that subscriber did NOT run: ${String(error)}\n`,
        ));
  }

  subscribe(listener: ControlEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(event: ControlEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        // A broken subscriber must not break the control plane — but it must
        // not be invisible either.
        try {
          this.#onListenerError(error, event);
        } catch {
          // A broken reporter is the end of the line; there is nowhere left to
          // report it to, and it must not take the publisher down.
        }
      }
    }
  }
}
