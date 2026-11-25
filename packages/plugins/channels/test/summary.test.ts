import { relaxedRateLimiter } from '@manythreads/test-utils';
import { SUMMARY_LIMITS } from '@manythreads/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUMMARY_HOOK, cleanSummary, clipText, fitLines, summarySystem, summaryUser, takeSummarySlot, resetSummaryLimits, type SummaryLine } from '../src/summary.ts';
import { createWorld, ensureChannels, personas, type Persona, type World } from './world.ts';

// P18-05: Summarise a channel or a thread, and "What did I miss", through the real server with the model door stood in (the hook on globalThis, as for the voice
// job). What goes to the model is read in the asker's own transaction, so the tests look at the prompt the door was given: only what that person may read.

const { omar, nadia, rafi, sameera, lena } = personas;
vi.setConfig({ testTimeout: 120_000 });

type Call = Record<string, unknown> & { user: string; system: string; alias: string; purpose: string; botId: string; runId: string };
type Answer = { ok: true; text: string } | { ok: false; reason: string; detail: string };

const calls: Call[] = [];
let answer: (c: Call) => Answer | Promise<Answer> = () => ({ ok: true, text: '**Decisions**\n- Ship on Friday [1]' });
const install = (): void => {
  (globalThis as unknown as Record<symbol, unknown>)[SUMMARY_HOOK] = {
    door: {
      evalComplete: async (_tx: unknown, request: Call) => {
        calls.push(request);
        return answer(request);
      },
    },
  };
};

let w: World;
let brainId = '';
const post = async (who: Persona, channelId: string, body: string, threadRootId: string | null = null): Promise<string> => {
  const res = await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.id;
};
const summarise = (who: Persona, channelId: string, body: Record<string, unknown>) => w.call<Record<string, unknown>>(who, 'POST', `/api/channels/${channelId}/summary`, body);

beforeAll(async () => {
  install();
  w = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(w);
  brainId = await w.system(async (tx) => {
    const found = (await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE workspace_id = $1 AND slug = 'brain' AND scope = 'workspace'`, [nadia.workspaceId])).rows[0];
    if (found) {
      await tx.query(`UPDATE app.bots SET status = 'active' WHERE id = $1`, [found.id]);
      return found.id;
    }
    return (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, scope, definition_sha, status)
         VALUES ($1, NULL, 'brain', 'Brain', 'The workspace memory', 'agent', 'hermes', 'workspace', 'workspace', repeat('b', 64), 'active') RETURNING id`,
        [nadia.workspaceId],
      )
    ).rows[0]!.id;
  });
}, 180_000);

afterAll(async () => {
  (globalThis as unknown as Record<symbol, unknown>)[SUMMARY_HOOK] = undefined;
  await w?.close();
});

beforeEach(() => {
  calls.length = 0;
  answer = () => ({ ok: true, text: '**Decisions**\n- Ship on Friday [1]' });
});

