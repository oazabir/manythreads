export interface RateLimit {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the oldest counted request leaves the window (0 when allowed with room left). */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Count one request for `key` on `route`; says whether it is within `limit` per `windowMs`. */
  hit(key: string, route: string, rule: RateLimit): RateLimitResult;
  /** Forget all counters (tests). */
  reset(): void;
}

export interface RateLimiterOptions {
  /** Clock in ms; injectable for tests. Default Date.now. */
  now?: () => number;
}

/**
 * Sliding-window log limiter held in process memory: per replica, never in the database (PLAN D3). Each
 * key+route keeps the timestamps of its counted requests inside the window; refused requests are not counted,
 * so a client that backs off recovers exactly one window after its last accepted request.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, number[]>();
  let lastSweep = now();

  const sweep = (t: number, windowMs: number): void => {
    // Drop idle buckets now and then so abandoned keys do not accumulate.
    if (t - lastSweep < Math.max(windowMs, 60_000)) return;
    lastSweep = t;
    for (const [k, stamps] of buckets) {
      const last = stamps[stamps.length - 1];
      if (last === undefined || t - last >= Math.max(windowMs, 60_000)) buckets.delete(k);
    }
  };

  return {
    hit(key, route, rule) {
      if (!(rule.limit > 0) || !(rule.windowMs > 0)) throw new Error('rate limit needs limit > 0 and windowMs > 0');
      const t = now();
      sweep(t, rule.windowMs);
      const id = `${route}\u0000${key}`;
      const stamps = buckets.get(id) ?? [];
      const cutoff = t - rule.windowMs;
      let start = 0;
      while (start < stamps.length && (stamps[start] as number) <= cutoff) start++;
      if (start > 0) stamps.splice(0, start);
      if (stamps.length >= rule.limit) {
        buckets.set(id, stamps);
        return {
          allowed: false,
          limit: rule.limit,
          remaining: 0,
          retryAfterMs: Math.max(1, (stamps[0] as number) + rule.windowMs - t),
        };
      }
      stamps.push(t);
      buckets.set(id, stamps);
      return { allowed: true, limit: rule.limit, remaining: rule.limit - stamps.length, retryAfterMs: 0 };
    },
    reset() {
      buckets.clear();
    },
  };
}
