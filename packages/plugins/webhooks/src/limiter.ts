// A sliding-window counter held in this process (per replica, never in the database: PLAN D3). One window per key; a refused call is not counted, so
// a sender that backs off recovers exactly one window after its last accepted call. Idle keys are dropped now and then so abandoned webhooks do not pile up.

export interface WindowLimiter {
  /** Counts one call for `key`; says whether it is within `limit` per `windowMs` and, when not, how long to wait. */
  hit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterMs: number };
  reset(): void;
}

export function createWindowLimiter(now: () => number = Date.now): WindowLimiter {
  const buckets = new Map<string, number[]>();
  let lastSweep = now();
  return {
    hit(key, limit, windowMs) {
      const t = now();
      if (t - lastSweep >= Math.max(windowMs, 60_000)) {
        lastSweep = t;
        for (const [k, stamps] of buckets) {
          const last = stamps[stamps.length - 1];
          if (last === undefined || t - last >= Math.max(windowMs, 60_000)) buckets.delete(k);
        }
      }
      const stamps = buckets.get(key) ?? [];
      const cutoff = t - windowMs;
      let start = 0;
      while (start < stamps.length && (stamps[start] as number) <= cutoff) start++;
      if (start > 0) stamps.splice(0, start);
      if (stamps.length >= limit) {
        buckets.set(key, stamps);
        return { allowed: false, retryAfterMs: Math.max(1, (stamps[0] as number) + windowMs - t) };
      }
      stamps.push(t);
      buckets.set(key, stamps);
      return { allowed: true, retryAfterMs: 0 };
    },
    reset() {
      buckets.clear();
    },
  };
}

/** Lets an event through at most once per `windowMs` for each key (the audit line of a refused call: a flood of bad calls writes one line a minute). */
export function createOncePer(windowMs: number, now: () => number = Date.now): (key: string) => boolean {
  const seen = new Map<string, number>();
  return (key) => {
    const t = now();
    if (seen.size > 5_000) for (const [k, at] of seen) if (t - at >= windowMs) seen.delete(k);
    const at = seen.get(key);
    if (at !== undefined && t - at < windowMs) return false;
    seen.set(key, t);
    return true;
  };
}
