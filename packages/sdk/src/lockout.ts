import { HttpError } from './types.ts';

/**
 * In-memory credential lockout (per replica, like every rate limit; PLAN D3, D5): after `max` failures inside `windowMs`
 * for one key (for example email + client address, or a client address alone for a mailed link) the key is refused for
 * `lockMs`. The lock is temporary and is not extended by attempts made while it holds. Unknown emails count exactly like
 * known ones, so the lock reveals nothing about which accounts exist. Plugins share this one implementation
 * (docs/deploy/rate-limits.md lists every key and number).
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

/**
 * The answer for a locked key: `429 rate_limited` with `retry-after` (whole seconds, at least 1) and a plain message.
 * Throw it from a route; it rolls the route's transaction back, which is right for a refusal that wrote nothing.
 */
export function lockedError(state: LockState, subject = 'attempts'): HttpError {
  const seconds = Math.max(1, Math.ceil(state.retryAfterMs / 1000));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return new HttpError(429, 'rate_limited', `Too many failed ${subject}. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, {
    'retry-after': String(seconds),
  });
}

/**
 * Runs `redeem` (a route's use of a secret that arrived in the request: a mailed link, a setup or invitation token) behind a
 * failure lock on `key`. A locked key answers 429 at once and never reaches the database; an attempt the secret did not pass
 * counts as a failure (`refused` says which outcomes those are; by default a thrown 404 or 410). Parallel guesses are counted
 * while in flight (`begin` / `end`), so a burst cannot all slip past the limit.
 */
export async function guardRedemption<T>(
  lock: Lockout,
  key: string,
  subject: string,
  redeem: () => Promise<T>,
  refused: (outcome: { result?: T; error?: unknown }) => boolean = ({ error }) =>
    error instanceof HttpError && (error.status === 404 || error.status === 410),
): Promise<T> {
  const state = lock.begin(key);
  if (state.locked) throw lockedError(state, subject);
  try {
    const result = await redeem();
    if (refused({ result })) lock.fail(key);
    return result;
  } catch (err) {
    if (refused({ error: err })) lock.fail(key);
    throw err;
  } finally {
    lock.end(key);
  }
}
