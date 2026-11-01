import { HttpError, type PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import type { Deps } from '../src/service.ts';
import { GENERIC_REFUSAL, RETRY_GIVE_UP_MS, SEND_BATCH, refusalOf, sendDue } from '../src/scheduled.ts';

// P14-05: the send job's decisions with the database and the post door replaced by stand-ins, so they run anywhere: one bad row does not block the
// ones after it, a busy door (429) waits without counting as an attempt, a refusal never has an empty reason, the update that marks a refusal is
// tied to the row the send tried, and a run reads page after page. The real post, lock and delete are tested against the database in
// scheduled-send.test.ts.

const NOW = new Date('2030-01-02T12:00:00.000Z');
const AUTHOR = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

interface Query {
  sql: string;
  params: readonly unknown[];
}

function dueRow(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date(NOW.getTime() - 60_000 - n * 1000);
  return {
    id: AUTHOR(n),
    workspace_id: AUTHOR(900),
    author_id: AUTHOR(n),
    channel_id: AUTHOR(800),
    team_id: AUTHOR(700),
    send_at: at,
    send_at_text: at.toISOString().replace('T', ' ').replace('Z', '+00'),
    updated_at_text: `2030-01-02 11:00:00.${String(100000 + n)}+00`,
    ...over,
  };
}

/** Stand-ins: `as` is what the author's own transaction does for each author (a result, or a throw); `refuseUpdate` is the state the refusal UPDATE answers. */
function harness(script: (actorId: string) => unknown, options: { updateState?: string; systemThrowsFor?: string } = {}) {
  const queries: Query[] = [];
  const events: string[] = [];
  const systemTx = (): PluginTx =>
    ({
      query: async (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        if (options.systemThrowsFor && params.includes(options.systemThrowsFor)) throw new Error('database unavailable');
        if (/RETURNING state/.test(sql)) return { rows: [{ state: options.updateState ?? 'refused' }] };
        if (/FROM app\.actors/.test(sql)) return { rows: [{ ref_id: AUTHOR(500) }] };
        return { rows: [] };
      },
    }) as unknown as PluginTx;
  const deps = {
    ctx: {
      db: {
        as: async (caller: { actorId: string }) => {
          const r = script(caller.actorId);
          if (r instanceof Error) throw r;
          return r;
        },
        system: async (fn: (tx: PluginTx) => Promise<unknown>) => fn(systemTx()),
      },
      audit: { emit: async (_tx: unknown, e: { change: string }) => void events.push(e.change) },
      realtime: { pushToPerson: async (_tx: unknown, _p: string, type: string) => void events.push(`push:${type}`) },
    },
  } as unknown as Deps;
  return { deps, queries, events };
}

/** `readTx` giving the pages in turn (and recording what was asked). */
function pages(...all: Array<Array<Record<string, unknown>>>) {
  const asked: Array<readonly unknown[]> = [];
  let i = 0;
  const readTx = async <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> =>
    fn({
      query: async (_sql: string, params: readonly unknown[] = []) => {
        asked.push(params);
        return { rows: all[i++] ?? [] };
      },
    } as unknown as PluginTx);
  return { readTx, asked };
}

const refusedUpdate = (qs: Query[]): Query | undefined => qs.find((q) => /RETURNING state/.test(q.sql));
const deferUpdate = (qs: Query[]): Query | undefined => qs.find((q) => /SET retry_at/.test(q.sql));

describe('refusalOf', () => {
  it('a 4xx from the door is a refusal in the door\'s own words, never an empty one', () => {
    expect(refusalOf(new HttpError(403, 'forbidden', 'You cannot post in this channel'))).toEqual({ kind: 'refused', reason: 'You cannot post in this channel' });
    expect(refusalOf(new HttpError(409, 'conflict', ''))).toEqual({ kind: 'refused', reason: GENERIC_REFUSAL });
    expect(refusalOf(new HttpError(409, 'conflict', '   '))).toEqual({ kind: 'refused', reason: GENERIC_REFUSAL });
  });
  it('a database denial is a refusal; any other error is a failure to be retried', () => {
    expect(refusalOf(Object.assign(new Error('denied'), { code: '42501' }))).toMatchObject({ kind: 'refused' });
    expect(refusalOf(new Error('connection reset'))).toEqual({ kind: 'failed' });
    expect(refusalOf(new HttpError(500, 'internal', 'boom'))).toEqual({ kind: 'failed' });
  });
  it('a 429 is not a refusal: it waits for the time the door names, with a default and a ceiling', () => {
    expect(refusalOf(new HttpError(429, 'rate_limited', 'slow down', { 'retry-after': '30' }))).toEqual({ kind: 'retry', afterMs: 30_000 });
    expect(refusalOf(new HttpError(429, 'rate_limited', 'slow down', { 'Retry-After': '120' }))).toEqual({ kind: 'retry', afterMs: 120_000 });
    expect(refusalOf(new HttpError(429, 'rate_limited', 'slow down'))).toEqual({ kind: 'retry', afterMs: 60_000 });
    expect(refusalOf(new HttpError(429, 'rate_limited', 'slow down', { 'retry-after': '999999' }))).toEqual({ kind: 'retry', afterMs: 3_600_000 });
  });
});

describe('sendDue', () => {
  it('a row whose handling throws is counted and passed over; the rows after it are still sent', async () => {
    const h = harness((id) => (id === AUTHOR(1) ? new Error('db down') : { kind: 'sent' }), { systemThrowsFor: AUTHOR(1) });
    const p = pages([dueRow(1), dueRow(2), dueRow(3)]);
    const warnings: string[] = [];
    const out = await sendDue(h.deps, p.readTx, NOW, { info: () => {}, warn: (m) => warnings.push(m) });
    expect(out).toMatchObject({ sent: 2, errors: 1, refused: 0 });
    expect(warnings).toHaveLength(1);
  });

  it('a failed send is counted as an attempt, and a refusal is marked with the row\'s updated_at so a newer edit is not overwritten', async () => {
    const failing = harness(() => new Error('connection reset'), { updateState: 'scheduled' });
    expect(await sendDue(failing.deps, pages([dueRow(1)]).readTx, NOW)).toMatchObject({ failed: 1, refused: 0 });
    const update = refusedUpdate(failing.queries)!;
    // [id, reason, now, attempts to add, max attempts, generic sentence, updated_at as read]
    expect(update.params[1]).toBeNull();
    expect(update.params[3]).toBe(1);
    expect(update.params[6]).toBe(dueRow(1)['updated_at_text']);
    expect(update.sql).toMatch(/updated_at = \$7::timestamptz/);

    const refusing = harness(() => new HttpError(403, 'forbidden', 'You cannot post in this channel'));
    expect(await sendDue(refusing.deps, pages([dueRow(2)]).readTx, NOW)).toMatchObject({ refused: 1 });
    expect(refusedUpdate(refusing.queries)!.params[1]).toBe('You cannot post in this channel');
    expect(refusing.events).toEqual(['refused', 'push:scheduled.changed']);
  });

  it('a refusal with no words gets the general sentence, never an empty reason', async () => {
    const h = harness(() => new HttpError(409, 'conflict', ''));
    await sendDue(h.deps, pages([dueRow(1)]).readTx, NOW);
    expect(refusedUpdate(h.queries)!.params[1]).toBe(GENERIC_REFUSAL);
  });

  it('a row changed meanwhile (the update matches nothing) is neither refused nor counted as refused', async () => {
    const h = harness(() => new HttpError(403, 'forbidden', 'nope'), { updateState: 'scheduled' });
    const out = await sendDue(h.deps, pages([dueRow(1)]).readTx, NOW);
    expect(out).toMatchObject({ refused: 0, failed: 0 });
    expect(h.events).toEqual([]);
  });

  it('a busy door (429) waits for the time it names, does not count as an attempt, and does not refuse', async () => {
    const h = harness(() => new HttpError(429, 'rate_limited', 'slow down', { 'retry-after': '90' }));
    const out = await sendDue(h.deps, pages([dueRow(1)]).readTx, NOW);
    expect(out).toMatchObject({ deferred: 1, refused: 0, failed: 0 });
    expect(refusedUpdate(h.queries)).toBeUndefined();
    const defer = deferUpdate(h.queries)!;
    expect(defer.params[2]).toEqual(new Date(NOW.getTime() + 90_000));
    expect(defer.sql).not.toMatch(/attempts/);
    expect(defer.params[1]).toBe(dueRow(1)['updated_at_text']);
    expect(h.events).toEqual([]);
  });

  it('a message the door has kept busy for more than a day is refused with a sentence instead of being tried for ever', async () => {
    const old = new Date(NOW.getTime() - RETRY_GIVE_UP_MS - 1000);
    const h = harness(() => new HttpError(429, 'rate_limited', 'slow down'));
    const out = await sendDue(h.deps, pages([dueRow(1, { send_at: old })]).readTx, NOW);
    expect(out).toMatchObject({ refused: 1, deferred: 0 });
    expect(String(refusedUpdate(h.queries)!.params[1])).toMatch(/could not be sent in time/);
  });

  it('reads page after page, each after the last row of the one before, until a short page', async () => {
    const first = Array.from({ length: SEND_BATCH }, (_, i) => dueRow(i + 1));
    const second = [dueRow(SEND_BATCH + 1), dueRow(SEND_BATCH + 2)];
    const h = harness(() => ({ kind: 'sent' }));
    const p = pages(first, second);
    const out = await sendDue(h.deps, p.readTx, NOW);
    expect(out.sent).toBe(SEND_BATCH + 2);
    expect(p.asked).toHaveLength(2);
    expect(p.asked[0]![2]).toBeNull();
    const last = first[first.length - 1]!;
    expect(p.asked[1]!.slice(2)).toEqual([last['send_at_text'], last['id']]);
  });

  it('stops starting new sends when its time budget is spent, leaving the rest for the next run', async () => {
    const h = harness(() => ({ kind: 'sent' }));
    const out = await sendDue(h.deps, pages([dueRow(1), dueRow(2)]).readTx, NOW, undefined, 0);
    expect(out.sent).toBe(0);
  });
});
