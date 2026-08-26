/**
 * 08 section 8: exactly one writer touches meidoya.sqlite. Agents and execution
 * nodes never open the database; every mutation funnels through this queue so
 * writes are serialized in submission order even under concurrent activities.
 */
export class SerialWriteQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #pending = 0;

  get pending(): number {
    return this.#pending;
  }

  enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error("write queue is closed"));
    }
    this.#pending += 1;
    const run = this.#tail.then(fn, fn);
    // The chain must survive a rejected job, otherwise one failure stalls it.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.#pending -= 1;
    });
  }

  /** Waits for everything already enqueued; used by graceful shutdown. */
  async drain(): Promise<void> {
    await this.#tail;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.drain();
  }
}