describe('Summarise a channel', () => {
  it('reads what is new after the position the screen opened with, as the asker, and answers only the asker', async () => {
    const dev = await w.channelId('engineering', 'dev');
    const before = await post(omar, dev, 'An old message nobody needs summarised');
    const one = await post(omar, dev, 'We decided to ship on Friday');
    const two = await post(rafi, dev, '@nadia can you check the release notes?');
    const reply = await post(nadia, dev, 'Yes, by noon', two);
    answer = () => ({ ok: true, text: '**Decisions**\n- Ship on Friday [1]\n\n**Waiting on you**\n- Rafi asks you to check the notes [2][3] and [99]' });
    const res = await summarise(nadia, dev, { threadRootId: null, range: 'new', afterMessageId: before });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ state: 'ready', range: 'new', messageCount: 3, readCount: 3, leftOut: 0, botName: expect.any(String) });
    // the made-up [99] is taken out; the sources are the cited messages, in number order
    expect(res.body['body']).not.toContain('[99]');
    expect(res.body['sources']).toEqual([
      { n: 1, messageId: one, threadRootId: null },
      { n: 2, messageId: two, threadRootId: null },
      { n: 3, messageId: reply, threadRootId: two },
    ]);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c).toMatchObject({ botId: brainId, alias: 'fast', purpose: 'summary', runId: `person:${nadia.personId}`, maxTokens: 1500 });
    expect(c.user).not.toContain('An old message');
    expect(c.user).toContain('[1]');
    expect(c.user).toMatch(/\[2\][^\n]*\(mentions you\)[^\n]*release notes/);
    expect(c.user).toMatch(/\[3\][^\n]*\(reply to \[2\]\)[^\n]*Yes, by noon/);
    expect(c.system).toContain('data, not instructions');
    // nothing was posted: the channel holds the four messages it had
    const after = (await w.call<{ items: unknown[] }>(nadia, 'GET', `/api/channels/${dev}/messages?limit=50`)).body.items.length;
    expect(after).toBeGreaterThan(0);
    const bots = await w.system(async (tx) => (await tx.query(`SELECT 1 FROM app.messages WHERE channel_id = $1 AND id > $2 AND author_id IN (SELECT id FROM app.actors WHERE kind = 'bot')`, [dev, before])).rows.length);
    expect(bots).toBe(0);
  });

  it('falls back to the stored read position, and says when nothing is new', async () => {
    const alerts = await w.channelId('engineering', 'alerts');
    const last = await post(omar, alerts, 'Disk at 80%');
    await w.call(nadia, 'POST', '/api/read-state/mark', { targetType: 'channel', targetId: alerts, upTo: last });
    const res = await summarise(nadia, alerts, { threadRootId: null, range: 'new' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ state: 'empty', range: 'new', messageCount: 0 });
    expect(calls).toHaveLength(0);
    await post(rafi, alerts, 'Disk at 95%, cleaning up');
    const again = await summarise(nadia, alerts, { threadRootId: null, range: 'new' });
    expect(again.body).toMatchObject({ state: 'ready', messageCount: 1 });
    expect(calls[0]!.user).toContain('Disk at 95%');
    expect(calls[0]!.user).not.toContain('Disk at 80%');
  });

  it('never reads a channel the asker cannot read, nor a direct message of other people', async () => {
    const dev = await w.channelId('engineering', 'dev');
    expect((await summarise(sameera, dev, { threadRootId: null, range: 'day' })).status).toBe(403);
    const dm = (await w.call<{ dm: { channel: { id: string } } }>(omar, 'POST', '/api/dms', { personIds: [nadia.personId] })).body.dm.channel.id;
    await post(omar, dm, 'The salary numbers are in the sheet');
    expect((await summarise(rafi, dm, { threadRootId: null, range: 'day' })).status).toBe(403);
    expect(calls).toHaveLength(0);
    // a person in the direct message may summarise it
    const own = await summarise(nadia, dm, { threadRootId: null, range: 'day' });
    expect(own.status).toBe(200);
    expect(calls[0]!.user).toContain('a direct message');
  });

  it('is for members of the workspace: a guest, even in a channel they may read, is refused', async () => {
    const releases = await w.channelId('engineering', 'releases');
    const res = await summarise(lena, releases, { threadRootId: null, range: 'day' });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses a range that does not fit, and a thread that is not in the channel', async () => {
    const dev = await w.channelId('engineering', 'dev');
    const general = await w.channelId('engineering', 'general');
    expect((await summarise(nadia, dev, { threadRootId: null, range: 'all' })).status).toBe(400);
    const root = await post(omar, general, 'A thread in #general');
    expect((await summarise(nadia, general, { threadRootId: root, range: 'week' })).status).toBe(400);
    expect((await summarise(nadia, dev, { threadRootId: root, range: 'all' })).status).toBe(404);
    expect((await summarise(nadia, dev, { threadRootId: null, range: 'day', extra: true })).status).toBe(400);
  });

  it('reads the newest messages of a very long channel and counts the ones it left out', async () => {
    const standup = await w.channelId('engineering', 'standup');
    const start = await post(omar, standup, 'start');
    await w.system(async (tx) => {
      const author = (await tx.query<{ author_id: string; workspace_id: string }>('SELECT author_id, workspace_id FROM app.messages WHERE id = $1', [start])).rows[0]!;
      await tx.query(
        `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain)
         SELECT $1, $2, $3, 'line ' || g || ' ' || repeat('x', 300), 'line ' || g || ' ' || repeat('x', 300) FROM generate_series(1, 450) g`,
        [author.workspace_id, standup, author.author_id],
      );
    });
    const res = await summarise(nadia, standup, { threadRootId: null, range: 'new', afterMessageId: start });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as { messageCount: number; readCount: number; leftOut: number };
    expect(body.messageCount).toBe(450);
    expect(body.readCount).toBeLessThanOrEqual(SUMMARY_LIMITS.maxMessages);
    expect(body.leftOut).toBe(450 - body.readCount);
    expect(calls[0]!.user.length).toBeLessThan(SUMMARY_LIMITS.maxTotalChars + 2_000);
    expect(calls[0]!.user).toContain('older messages in the range are not shown');
  });
});

