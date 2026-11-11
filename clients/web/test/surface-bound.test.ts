import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SURFACE_REGISTRY, type SurfaceDataResponse } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { BOUND_TEXT, SurfaceDataContext, boundDisplay, type SurfaceData } from '../src/surfaces/BoundPart';
import { BUSY_PAUSE_MS, FAILURE_PAUSE_MS, createBoundController, failureOf, intervalMs, type BoundDeps, type BoundState } from '../src/surfaces/bound';
import { Surface } from '../src/surfaces/Surface';

// Bound parts (PLAN P9-06): what is drawn before, without and after data, that values are drawn as text, and the rules of refreshing, run against a fake clock.

const SOURCE = [
  'root = Stack([open, count])',
  'open = Table(["Title", "State"], [["placeholder", "-"]], "Cards", {tool: "tasks.read", into: {rows: "tasks[].[title,state]"}, refreshSeconds: 30})',
  'count = Stat("Cards", "none yet", null, null, {tool: "tasks.read", into: {value: "tasks.length"}})',
  '',
].join('\n');
const WITH_READER: SurfaceData = { read: () => new Promise<SurfaceDataResponse>(() => undefined), version: 1, answered: 0, dataTick: 0, explain: () => ({ message: 'x', code: 'unavailable' }) };
const draw = (source: string, data?: SurfaceData): string => {
  const el = createElement(Surface, { source, ended: true });
  return renderToStaticMarkup(data ? createElement(SurfaceDataContext.Provider, { value: data }, el) : el);
};

describe('a bound part before it has data', () => {
  it('with a reader, it shows one plain sentence in place of the placeholder and says it is busy', () => {
    const html = draw(SOURCE, WITH_READER);
    expect(html.split('data-testid="surface-bound"').length - 1).toBe(2);
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(BOUND_TEXT.loading);
    expect(html).not.toContain('placeholder');
    expect(html).not.toContain('none yet');
  });
  it('without a reader (a preview), it draws what the bot wrote and says live data is not shown', () => {
    const html = draw(SOURCE);
    expect(html).toContain('data-state="static"');
    expect(html).toContain('placeholder');
    expect(html).toContain('none yet');
    expect(html).toContain(BOUND_TEXT.noReader);
    expect(html).not.toContain('aria-busy');
  });
  it('a part with no binding is drawn exactly as before, with no wrapper', () => {
    const html = draw('root = Stat("Cards", "3")\n', WITH_READER);
    expect(html).not.toContain('surface-bound');
  });
  it('never shows the tool, the arguments or the selectors', () => {
    for (const html of [draw(SOURCE), draw(SOURCE, WITH_READER)]) {
      expect(html).not.toContain('tasks.read');
      expect(html).not.toContain('tasks[]');
      expect(html).not.toContain('refreshSeconds');
    }
  });
});

describe('what a part shows for each state', () => {
  const def = SURFACE_REGISTRY.get('Table')!;
  const parse = (m: Record<string, unknown>) => def.props.safeParse(m);
  const written = { columns: ['Title', 'State'], rows: [['placeholder', '-']], caption: 'Cards' };
  const show = (state: BoundState) => boundDisplay(state, written, parse);

  it('loading and empty show a sentence and no part', () => {
    expect(show({ kind: 'loading' })).toEqual({ props: null, note: BOUND_TEXT.loading, tone: 'info' });
    expect(show({ kind: 'empty' })).toEqual({ props: null, note: BOUND_TEXT.empty, tone: 'info' });
  });
  it('ok draws the part with the values over the placeholders', () => {
    const r = show({ kind: 'ok', props: { rows: [['A', 'open']] }, fetchedAt: 'now' });
    expect(r.note).toBeNull();
    expect(r.props).toEqual({ columns: ['Title', 'State'], rows: [['A', 'open']], caption: 'Cards' });
  });
  it('values that do not fit the part are not drawn, the page checks again', () => {
    const r = show({ kind: 'ok', props: { rows: [['a', 'b', 'c']] }, fetchedAt: 'now' });
    expect(r).toEqual({ props: null, note: BOUND_TEXT.misfit, tone: 'error' });
  });
  it('an error with no earlier data shows the reason; with earlier data it keeps showing it, with a note', () => {
    expect(show({ kind: 'error', message: 'Could not load this data.', code: 'unavailable' })).toEqual({ props: null, note: 'Could not load this data.', tone: 'error' });
    const kept = show({ kind: 'error', message: 'x', code: 'unavailable', last: { rows: [['A', 'open']] } });
    expect(kept.props).toMatchObject({ rows: [['A', 'open']] });
    expect(kept.note).toBe(BOUND_TEXT.stale);
    expect(kept.tone).toBe('error');
  });
});

describe('failures are told in plain words', () => {
  const status = (n: number | null) => () => n;
  it('maps what the server said', () => {
    expect(failureOf(new Error('x'), status(409))).toMatchObject({ stale: true });
    expect(failureOf(new Error('x'), status(429))).toMatchObject({ code: 'busy', retryMs: BUSY_PAUSE_MS });
    expect(failureOf(new Error('x'), status(403))).toMatchObject({ code: 'forbidden' });
    expect(failureOf(new Error('x'), status(404))).toMatchObject({ code: 'forbidden' });
    expect(failureOf(new Error('x'), status(500))).toMatchObject({ code: 'unavailable', message: 'Could not load this data.' });
    expect(failureOf(new Error('x'), status(null))).toMatchObject({ code: 'unavailable' });
  });
});

