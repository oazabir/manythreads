import type { LlmScopeSnapshot } from './budget.ts';

/** The rate limiter a preflight needs: `hit` counts one call and answers whether it may happen. */
export type RateHit = (key: string, limit: number, windowMs: number) => { allowed: boolean; retryAfterMs: number };

/** The key a limit counts under; the session scope includes the session, so one bot's sessions do not share a bucket. */
export function rateKey(snapshot: LlmScopeSnapshot, sessionId: string | null): string {
  const { scope, teamId, botId } = snapshot.limit;
  if (scope === 'team') return `team:${teamId}`;
  if (scope === 'bot') return `bot:${botId}`;
  if (scope === 'session') return `session:${botId}:${sessionId ?? 'none'}`;
  return 'workspace';
}

/** A sliding-window log limiter, per process (PLAN D3). `hit` counts one call; a refused call is not counted. */
export function createSlidingWindow(now: () => number = Date.now): { hit: RateHit; reset: () => void } {
  const buckets = new Map<string, number[]>();
  return {
    hit(key, limit, windowMs) {
      const stamps = buckets.get(key) ?? [];
      const t = now();
      let start = 0;
      while (start < stamps.length && (stamps[start] as number) <= t - windowMs) start++;
      if (start > 0) stamps.splice(0, start);
      if (stamps.length >= limit) {
        buckets.set(key, stamps);
        return { allowed: false, retryAfterMs: Math.max(1, (stamps[0] as number) + windowMs - t) };
      }
      stamps.push(t);
      buckets.set(key, stamps);
      if (buckets.size > 10_000) {
        // A very long-lived process with many targets: drop buckets whose window has passed (cheap sweep, no timer).
        for (const [id, list] of buckets) {
          const last = list[list.length - 1];
          if (last === undefined || t - last >= windowMs) buckets.delete(id);
        }
      }
      return { allowed: true, retryAfterMs: 0 };
    },
    reset() {
      buckets.clear();
    },
  };
}
