import type { BotRuntimeEvent } from '@manythreads/sdk';
import { RunActivityPayload, RunProgress } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { ActivityFold, bound, clip, fitPush, mapWords, MAX_ROWS, PUSH_BUDGET_BYTES, slimOf, type SlimEvent } from '../src/run-activity.ts';

const feed = (fold: ActivityFold, ...events: BotRuntimeEvent[]) =>
  events.flatMap((e) => {
    const slim = slimOf(e);
    return slim === null ? [] : fold.apply(slim);
  });
const tool = (stepId: string, kind: 'read' | 'edit' | 'execute' | 'search', title: string, extra: Record<string, unknown> = {}): BotRuntimeEvent =>
  ({ type: 'tool', name: 'x', input: { secret: 'never kept' }, stepId, kind, title, ...extra }) as BotRuntimeEvent;
const done = (stepId: string, ok = true, extra: Record<string, unknown> = {}): BotRuntimeEvent => ({ type: 'tool_result', name: 'x', ok, stepId, ...extra }) as BotRuntimeEvent;

describe('slimOf: the part of an event a record may hold', () => {
  it('drops a tool\'s input, a result\'s reason and the words of the answer', () => {
    const t = slimOf({ type: 'tool', name: 'bash', input: { command: 'cat ~/.ssh/id_rsa' }, stepId: 's1', kind: 'execute', title: 'pnpm test' });
    expect(JSON.stringify(t)).not.toContain('id_rsa');
    expect(t).toEqual({ t: 'tool', name: 'bash', stepId: 's1', kind: 'execute', title: 'pnpm test' });
    expect(JSON.stringify(slimOf({ type: 'tool_result', name: 'bash', ok: false, reason: 'the file /etc/shadow said no', stepId: 's1' }))).not.toContain('shadow');
    expect(slimOf({ type: 'text', text: 'the whole secret answer' })).toEqual({ t: 'answering' });
    expect(slimOf({ type: 'text', text: '  ' })).toBeNull();
  });

  it('makes a title one line, bounds it and the paths, and drops an approval\'s command and description', () => {
    const t = slimOf({ type: 'tool', name: 'x', input: null, kind: 'read', title: `a\n\n  b ${'z'.repeat(900)}`, paths: ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    expect(t).toMatchObject({ t: 'tool', paths: ['a', 'b', 'c', 'd', 'e'] });
    expect((t as { title: string }).title.startsWith('a b zzz')).toBe(true);
    expect((t as { title: string }).title.length).toBe(400);
    const a = slimOf({ type: 'approval', command: 'rm -rf /', description: 'secret reason', choices: ['once'], kind: 'delete', title: 'Delete x', answer: () => Promise.resolve(true) });
    expect(JSON.stringify(a)).not.toContain('rm -rf');
    expect(JSON.stringify(a)).not.toContain('secret reason');
    expect(a).toMatchObject({ t: 'approval', phase: 'asked', kind: 'delete', title: 'Delete x' });
  });

  it('has no use for the result', () => {
    expect(slimOf({ type: 'result', text: 'x', ok: true })).toBeNull();
  });
});

describe('mapWords: every string a person reads goes through one function', () => {
  it('maps titles, paths, helper names and plan lines, and nothing else', () => {
    const seen: string[] = [];
    const fn = (s: string): string => {
      seen.push(s);
      return s.toUpperCase();
    };
    const evs: SlimEvent[] = [
      { t: 'tool', name: 'secretname', stepId: 'id1', kind: 'read', title: 'tt', paths: ['p1', 'p2'] },
      { t: 'step', stepId: 'id2', title: 'st' },
      { t: 'agent', agentId: 'id3', name: 'helper', status: 'working', steps: 1 },
      { t: 'plan', entries: [{ content: 'do it', status: 'pending' }] },
      { t: 'approval', phase: 'asked', title: 'ap', paths: ['p3'] },
    ];
    const out = evs.map((e) => mapWords(e, fn));
    expect(seen.sort()).toEqual(['ap', 'do it', 'helper', 'p1', 'p2', 'p3', 'st', 'tt']);
    expect(JSON.stringify(out)).toContain('"name":"secretname"');
    expect(JSON.stringify(out)).toContain('"stepId":"id1"');
    expect(JSON.stringify(out)).toContain('"DO IT"');
  });
});

describe('ActivityFold: lines', () => {
  it('writes a line per step start and end, in order, each a valid payload', () => {
    const fold = new ActivityFold();
    const rows = feed(fold, tool('s1', 'read', 'Read a.ts', { paths: ['a.ts'] }), done('s1', true, { seconds: 0.4 }), tool('s2', 'execute', 'pnpm test'), done('s2', false));
    expect(rows.map((r) => [r.seq, r.kind])).toEqual([
      [0, 'tool'],
      [1, 'tool_result'],
      [2, 'tool'],
      [3, 'tool_result'],
    ]);
    for (const r of rows) expect(RunActivityPayload.safeParse(r.payload).success, JSON.stringify(r.payload)).toBe(true);
    expect(rows[1]!.payload).toEqual({ kind: 'tool_result', stepId: 's1', ok: true, seconds: 0.4 });
    expect(fold.lastSeq).toBe(3);
    expect(fold.counts()).toMatchObject({ steps: 2, failed: 1, commands: 1 });
  });

  it('keeps "out of memory" on the closing line of a command stopped for memory (P31-04), and no other reason', () => {
    const fold = new ActivityFold();
    const rows = feed(
      fold,
      tool('s1', 'execute', 'pnpm typecheck'),
      done('s1', false, { reason: 'out of memory' }),
      tool('s2', 'execute', 'pnpm test'),
      done('s2', false, { reason: 'the tool reported an error' }),
      tool('s3', 'execute', 'ls'),
      done('s3', true, { reason: 'out of memory' }),
    );
    expect(rows[1]!.payload).toEqual({ kind: 'tool_result', stepId: 's1', ok: false, reason: 'out_of_memory' });
    expect(rows[3]!.payload).not.toHaveProperty('reason');
    expect(rows[5]!.payload).not.toHaveProperty('reason');
    for (const r of rows) expect(RunActivityPayload.safeParse(r.payload).success, JSON.stringify(r.payload)).toBe(true);
  });

  it('a title that changed after the first line is repeated on the closing line; one that did not is not', () => {
    const fold = new ActivityFold();
    const rows = feed(fold, tool('s1', 'read', 'Read'), { type: 'step', stepId: 's1', title: 'Read src/a.ts', paths: ['src/a.ts'] }, done('s1'));
    expect(rows[1]!.payload).toMatchObject({ kind: 'tool_result', title: 'Read src/a.ts', paths: ['src/a.ts'] });
    const same = new ActivityFold();
    const rows2 = feed(same, tool('s1', 'read', 'Read', { paths: ['a'] }), done('s1'));
    expect(rows2[1]!.payload).not.toHaveProperty('title');
    expect(rows2[1]!.payload).not.toHaveProperty('paths');
  });

  it('counts changed files once however often they are edited, and adds the diff', () => {
    const fold = new ActivityFold();
    feed(
      fold,
      tool('e1', 'edit', 'Edit a', { paths: ['a.ts'] }),
      done('e1', true, { diff: { added: 5, removed: 2 } }),
      tool('e2', 'edit', 'Edit a again', { paths: ['a.ts'] }),
      done('e2', true, { diff: { added: 1, removed: 0 } }),
      tool('e3', 'edit', 'Edit b', { paths: ['b.ts'] }),
      done('e3', false),
    );
    expect(fold.counts()).toMatchObject({ filesChanged: 1, added: 6, removed: 2, failed: 1 });
  });

  it('a gateway with no step ids: results match the oldest open step of the same tool', () => {
    const fold = new ActivityFold();
    const rows = feed(
      fold,
      { type: 'tool', name: 'terminal', input: null, kind: 'execute' },
      { type: 'tool', name: 'read_file', input: null, kind: 'read' },
      { type: 'tool_result', name: 'read_file', ok: true },
      { type: 'tool_result', name: 'terminal', ok: false },
      { type: 'tool_result', name: 'terminal', ok: true },
    );
    expect(rows.map((r) => (r.payload as { stepId: string }).stepId)).toEqual(['auto-1', 'auto-2', 'auto-2', 'auto-1']);
    expect(fold.counts()).toMatchObject({ steps: 2, failed: 1 });
  });

  it('a helper is a line when it appears and when its state changes, not on every step it takes', () => {
    const fold = new ActivityFold();
    const rows = feed(
      fold,
      { type: 'agent', agentId: 'h1', name: 'Explorer', status: 'working', steps: 0 },
      { type: 'agent', agentId: 'h1', name: 'Explorer', status: 'working', steps: 3 },
      { type: 'agent', agentId: 'h1', name: 'Explorer', status: 'working', steps: 4 },
      { type: 'agent', agentId: 'h1', name: 'Explorer', status: 'done', steps: 5 },
    );
    expect(rows.map((r) => (r.payload as { status: string }).status)).toEqual(['working', 'done']);
    expect(fold.helpers()).toEqual([{ id: 'h1', name: 'Explorer', status: 'done', steps: 5 }]);
    expect(fold.counts().helpers).toBe(1);
  });

  it('a plan is a line only when it changed; the version goes up with it', () => {
    const fold = new ActivityFold();
    const p1 = { type: 'plan', entries: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }] } as const;
    expect(feed(fold, p1)).toHaveLength(1);
    expect(feed(fold, p1)).toHaveLength(0);
    expect(fold.progress().planVersion).toBe(1);
    feed(fold, { type: 'plan', entries: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] });
    expect(fold.progress().planVersion).toBe(2);
    expect(fold.planSummary()).toEqual({ done: 1, total: 2, current: 'b' });
  });

  it('thinking is time only: a short one is counted, not written', () => {
    const fold = new ActivityFold();
    const rows = feed(fold, { type: 'thinking', seconds: 0.4 }, { type: 'thinking', seconds: 3.26 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ kind: 'thinking', seconds: 3.3 });
    expect(fold.counts().thinkingSeconds).toBe(3.7);
  });

  it('keeps at most the row cap, and counts what it did not keep', () => {
    const fold = new ActivityFold(4);
    const rows = feed(fold, tool('a', 'read', 'a'), done('a'), tool('b', 'read', 'b'), done('b'), tool('c', 'read', 'c'), done('c'));
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(fold.counts()).toMatchObject({ steps: 3, omitted: 2 });
    expect(MAX_ROWS).toBe(2000);
  });

  it('a long run: ten thousand steps are bounded in memory and in lines', () => {
    const fold = new ActivityFold();
    let written = 0;
    for (let i = 0; i < 10_000; i += 1) written += feed(fold, tool(`s${i}`, 'read', `Read ${i}`), done(`s${i}`)).length;
    expect(written).toBe(MAX_ROWS);
    expect(fold.counts().steps).toBe(10_000);
    expect(fold.counts().omitted).toBe(20_000 - MAX_ROWS);
  });
});

