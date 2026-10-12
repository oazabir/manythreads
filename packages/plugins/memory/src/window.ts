/**
 * A sliding window in process memory, per key (here: per team): how many of `limit` units were spent in the last `windowMs`. Rate limits live in
 * the process, per replica, never in the database (CLAUDE.md); a restart forgets the window, which at worst lets one extra batch through.
 * Timestamps are kept as a queue of `[at, units]` so memory is bounded by the number of calls inside the window, not by units.
 */
export class SlidingWindow {
  private readonly spent = new Map<string, Array<[number, number]>>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(key: string): Array<[number, number]> {
    const cutoff = this.now() - this.windowMs;
    const entries = (this.spent.get(key) ?? []).filter(([at]) => at > cutoff);
    if (entries.length === 0) this.spent.delete(key);
    else this.spent.set(key, entries);
    return entries;
  }

  /** How many more units `key` may spend now. */
  remaining(key: string): number {
    return Math.max(0, this.limit - this.prune(key).reduce((n, [, units]) => n + units, 0));
  }

  /** Records `units` spent now (a call that was made, whatever it answered). */
  spend(key: string, units: number): void {
    if (units <= 0) return;
    const entries = this.prune(key);
    entries.push([this.now(), units]);
    this.spent.set(key, entries);
  }

  /** Milliseconds until `key` has at least one unit again (0 when it has). */
  retryAfterMs(key: string): number {
    if (this.remaining(key) > 0) return 0;
    const first = this.prune(key)[0];
    return first === undefined ? 0 : Math.max(0, first[0] + this.windowMs - this.now());
  }
}
