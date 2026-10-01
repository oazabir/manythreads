import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/index.ts';

describe('sliding-window rate limiter', () => {
  const rule = { limit: 3, windowMs: 1000 };

  it('allows exactly `limit` hits per window then refuses', () => {
    const rl = createRateLimiter({ now: () => 0 });
    const results = Array.from({ length: 5 }, () => rl.hit('k', 'GET /x', rule).allowed);
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('slides: capacity returns as old hits leave the window', () => {
    let t = 0;
    const rl = createRateLimiter({ now: () => t });
    for (const at of [0, 400, 800]) {
      t = at;
      expect(rl.hit('k', 'r', rule).allowed).toBe(true);
    }
    t = 900;
    const refused = rl.hit('k', 'r', rule);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(100);
    t = 1001; // the hit at t=0 left the window; the ones at 400 and 800 remain
    expect(rl.hit('k', 'r', rule).allowed).toBe(true);
    expect(rl.hit('k', 'r', rule).allowed).toBe(false);
  });

  it('counts per key and per route independently', () => {
    const rl = createRateLimiter({ now: () => 0 });
    for (let i = 0; i < 3; i++) rl.hit('a', 'r1', rule);
    expect(rl.hit('a', 'r1', rule).allowed).toBe(false);
    expect(rl.hit('b', 'r1', rule).allowed).toBe(true);
    expect(rl.hit('a', 'r2', rule).allowed).toBe(true);
  });

  it('reports remaining and rejects nonsense rules', () => {
    const rl = createRateLimiter({ now: () => 0 });
    expect(rl.hit('k', 'r', rule).remaining).toBe(2);
    expect(() => rl.hit('k', 'r', { limit: 0, windowMs: 1 })).toThrow();
  });

  it('two limiters share nothing (per replica)', () => {
    const a = createRateLimiter({ now: () => 0 });
    const b = createRateLimiter({ now: () => 0 });
    for (let i = 0; i < 3; i++) a.hit('k', 'r', rule);
    expect(a.hit('k', 'r', rule).allowed).toBe(false);
    expect(b.hit('k', 'r', rule).allowed).toBe(true);
  });
});