describe('ActivityFold: the folded state', () => {
  it('starts as "starting", is "working" once it has an event, "waiting" while a person is asked, and ends with the run', () => {
    const fold = new ActivityFold();
    expect(fold.state).toBe('starting');
    feed(fold, tool('s1', 'read', 'Read'));
    expect(fold.state).toBe('working');
    feed(fold, { type: 'approval', command: 'x', description: 'y', choices: [], answer: () => Promise.resolve(true) });
    expect(fold.state).toBe('waiting');
    expect(fold.settle('approved')[0]!.payload).toEqual({ kind: 'approval', outcome: 'approved' });
    expect(fold.state).toBe('working');
    fold.markStopping('Rafi');
    expect(fold.state).toBe('stopping');
    expect(fold.progress().stoppedBy).toBe('Rafi');
    fold.finish('stopped', { stopReason: 'cancelled', cost: { amount: 0.4, currency: 'USD' } });
    expect(fold.state).toBe('stopped');
    expect(fold.progress().now).toBeNull();
    expect(fold.viewColumns()).toMatchObject({ state: 'stopped', stop_reason: 'cancelled', cost: { amount: 0.4, currency: 'USD' } });
    // nothing is written after the end
    expect(feed(fold, tool('late', 'read', 'late'))).toEqual([]);
  });

  it('"now" is the newest open step with how many of its kind are open together; then thinking; then answering', () => {
    const fold = new ActivityFold();
    expect(fold.now()).toBeNull();
    feed(fold, tool('r1', 'read', 'Read a', { paths: ['a'] }), tool('r2', 'read', 'Read b', { paths: ['b'] }), tool('x1', 'execute', 'pnpm test'));
    expect(fold.now()).toEqual({ kind: 'execute', title: 'pnpm test', paths: [], helper: null, count: 1 });
    feed(fold, done('x1'));
    expect(fold.now()).toEqual({ kind: 'read', title: 'Read b', paths: ['b'], helper: null, count: 2 });
    feed(fold, done('r1'), done('r2'), { type: 'thinking', seconds: 2 });
    expect(fold.now()?.kind).toBe('thinking');
    feed(fold, { type: 'text', text: 'Here is' });
    expect(fold.now()?.kind).toBe('answering');
  });

  it('names the helper a step belongs to', () => {
    const fold = new ActivityFold();
    feed(fold, { type: 'agent', agentId: 'h1', name: 'Explorer', status: 'working', steps: 0 }, tool('c1', 'search', 'Search', { parentStepId: 'h1' }));
    expect(fold.now()).toMatchObject({ kind: 'search', helper: 'Explorer' });
  });

  it('finishing closes the open steps and the working helpers', () => {
    const fold = new ActivityFold();
    feed(fold, { type: 'agent', agentId: 'h1', name: 'Explorer', status: 'working', steps: 2 }, tool('c1', 'read', 'Read'));
    fold.finish('done');
    expect(fold.helpers()[0]!.status).toBe('done');
    expect(fold.now()).toBeNull();
    const failed = new ActivityFold();
    feed(failed, { type: 'agent', agentId: 'h1', name: 'E', status: 'working', steps: 2 });
    failed.finish('failed');
    expect(failed.helpers()[0]!.status).toBe('failed');
  });

  it('keeps the newest twelve helpers and shows the newest five', () => {
    const fold = new ActivityFold();
    for (let i = 0; i < 20; i += 1) feed(fold, { type: 'agent', agentId: `h${i}`, name: `H${i}`, status: 'working', steps: 0 });
    expect(fold.helpers()).toHaveLength(12);
    expect(fold.counts().helpers).toBe(20);
    expect(fold.progress().helpers.map((h) => h.id)).toEqual(['h15', 'h16', 'h17', 'h18', 'h19']);
  });

  it('a progress is a valid RunProgress', () => {
    const fold = new ActivityFold();
    feed(fold, tool('s1', 'read', 'Read', { paths: ['a'] }), { type: 'plan', entries: [{ content: 'a', status: 'pending' }] });
    expect(RunProgress.safeParse(fold.progress()).success).toBe(true);
  });
});

