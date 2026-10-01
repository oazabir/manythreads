/**
 * In-memory sign-in lockout (per replica, like every rate limit; PLAN D3): after `max` failures inside `windowMs` for
 * one key (email + client address) the key is refused for `lockMs`. Unknown emails count exactly like known ones, so
 * the lock reveals nothing about which accounts exist.
 */
export interface LockoutOptions {
  max?: number;
  windowMs?: number;
  lockMs?: number;
  now: () => Date;
  /** Hard cap on tracked keys; expired entries go first, then the oldest. */
  maxKeys?: number;
}

export interface LockState {
  locked: boolean;
  retryAfterMs: number;
}

export interface Lockout {
  /** Is this key locked right now? */
  check(key: string): LockState;
  /**
   * Starts an attempt: like `check`, but the attempt counts as a failure-in-waiting until `end` is called, so a burst of
   * parallel guesses cannot all slip past the limit while the first one is still being verified.
   */
  begin(key: string): LockState;
  /** Finishes an attempt started with `begin` (whatever its outcome; `fail` / `reset` record the result). */
  end(key: string): void;
  /** Record a failed attempt; `locked` is true when it was the one that tripped the lock. */
  fail(key: string): LockState;
  /** A successful sign-in clears the key. */
  reset(key: string): void;
}

interface Entry {
  failures: number[];
  lockedUntil: number;
}

export function createLockout(options: LockoutOptions): Lockout {
  const max = options.max ?? 5;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const lockMs = options.lockMs ?? 15 * 60_000;
  const maxKeys = options.maxKeys ?? 50_000;
  const entries = new Map<string, Entry>();
  /** Attempts being verified right now, per key (bounded by the number of in-flight requests). */
  const pending = new Map<string, number>();
  const nowMs = (): number => options.now().getTime();

  const prune = (t: number): void => {
    for (const [k, e] of entries) {
      if (e.lockedUntil <= t && e.failures.every((f) => f <= t - windowMs)) entries.delete(k);
    }
    while (entries.size > maxKeys) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    check(key) {
      const t = nowMs();
      const e = entries.get(key);
      if (e && e.lockedUntil > t) return { locked: true, retryAfterMs: e.lockedUntil - t };
      return { locked: false, retryAfterMs: 0 };
    },
    begin(key) {
      const t = nowMs();
      const e = entries.get(key);
      if (e && e.lockedUntil > t) return { locked: true, retryAfterMs: e.lockedUntil - t };
      const inFlight = pending.get(key) ?? 0;
      const recent = e ? e.failures.filter((f) => f > t - windowMs).length : 0;
      if (recent + inFlight >= max) return { locked: true, retryAfterMs: 1_000 };
      pending.set(key, inFlight + 1);
      return { locked: false, retryAfterMs: 0 };
    },
    end(key) {
      const n = (pending.get(key) ?? 0) - 1;
      if (n > 0) pending.set(key, n);
      else pending.delete(key);
    },
    fail(key) {
      const t = nowMs();
      if (entries.size >= maxKeys) prune(t);
      const e = entries.get(key) ?? { failures: [], lockedUntil: 0 };
      e.failures = e.failures.filter((f) => f > t - windowMs);
      e.failures.push(t);
      if (e.failures.length >= max) {
        e.lockedUntil = t + lockMs;
        e.failures = [];
        entries.set(key, e);
        return { locked: true, retryAfterMs: lockMs };
      }
      entries.set(key, e);
      return { locked: false, retryAfterMs: 0 };
    },
    reset(key) {
      entries.delete(key);
    },
  };
}