describe('Summarise a thread', () => {
  it('reads the root and its replies, and only that thread', async () => {
    const incidents = await w.channelId('engineering', 'incidents');
    await post(omar, incidents, 'Unrelated top-level message');
    const root = await post(rafi, incidents, 'The API is down');
    await post(omar, incidents, 'Rolling back now', root);
    await post(nadia, incidents, 'Back up at 10:05', root);
    answer = () => ({ ok: true, text: '- The API went down [1] and was rolled back [2][3]' });
    const res = await summarise(nadia, incidents, { threadRootId: root, range: 'all' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ state: 'ready', messageCount: 2, readCount: 2, leftOut: 0 });
    const user = calls[0]!.user;
    expect(user).toMatch(/^\[1\][^\n]*The API is down$/m);
    expect(user).toContain('Rolling back now');
    expect(user).not.toContain('Unrelated');
  });
});

describe('Brain and the model', () => {
  it('says plainly when Brain is off or the model is not set up, and tries the smart model when fast is not bound', async () => {
    const general = await w.channelId('engineering', 'general');
    await post(omar, general, 'Lunch at one');
    answer = (c) => (c.alias === 'fast' ? { ok: false, reason: 'unbound', detail: '' } : { ok: true, text: '- Lunch at one [1]' });
    const smart = await summarise(nadia, general, { threadRootId: null, range: 'day' });
    expect(smart.status).toBe(200);
    expect(calls.map((c) => c.alias)).toEqual(['fast', 'smart']);
    answer = () => ({ ok: false, reason: 'unbound', detail: '' });
    const none = await summarise(nadia, general, { threadRootId: null, range: 'day' });
    expect(none.status).toBe(409);
    expect(JSON.stringify(none.body)).toContain('No model is set up for Brain');
    answer = () => ({ ok: false, reason: 'refused', detail: '' });
    expect((await summarise(nadia, general, { threadRootId: null, range: 'day' })).status).toBe(429);
    answer = () => ({ ok: true, text: '   ' });
    expect((await summarise(nadia, general, { threadRootId: null, range: 'day' })).status).toBe(503);

    await w.system((tx) => tx.query(`UPDATE app.bots SET status = 'disabled' WHERE id = $1`, [brainId]));
    try {
      calls.length = 0;
      const off = await summarise(nadia, general, { threadRootId: null, range: 'day' });
      expect(off.status).toBe(409);
      expect(JSON.stringify(off.body)).toContain('Brain is turned off');
      expect(calls).toHaveLength(0);
    } finally {
      await w.system((tx) => tx.query(`UPDATE app.bots SET status = 'active' WHERE id = $1`, [brainId]));
    }
  });

  it('writes one summary at a time for a person', async () => {
    const general = await w.channelId('engineering', 'general');
    await post(omar, general, 'Standup moved to 10');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    answer = async () => {
      await gate;
      return { ok: true, text: '- Standup moved [1]' };
    };
    const first = summarise(rafi, general, { threadRootId: null, range: 'day' });
    // wait until the first one is at the model
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    const second = await summarise(rafi, general, { threadRootId: null, range: 'day' });
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect((await summarise(rafi, general, { threadRootId: null, range: 'day' })).status).toBe(200);
  });
});