describe('fitPush: a push stays under the budget', () => {
  const fat = (n: number): ReturnType<ActivityFold['progress']> => {
    const fold = new ActivityFold();
    const long = '長'.repeat(n);
    feed(fold, { type: 'plan', entries: [{ content: long, status: 'in_progress' }] });
    for (let i = 0; i < 8; i += 1) feed(fold, { type: 'agent', agentId: `h${i}`, name: long, status: 'working', steps: 1 });
    feed(fold, { type: 'tool', name: 'x', input: null, kind: 'read', title: long, paths: [long, long, long, long, long].map((p, i) => `${i}${p}`) });
    // the fold keeps every word within its byte limit, so a push this big cannot come from it any more: this one is made fat by hand, as a backstop for a limit that is raised
    const p = fold.progress();
    return {
      ...p,
      now: p.now === null ? null : { ...p.now, title: long, paths: [long, long, long, long, long].map((x, i) => `${i}${x}`) },
      helpers: p.helpers.map((h) => ({ ...h, name: long })),
      plan: { ...p.plan, current: long },
    };
  };

  it('leaves a small one alone', () => {
    const p = fat(10);
    expect(fitPush(p)).toBe(p);
  });

  it('cuts words first and keeps the state and the counts', () => {
    const p = fat(400);
    const raw = Buffer.byteLength(JSON.stringify(p));
    expect(raw).toBeGreaterThan(PUSH_BUDGET_BYTES);
    const fitted = fitPush(p);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(PUSH_BUDGET_BYTES);
    expect(fitted.state).toBe(p.state);
    expect(fitted.counts).toEqual(p.counts);
    expect(fitted.seq).toBe(p.seq);
    expect(fitted.plan.total).toBe(1);
    expect(RunProgress.safeParse(fitted).success).toBe(true);
  });
});

