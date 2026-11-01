import { describe, expect, it } from 'vitest';
import { ANONYMOUS_GAP_MS, MIN_DELAY_MS, NAMED_GAP_MS, createPollPushCoalescer, type PollPushClock } from '../src/poll-push.ts';

// P14-07: how often a poll's totals are pushed, with a fake clock. An anonymous poll's totals never go out at the moment of a vote (a page could see
// which vote moved them); a named poll's go out at once when quiet and at most once a second after; a close always goes out at once.

function setup() {
  let at = 1_000_000;
  const timers: Array<{ id: number; at: number; run: () => void; live: boolean }> = [];
  const clock: PollPushClock = {
    now: () => at,
    setTimer: (run, ms) => {
      const t = { id: timers.length, at: at + ms, run, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { live: boolean }).live = false;
    },
  };
  const flushed: string[] = [];
  const errors: unknown[] = [];
  const pusher = createPollPushCoalescer(
    clock,
    async (id) => {
      flushed.push(id);
      if (id === 'boom') throw new Error('push failed');
    },
    (e) => errors.push(e),
  );
  /** Moves the clock and runs the timers that are due, in order. */
  const advance = async (ms: number): Promise<void> => {
    at += ms;
    for (const t of timers.filter((x) => x.live && x.at <= at).sort((a, b) => a.at - b.at)) {
      t.live = false;
      t.run();
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  return { pusher, advance, flushed, errors, timers };
}

const named = (id = 'n1') => ({ id, anonymous: false });
const anon = (id = 'a1') => ({ id, anonymous: true });

describe('the pace of poll pushes', () => {
  it('a named poll that has been quiet is pushed at once, and a burst after it becomes one later push', async () => {
    const s = setup();
    expect(s.pusher.decide(named(), false)).toBe('now');
    expect(s.pusher.decide(named(), false)).toBe('later');
    expect(s.pusher.decide(named(), false)).toBe('later');
    expect(s.pusher.pending()).toBe(1);
    await s.advance(NAMED_GAP_MS);
    expect(s.flushed).toEqual(['n1']);
    expect(s.pusher.pending()).toBe(0);
    // quiet again for a second: the next vote goes out at once
    await s.advance(NAMED_GAP_MS);
    expect(s.pusher.decide(named(), false)).toBe('now');
  });

  it('an anonymous poll is never pushed at the moment of a vote: the totals go out once, a few seconds later, whatever came in meanwhile', async () => {
    const s = setup();
    for (let i = 0; i < 5; i += 1) expect(s.pusher.decide(anon(), false)).toBe('later');
    expect(s.pusher.pending()).toBe(1);
    await s.advance(ANONYMOUS_GAP_MS - 1);
    expect(s.flushed).toEqual([]);
    await s.advance(1);
    expect(s.flushed).toEqual(['a1']);
    // the next vote waits again, even when the last push was long ago
    await s.advance(60_000);
    expect(s.pusher.decide(anon(), false)).toBe('later');
  });

  it('polls are paced one by one', async () => {
    const s = setup();
    expect(s.pusher.decide(named('x'), false)).toBe('now');
    expect(s.pusher.decide(named('y'), false)).toBe('now');
    expect(s.pusher.decide(anon('z'), false)).toBe('later');
  });

  it('a later push is never set closer than a quarter of a second (the change is committed by then)', () => {
    const s = setup();
    s.pusher.decide(named(), false);
    s.pusher.decide(named(), false);
    expect(s.timers[0]!.at - 1_000_000).toBeGreaterThanOrEqual(MIN_DELAY_MS);
  });

  it('a close goes out at once and cancels the push that was waiting, so nothing stale follows it', async () => {
    const s = setup();
    s.pusher.decide(anon(), false);
    expect(s.pusher.pending()).toBe(1);
    expect(s.pusher.decide(anon(), true)).toBe('now');
    expect(s.pusher.pending()).toBe(0);
    await s.advance(ANONYMOUS_GAP_MS * 2);
    expect(s.flushed).toEqual([]);
  });

  it('a push that fails is reported, not thrown, and the poll can be pushed again', async () => {
    const s = setup();
    s.pusher.decide({ id: 'boom', anonymous: true }, false);
    await s.advance(ANONYMOUS_GAP_MS);
    expect(s.errors).toHaveLength(1);
    expect(s.pusher.pending()).toBe(0);
    expect(s.pusher.decide({ id: 'boom', anonymous: true }, false)).toBe('later');
  });

  it('stop() leaves no timer behind', () => {
    const s = setup();
    s.pusher.decide(anon('a'), false);
    s.pusher.decide(anon('b'), false);
    s.pusher.stop();
    expect(s.pusher.pending()).toBe(0);
    expect(s.timers.every((t) => !t.live)).toBe(true);
  });
});
