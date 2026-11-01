import { HttpError, type PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { CLOSE_BATCH, closeDue } from '../src/polls.ts';
import type { Deps } from '../src/service.ts';

// P14-07: the close job's decisions with the database and the post door replaced by stand-ins, so they run anywhere. Each due poll is closed in a
// person's own transaction: the author's, and when the author can no longer post, a workspace admin's; when nobody can, the system closes it quietly
// (never left open past its time). One bad row does not block the rows after it, a busy door or a database failure leaves the poll for the next
// minute, and a run reads page after page. The real lock, the real result message and the vote refusal after the time are tested against the
// database in polls.test.ts.

const NOW = new Date('2030-01-02T12:00:00.000Z');
const ID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function dueRow(n: number): Record<string, unknown> {
  return { id: ID(n), workspace_id: ID(900), author_id: ID(n), channel_id: ID(800) };
}

function pollRow(id: string): Record<string, unknown> {
  return {
    id,
    workspace_id: ID(900),
    channel_id: ID(800),
    message_id: ID(801),
    author_id: ID(1),
    question: 'Q',
    options: ['A', 'B'],
    multiple: false,
    anonymous: true,
    closes_at: NOW,
    closed_at: NOW,
    result_message_id: null,
    vote_counts: [1, 0],
    voter_count: 1,
    version: 4,
    closed: true,
    mine: null,
  };
}

type Attempt = { closed: boolean; cannotPost: boolean };
const CLOSED: Attempt = { closed: true, cannotPost: false };
const ALREADY: Attempt = { closed: false, cannotPost: false };
const CANNOT_POST: Attempt = { closed: false, cannotPost: true };

/** `script` is what each person's own transaction answers (the real close is tested against the database): an outcome or a throw. */
function harness(script: (actorId: string) => Attempt | Error) {
  const queries: string[] = [];
  const events: string[] = [];
  const tried: string[] = [];
  const systemTx = (): PluginTx =>
    ({
      query: async (sql: string, params: readonly unknown[] = []) => {
        queries.push(sql);
        if (/UPDATE app\.polls/.test(sql)) return { rows: [{ team_id: ID(700), message_id: ID(801), voter_count: 1 }] };
        if (/channel_audience/.test(sql)) return { rows: [{ person_id: ID(2) }] };
        if (/FROM app\.polls p/.test(sql)) return { rows: [pollRow(String(params[0]))] };
        return { rows: [] };
      },
    }) as unknown as PluginTx;
  const deps = {
    ctx: {
      db: {
        // the stand-in does not run the callback: the answer comes from the script, as the real close would give it
        as: async (caller: { actorId: string; kind: string }) => {
          expect(caller.kind).toBe('person');
          tried.push(caller.actorId);
          const r = script(caller.actorId);
          if (r instanceof Error) throw r;
          return r;
        },
        system: async (fn: (tx: PluginTx) => Promise<unknown>) => fn(systemTx()),
      },
      audit: { emit: async (_tx: unknown, e: { type: string; reason?: string; resultMessageId?: unknown }) => void events.push(`${e.type}:${e.reason}:${String(e.resultMessageId)}`) },
      realtime: { pushToPeople: async (_tx: unknown, _p: unknown, type: string) => void events.push(`push:${type}`) },
    },
  } as unknown as Deps;
  return { deps, queries, events, tried };
}

const noAdmins = async (): Promise<string[]> => [];

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

describe('closeDue', () => {
  it('asks only for polls that are open, have a time, and whose time has come, by that clock', async () => {
    const p = pages([]);
    await closeDue(harness(() => CLOSED).deps, p.readTx, NOW, undefined, undefined, noAdmins);
    expect(p.asked[0]).toEqual([NOW, CLOSE_BATCH]);
  });

  it('closes each poll as its author and counts them', async () => {
    const h = harness(() => CLOSED);
    const out = await closeDue(h.deps, pages([dueRow(1), dueRow(2)]).readTx, NOW, undefined, undefined, noAdmins);
    expect(out).toEqual({ closed: 2, closedByAdmin: 0, closedQuietly: 0, errors: 0 });
    expect(h.tried).toEqual([ID(1), ID(2)]);
    expect(h.events).toEqual([]); // the events of a normal close come from the person's transaction, not from this loop
  });

  it('a poll another run already closed is not counted again, and nobody else is asked', async () => {
    const h = harness(() => ALREADY);
    const out = await closeDue(h.deps, pages([dueRow(1)]).readTx, NOW, undefined, undefined, async () => [ID(50)]);
    expect(out).toEqual({ closed: 0, closedByAdmin: 0, closedQuietly: 0, errors: 0 });
    expect(h.tried).toEqual([ID(1)]);
  });

  it('an author who can no longer post: an admin of the workspace posts the result instead', async () => {
    const h = harness((id) => (id === ID(1) ? CANNOT_POST : CLOSED));
    const out = await closeDue(h.deps, pages([dueRow(1)]).readTx, NOW, undefined, undefined, async () => [ID(1), ID(50), ID(51)]);
    expect(out).toEqual({ closed: 0, closedByAdmin: 1, closedQuietly: 0, errors: 0 });
    expect(h.tried).toEqual([ID(1), ID(50)]); // the author is not asked twice, and the second admin is not needed
    expect(h.events).toEqual([]);
  });

  it('the first admin cannot post either: the next one does; an author refused outright (403) is treated the same way', async () => {
    const h = harness((id) => (id === ID(1) ? new HttpError(403, 'forbidden', 'You cannot see this channel') : id === ID(50) ? CANNOT_POST : CLOSED));
    const out = await closeDue(h.deps, pages([dueRow(1)]).readTx, NOW, undefined, undefined, async () => [ID(50), ID(51)]);
    expect(out).toMatchObject({ closedByAdmin: 1, closedQuietly: 0, errors: 0 });
    expect(h.tried).toEqual([ID(1), ID(50), ID(51)]);
  });

  it('nobody who can post is left: the poll is closed by the system, quietly, with a closed event that has no result message', async () => {
    const h = harness((id) => (id === ID(1) ? new HttpError(403, 'forbidden', 'You cannot post in this channel') : CLOSED));
    const out = await closeDue(h.deps, pages([dueRow(1), dueRow(2)]).readTx, NOW, undefined, undefined, noAdmins);
    expect(out).toEqual({ closed: 1, closedByAdmin: 0, closedQuietly: 1, errors: 0 });
    expect(h.events).toEqual(['channel.poll.closed:time:null', 'push:poll.changed']);
    expect(h.queries.some((q) => /closed_by = NULL/.test(q))).toBe(true);
  });

  it('an author and every admin who cannot post: still closed, never left open', async () => {
    const h = harness(() => CANNOT_POST);
    const out = await closeDue(h.deps, pages([dueRow(1)]).readTx, NOW, undefined, undefined, async () => [ID(50)]);
    expect(out).toMatchObject({ closed: 0, closedByAdmin: 0, closedQuietly: 1, errors: 0 });
  });

  it('a database denial for the author is handled the same way as a refusal', async () => {
    const out = await closeDue(harness(() => Object.assign(new Error('denied'), { code: '42501' })).deps, pages([dueRow(1)]).readTx, NOW, undefined, undefined, noAdmins);
    expect(out).toMatchObject({ closedQuietly: 1, errors: 0 });
  });

  it('a busy post door (429) or a database failure leaves the poll for the next minute and does not block the others', async () => {
    const h = harness((id) => (id === ID(1) ? new HttpError(429, 'rate_limited', 'slow down') : id === ID(2) ? new Error('connection reset') : CLOSED));
    const warnings: string[] = [];
    const log = { info: () => {}, warn: (m: string) => warnings.push(m) } as never;
    const out = await closeDue(h.deps, pages([dueRow(1), dueRow(2), dueRow(3)]).readTx, NOW, log, undefined, async () => [ID(50)]);
    expect(out).toEqual({ closed: 1, closedByAdmin: 0, closedQuietly: 0, errors: 2 });
    expect(warnings).toHaveLength(2);
    expect(h.tried).toEqual([ID(1), ID(2), ID(3)]); // a busy door does not send the poll to an admin
    expect(h.events).toEqual([]);
  });

  it('reads page after page until a short page, and stops when a whole page could not be closed', async () => {
    const full = Array.from({ length: CLOSE_BATCH }, (_, i) => dueRow(i + 1));
    const h = harness(() => CLOSED);
    const p = pages(full, [dueRow(CLOSE_BATCH + 1)]);
    expect((await closeDue(h.deps, p.readTx, NOW, undefined, undefined, noAdmins)).closed).toBe(CLOSE_BATCH + 1);
    expect(p.asked).toHaveLength(2);

    const stuck = harness(() => new Error('down'));
    const q = pages(full, full, full);
    const out = await closeDue(stuck.deps, q.readTx, NOW, undefined, undefined, noAdmins);
    expect(out.errors).toBe(CLOSE_BATCH);
    expect(q.asked).toHaveLength(1);
  });

  it('stops starting new closes when its time budget is spent', async () => {
    const out = await closeDue(harness(() => CLOSED).deps, pages([dueRow(1), dueRow(2)]).readTx, NOW, undefined, 0, noAdmins);
    expect(out.closed).toBe(0);
  });
});
