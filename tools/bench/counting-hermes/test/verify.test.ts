import { describe, expect, it } from 'vitest';
import { judge, parseLog, type CardEvent } from '../verify.ts';

const BOTS = 4;
const slugs = Array.from({ length: BOTS }, (_, i) => `counter-0${String(i + 1)}`);
const actor = new Map(slugs.map((s, i) => [s, `actor-${String(i + 1)}`]));
const log = (order: string[]) => order.map((s, i) => `${String(i + 1)} ${s}`).join('\n');
const turns = (order: string[]): CardEvent[] =>
  order.flatMap((s, i) => [
    { type: 'claimed', actorId: actor.get(s)!, createdAt: `2026-10-27T10:00:${String(i * 2).padStart(2, '0')}Z` },
    { type: 'released', actorId: actor.get(s)!, createdAt: `2026-10-27T10:00:${String(i * 2 + 1).padStart(2, '0')}Z` },
  ]);
const order = ['counter-03', 'counter-01', 'counter-04', 'counter-02'];
const base = { bots: BOTS, slugToActor: actor };

describe('judge', () => {
  it('passes a log that reads 1 to N with alternating claims and releases', () => {
    const v = judge({ ...base, description: log(order), events: [{ type: 'created', actorId: null, createdAt: 'x' }, ...turns(order)] });
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('reports a gap, a duplicate and a bot that never counted', () => {
    const v = judge({ ...base, description: '1 counter-01\n3 counter-02\n3 counter-02\n4 counter-04', events: turns(order) });
    expect(v.ok).toBe(false);
    expect(v.failures.join('\n')).toMatch(/line 2 reads 3/);
    expect(v.failures.join('\n')).toMatch(/counter-02 counted more than once/);
    expect(v.failures.join('\n')).toMatch(/counter-03 never counted/);
  });

  it('reports a line that is not a count instead of skipping it', () => {
    const v = judge({ ...base, description: `${log(order)}\nI did it!`, events: turns(order) });
    expect(v.failures.join('\n')).toMatch(/not "<n> <slug>"/);
  });

  it('reports two owners at once and a release by someone else', () => {
    const a = actor.get('counter-01')!;
    const b = actor.get('counter-02')!;
    const events: CardEvent[] = [
      { type: 'claimed', actorId: a, createdAt: '1' },
      { type: 'claimed', actorId: b, createdAt: '2' },
      { type: 'released', actorId: a, createdAt: '3' },
    ];
    const v = judge({ ...base, bots: 2, description: '1 counter-01\n2 counter-02', events, slugToActor: new Map([['counter-01', a], ['counter-02', b]]) });
    expect(v.failures.join('\n')).toMatch(/two owners at once/);
    expect(v.failures.join('\n')).toMatch(/released a card that/);
  });

  it('reports a card still held at the end', () => {
    const v = judge({ ...base, description: log(order), events: [...turns(order), { type: 'claimed', actorId: 'actor-9', createdAt: 'z' }] });
    expect(v.failures.join('\n')).toMatch(/still held/);
  });
});

describe('parseLog', () => {
  it('stays linear on a hostile line', () => {
    const started = Date.now();
    const out = parseLog(`${'9'.repeat(200_000)} ${'a '.repeat(100_000)}\n${' '.repeat(200_000)}x`);
    expect(Date.now() - started).toBeLessThan(500);
    expect(out.lines).toEqual([]);
    expect(out.bad).toHaveLength(2);
  });
});