const bytes = (s: string): number => Buffer.byteLength(s);

describe('clip: bytes, not characters (H2)', () => {
  it('keeps Arabic (2 bytes a letter) and CJK (3 bytes) within the byte limit and never cuts a character', () => {
    const arabic = 'مرحبا'.repeat(200);
    const cjk = '長い名前'.repeat(200);
    for (const text of [arabic, cjk, '😀'.repeat(300)]) {
      const out = clip(text, 400);
      expect(bytes(out)).toBeLessThanOrEqual(400);
      expect(bytes(out)).toBeGreaterThan(396 - 4);
      expect(text.startsWith(out)).toBe(true);
      expect(out).not.toContain('\uFFFD');
    }
    expect(clip('abc', 400)).toBe('abc');
  });

  it('strips what a jsonb cannot hold: NUL and a lone surrogate', () => {
    expect(clip('a\u0000b', 100)).toBe('ab');
    expect(clip('x\uD800y', 100)).toBe('x\uFFFDy');
    expect(clip('\uDC00', 100)).toBe('\uFFFD');
    expect(clip('ok 😀', 100)).toBe('ok 😀');
  });

  it('a title, a path and a helper name of Arabic or CJK fit the columns once folded', () => {
    const fold = new ActivityFold();
    const arabic = 'ملف'.repeat(500);
    const cjk = '長'.repeat(900);
    const rows = feed(
      fold,
      tool('s1', 'read', arabic, { paths: [arabic, cjk] }),
      { type: 'agent', agentId: 'h1', name: cjk, status: 'working', steps: 1 },
      { type: 'plan', entries: [{ content: cjk, status: 'in_progress' }] },
    );
    for (const row of rows) expect(bytes(JSON.stringify(row.payload))).toBeLessThan(4000);
    const view = fold.viewColumns();
    expect(bytes(JSON.stringify(view.now_step))).toBeLessThanOrEqual(2500);
    expect(bytes(JSON.stringify(view.helpers))).toBeLessThanOrEqual(6000);
    expect(bytes(JSON.stringify(view.plan))).toBeLessThanOrEqual(16000);
  });

  it('bound() clips an event that was built by hand, the same way', () => {
    const b = bound({ t: 'tool', name: 'x', kind: 'read', title: '長'.repeat(900), paths: ['長'.repeat(900)] });
    expect(bytes((b as { title: string }).title)).toBeLessThanOrEqual(400);
    expect(bytes((b as { paths: string[] }).paths[0]!)).toBeLessThanOrEqual(300);
  });
});

describe('the end of a wait and who stopped (M3)', () => {
  it('an approval that ended with the run says "ended", not approved', () => {
    const fold = new ActivityFold();
    feed(fold, { type: 'approval', command: 'x', description: 'y', choices: [], answer: () => Promise.resolve(true) });
    expect(fold.settle('ended')[0]!.payload).toEqual({ kind: 'approval', outcome: 'ended' });
    expect(fold.state).toBe('working');
  });

  it('the name of who stopped is shown only while the run is stopping or stopped', () => {
    const fold = new ActivityFold();
    feed(fold, tool('s1', 'read', 'Read'));
    fold.markStopping('Rafi');
    expect(fold.progress().stoppedBy).toBe('Rafi');
    fold.finish('done', { stopReason: null, cost: null });
    expect(fold.progress().stoppedBy).toBeNull();
    expect(fold.viewColumns()).toMatchObject({ state: 'done' });
  });
});