// A fake clock and a reader we can answer by hand -----------------------------------------------------------------------------

const OK = (n: number): SurfaceDataResponse => ({ state: 'ok', props: { value: String(n) }, fetchedAt: `t${n}` });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function rig(refreshSeconds: number | undefined) {
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
    get timers() {
      return timers.size;
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

describe('refreshing', () => {
  it('never faster than every 10 seconds', () => {
    expect(intervalMs(undefined)).toBeNull();
    expect(intervalMs(1)).toBe(10_000);
    expect(intervalMs(30)).toBe(30_000);
  });

  it('reads when it appears, then on the clock', async () => {
    const r = rig(30);
    r.c.start();
    expect(r.reads).toBe(1);
    await r.answer(OK(1));
    expect(r.states.at(-1)).toMatchObject({ kind: 'ok', fetchedAt: 't1' });
    await r.advance(29_000);
    expect(r.reads).toBe(1);
    await r.advance(1_000);
    expect(r.reads).toBe(2);
    await r.answer(OK(2));
    await r.advance(30_000);
    expect(r.reads).toBe(3);
  });

  it('a part with no interval reads once and is not retried by itself, even after a failure', async () => {
    const r = rig(undefined);
    r.c.start();
    await r.refuse({ status: 500 });
    expect(r.states.at(-1)).toMatchObject({ kind: 'error', code: 'unavailable' });
    expect(r.timers).toBe(0);
    await r.advance(10 * 60_000);
    expect(r.reads).toBe(1);
    r.c.refresh();
    expect(r.reads).toBe(2);
  });

  it('a tab that is hidden does not read, keeps no timer, and reads at once when shown if a read was missed', async () => {
    const r = rig(30);
    r.c.start();
    await r.answer(OK(1));
    r.setVisible(false);
    expect(r.timers).toBe(0);
    await r.advance(5 * 60_000);
    expect(r.reads).toBe(1);
    r.setVisible(true);
    expect(r.reads).toBe(2);
    await r.answer(OK(2));
  });

  it('shown again soon after a read, it does not read again, it waits for the rest of the interval', async () => {
    const r = rig(30);
    r.c.start();
    await r.answer(OK(1));
    await r.advance(5_000);
    r.setVisible(false);
    r.setVisible(true);
    expect(r.reads).toBe(1);
    expect(r.timers).toBe(1);
  });

  it('a timer that fires while hidden reads nothing and is made up when shown', async () => {
    const r = rig(30);
    r.c.start();
    await r.answer(OK(1));
    // the browser hides the tab without telling us first
    r.setVisible(false);
    r.setVisible(true);
    await r.advance(30_000);
    expect(r.reads).toBe(2);
  });

  it('never has two reads in flight: a request meanwhile is made once the first is back', async () => {
    const r = rig(30);
    r.c.start();
    r.c.refresh();
    r.c.refresh();
    expect(r.reads).toBe(1);
    await r.answer(OK(1));
    expect(r.reads).toBe(2);
    await r.answer(OK(2));
    expect(r.reads).toBe(2);
  });

  it('after a failure it waits at least 30 seconds, and a minute when the server said it was asked too often', async () => {
    const r = rig(10);
    r.c.start();
    await r.refuse({ status: 500 });
    await r.advance(FAILURE_PAUSE_MS - 1);
    expect(r.reads).toBe(1);
    await r.advance(1);
    expect(r.reads).toBe(2);
    await r.refuse({ status: 429 });
    await r.advance(BUSY_PAUSE_MS - 1);
    expect(r.reads).toBe(2);
    await r.advance(1);
    expect(r.reads).toBe(3);
    // and goes back to its own pace after a good read
    await r.answer(OK(3));
    await r.advance(10_000);
    expect(r.reads).toBe(4);
  });

  it('a failure after good data keeps that data and says so; an error state from the server does too', async () => {
    const r = rig(10);
    r.c.start();
    await r.answer(OK(1));
    await r.advance(10_000);
    await r.refuse({ status: 500 });
    expect(r.states.at(-1)).toMatchObject({ kind: 'error', last: { value: '1' } });
    await r.advance(FAILURE_PAUSE_MS);
    await r.answer({ state: 'error', code: 'timeout', message: 'slow', fetchedAt: 'x' });
    expect(r.states.at(-1)).toMatchObject({ kind: 'error', code: 'timeout', last: { value: '1' } });
  });

  it('an empty answer clears what was kept', async () => {
    const r = rig(10);
    r.c.start();
    await r.answer(OK(1));
    await r.advance(10_000);
    await r.answer({ state: 'empty', fetchedAt: 'x' });
    expect(r.states.at(-1)).toEqual({ kind: 'empty' });
    await r.advance(10_000);
    await r.refuse({ status: 500 });
    expect(r.states.at(-1)).not.toHaveProperty('last');
  });

  it('a 409 means the screen moved on: it says nothing and the new version reads by itself', async () => {
    const r = rig(10);
    r.c.start();
    const before = r.states.length;
    await r.refuse({ status: 409 });
    expect(r.states.length).toBe(before);
  });

  it('stop ends the timer and ignores a read still on its way', async () => {
    const r = rig(10);
    r.c.start();
    r.c.stop();
    await r.answer(OK(1));
    expect(r.states).toEqual([]);
    expect(r.timers).toBe(0);
    await r.advance(60_000);
    expect(r.reads).toBe(1);
  });
});
