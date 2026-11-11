import type { SurfaceDataResponse } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { FAILURE_PAUSE_MS, createBoundController, failureOf, surfacePushAction, type BoundDeps, type BoundState } from '../../src/surfaces/bound';

// A push that says "the data of this screen may have changed" (PLAN P22-03, `reason: "data"`) makes each bound part read again: once for one push, at most twice for a
// burst while a read is in flight, and never inside a failure pause. Fake clock, reads answered by hand.

const OK = (n: number): SurfaceDataResponse => ({ state: 'ok', props: { value: String(n) }, fetchedAt: `t${n}` });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function rig(refreshSeconds?: number) {
  let now = 0;
  let visible = true;
  let reads = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const states: BoundState[] = [];
  const pending: Array<{ resolve: (r: SurfaceDataResponse) => void; reject: (e: unknown) => void }> = [];
  const deps: BoundDeps = {
    read: () => {
      reads++;
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    fail: (e) => failureOf(e, (x) => (x as { status?: number }).status ?? null),
    visible: () => visible,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
    onState: (s) => states.push(s),
  };
  const c = createBoundController(refreshSeconds, deps);
  return {
    c,
    states,
    get reads() {
      return reads;
    },
    get inFlight() {
      return pending.length;
    },
    setVisible: (v: boolean) => {
      visible = v;
      c.visibilityChanged();
    },
    answer: async (r: SurfaceDataResponse) => {
      pending.shift()!.resolve(r);
      await flush();
    },
    refuse: async (e: unknown) => {
      pending.shift()!.reject(e);
      await flush();
    },
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
    },
  };
}

describe('a data push makes a bound part read again', () => {
  it('one push, one read', async () => {
    const r = rig();
    r.c.start();
    await r.answer(OK(1));
    expect(r.reads).toBe(1);
    r.c.dataChanged();
    expect(r.reads).toBe(2);
    await r.answer(OK(2));
    expect(r.states.at(-1)).toMatchObject({ kind: 'ok', fetchedAt: 't2' });
    expect(r.reads).toBe(2);
  });

  it('a burst of five pushes while a read is in flight makes two reads, the second after the first is back', async () => {
    const r = rig();
    r.c.start();
    await r.answer(OK(1));
    r.c.dataChanged();
    expect(r.reads).toBe(2);
    for (let i = 0; i < 5; i++) r.c.dataChanged();
    expect(r.reads).toBe(2);
    await r.answer(OK(2));
    expect(r.reads).toBe(3);
    await r.answer(OK(3));
    expect(r.reads).toBe(3);
    expect(r.inFlight).toBe(0);
    expect(r.states.at(-1)).toMatchObject({ kind: 'ok', fetchedAt: 't3' });
  });

  it('a push while the first read is still on its way is not lost: it reads once more', async () => {
    const r = rig();
    r.c.start();
    r.c.dataChanged();
    expect(r.reads).toBe(1);
    await r.answer(OK(1));
    expect(r.reads).toBe(2);
  });

  it('after a failed read it waits out the failure pause, once, however many pushes come', async () => {
    const r = rig();
    r.c.start();
    await r.refuse({ status: 500 });
    expect(r.states.at(-1)).toMatchObject({ kind: 'error', code: 'unavailable' });
    for (let i = 0; i < 5; i++) r.c.dataChanged();
    expect(r.reads).toBe(1);
    await r.advance(FAILURE_PAUSE_MS - 1);
    expect(r.reads).toBe(1);
    await r.advance(1);
    expect(r.reads).toBe(2);
    await r.answer(OK(2));
    expect(r.states.at(-1)).toMatchObject({ kind: 'ok' });
    // the pause is over with a good read: the next push reads at once
    r.c.dataChanged();
    expect(r.reads).toBe(3);
  });

  it('a push after the pause has passed reads at once', async () => {
    const r = rig();
    r.c.start();
    await r.refuse({ status: 500 });
    await r.advance(FAILURE_PAUSE_MS);
    r.c.dataChanged();
    expect(r.reads).toBe(2);
  });

  it('a push while the tab is hidden reads nothing; the part reads when the tab is shown', async () => {
    const r = rig(30);
    r.c.start();
    await r.answer(OK(1));
    r.setVisible(false);
    r.c.dataChanged();
    expect(r.reads).toBe(1);
    r.setVisible(true);
    expect(r.reads).toBe(2);
  });

  it('a part that has been stopped ignores a push', async () => {
    const r = rig();
    r.c.start();
    await r.answer(OK(1));
    r.c.stop();
    r.c.dataChanged();
    expect(r.reads).toBe(1);
  });
});

describe('what a surfaces.changed push asks of the page', () => {
  const parse = (payload: unknown) => {
    const p = payload as { surfaceId?: string; reason?: 'data' } | null;
    return p && typeof p.surfaceId === 'string' ? { surfaceId: p.surfaceId, ...(p.reason ? { reason: p.reason } : {}) } : null;
  };
  it('a push without a reason loads the screen again; a data push only refreshes the bound parts', () => {
    expect(surfacePushAction(parse, { surfaceId: 's1' }, 's1')).toBe('load');
    expect(surfacePushAction(parse, { surfaceId: 's1', reason: 'data' }, 's1')).toBe('data');
  });
  it('a push for another screen, or one that does not parse, asks nothing', () => {
    expect(surfacePushAction(parse, { surfaceId: 's2', reason: 'data' }, 's1')).toBe('none');
    expect(surfacePushAction(parse, { surfaceId: 's2' }, 's1')).toBe('none');
    expect(surfacePushAction(parse, null, 's1')).toBe('none');
  });
});
