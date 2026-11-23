/**
 * Work done after a change commits, without the response waiting for it, such as indexing texts again after a Term is
 * renamed. Jobs run one at a time, in the order added; a job added while one with the same key still waits to start
 * is left out, as that one will do it. A job that fails is logged, since its change has committed regardless.
 */
export class Jobs {
  private tail: Promise<void> = Promise.resolve();
  private readonly waiting = new Set<string>();
  /** Where a failed job is told; until the app has a logger, stderr. */
  onError: (error: unknown, key: string) => void = (error, key) => console.error(`job ${key} failed`, error);

  add(key: string, job: () => Promise<void>): void {
    if (this.waiting.has(key)) return;
    this.waiting.add(key);
    this.tail = this.tail.then(async () => {
      this.waiting.delete(key);
      try {
        await job();
      } catch (error) {
        this.onError(error, key);
      }
    });
  }

  /** Resolves once every job added so far, and any they add, has run. */
  async settled(): Promise<void> {
    let tail;
    do {
      tail = this.tail;
      await tail;
    } while (tail !== this.tail);
  }
}