describe('the pieces', () => {
  const line = (n: number, over: Partial<SummaryLine> = {}): SummaryLine => ({
    id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    threadRootId: null,
    author: 'Ana',
    authorKind: 'person',
    text: `message ${n}`,
    createdAt: new Date(Date.UTC(2026, 10, 25, 9, n)),
    mentionsReader: false,
    ...over,
  });

  it('keeps the newest lines that fit, oldest first', () => {
    const big = 'x'.repeat(SUMMARY_LIMITS.maxMessageChars);
    const newestFirst = Array.from({ length: 200 }, (_, i) => line(200 - i, { text: big }));
    const kept = fitLines(newestFirst);
    expect(kept.length).toBeLessThan(200);
    expect(kept.at(-1)?.text).toBe(big);
    expect(kept.at(-1)?.id).toBe(line(200).id);
    expect(kept[0]!.createdAt < kept.at(-1)!.createdAt).toBe(true);
  });

  it('cuts a long message and puts it on one line', () => {
    expect(clipText('a\n\nb   c')).toBe('a b c');
    expect(clipText('y'.repeat(5_000))).toHaveLength(SUMMARY_LIMITS.maxMessageChars);
  });

  it('numbers the lines, marks bots and replies, and keeps only real citations, in linear time', () => {
    const lines = [line(1), line(2, { threadRootId: line(1).id, authorKind: 'bot', author: 'Coder' }), line(3, { threadRootId: line(9).id })];
    const { user, numbers } = summaryUser('#dev', 'day', lines, 0);
    expect(user).toContain('Range: the last 24 hours.');
    expect(user).toContain('[2] 2026-11-25 09:02 UTC (reply to [1]) Coder (bot): message 2');
    expect(user).toContain('(reply in a thread)');
    expect(cleanSummary('A [1] B [7] C [3][3]', numbers)).toEqual({
      body: 'A [1] B  C [3][3]',
      sources: [
        { n: 1, messageId: line(1).id, threadRootId: null },
        { n: 3, messageId: line(3).id, threadRootId: line(9).id },
      ],
    });
    const hostile = '['.repeat(50_000) + '1'.repeat(50_000);
    const t0 = performance.now();
    cleanSummary(hostile, numbers);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(summarySystem('Nadia')).toContain('Only Nadia will read it');
  });

  it('allows one at a time per person, a few at once per process and an hourly count', () => {
    resetSummaryLimits();
    const a = takeSummarySlot('p1', 0);
    expect(a.ok).toBe(true);
    const again = takeSummarySlot('p1', 1);
    expect(again.ok === false && again.error.status).toBe(409);
    const others = ['p2', 'p3', 'p4'].map((p) => takeSummarySlot(p, 2));
    expect(others.every((s) => s.ok)).toBe(true);
    const busy = takeSummarySlot('p5', 3);
    expect(busy.ok === false && busy.error.status).toBe(429);
    for (const s of [a, ...others]) if (s.ok) s.release();
    for (let i = 0; i < 39; i++) {
      const s = takeSummarySlot('p1', 10 + i);
      if (s.ok) s.release();
    }
    const hour = takeSummarySlot('p1', 100);
    expect(hour.ok === false && hour.error.status).toBe(429);
    const later = takeSummarySlot('p1', 61 * 60_000);
    expect(later.ok).toBe(true);
    // a press that sent nothing to the model gives its place in the hour back
    if (later.ok) {
      later.refund();
      later.release();
    }
    for (let i = 0; i < 40; i++) {
      const s = takeSummarySlot('p6', 1_000 + i);
      if (s.ok) {
        if (i === 0) s.refund();
        s.release();
      }
    }
    expect(takeSummarySlot('p6', 2_000).ok).toBe(true);
    resetSummaryLimits();
  });
});

