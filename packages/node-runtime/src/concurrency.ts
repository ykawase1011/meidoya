export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private limit: number) {
    if (limit < 1) throw new Error("maxConcurrency must be >= 1");
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get maxConcurrency(): number {
    return this.limit;
  }

  /** Applied after Control Plane reconciliation may have lowered the limit. */
  setLimit(limit: number): void {
    if (limit < 1) throw new Error("maxConcurrency must be >= 1");
    this.limit = limit;
    this.drain();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      this.queue.shift()?.();
    }
  }
}
