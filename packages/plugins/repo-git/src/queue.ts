/**
 * One queue per key (a team): jobs for a key run one at a time in arrival order, jobs for different keys run side by side. This is the
 * in-process half of "one writer per team"; the other replicas are kept out by `pg_advisory_xact_lock` in the transaction.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  /** Keys with work queued or running (for tests). */
  get size(): number {
    return this.tails.size;
  }
}
