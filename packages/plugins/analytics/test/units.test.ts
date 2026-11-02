import { describe, expect, it } from 'vitest';
import {
  aliasesOf,
  analyticsEnabled,
  botRowsOf,
  cleanDims,
  dailyOf,
  derivedId,
  eventMonths,
  labelSql,
  monthsBetween,
  oldestKeptMonth,
  qualityOf,
  signInsOf,
  teamRowsOf,
  totalsOf,
  usageRange,
} from '../src/index.ts';
import type { SeriesRow } from '../src/usage.ts';

const T1 = '0198a000-0000-7000-8000-000000000001';
const B1 = '0198a000-0000-7000-8000-0000000000b1';
const B2 = '0198a000-0000-7000-8000-0000000000b2';
const row = (metric: string, over: Partial<SeriesRow> = {}): SeriesRow => ({ day: '2026-11-01', team_id: T1, bot_id: B1, metric, dim: '', total: 1, n: 1, ...over });

describe('config', () => {
  it('is on unless an operator says off, and clamps the kept months', () => {
    expect(analyticsEnabled({})).toBe(true);
    expect(analyticsEnabled({ MANYTHREADS_ANALYTICS: ' OFF ' })).toBe(false);
    expect(analyticsEnabled({ MANYTHREADS_ANALYTICS: 'on' })).toBe(true);
    expect(eventMonths({})).toBe(14);
    expect(eventMonths({ MANYTHREADS_ANALYTICS_EVENT_MONTHS: '6' })).toBe(6);
    expect(eventMonths({ MANYTHREADS_ANALYTICS_EVENT_MONTHS: '1' })).toBe(14);
    expect(eventMonths({ MANYTHREADS_ANALYTICS_EVENT_MONTHS: '999' })).toBe(14);
    expect(eventMonths({ MANYTHREADS_ANALYTICS_EVENT_MONTHS: 'many' })).toBe(14);
  });
  it('keeps the current month and the months before it', () => {
    expect(oldestKeptMonth(new Date('2026-11-02T10:00:00Z'), 2)).toBe('2026-10-01');
    expect(oldestKeptMonth(new Date('2026-01-31T23:00:00Z'), 14)).toBe('2024-12-01');
  });
});

describe('row helpers', () => {
  it('makes the same id for the same source and metric, and a different one otherwise', () => {
    expect(derivedId('a', 'run.count')).toBe(derivedId('a', 'run.count'));
    expect(derivedId('a', 'run.count')).not.toBe(derivedId('a', 'answer.scoped'));
    expect(derivedId('ab', 'c')).not.toBe(derivedId('a', 'bc'));
    expect(derivedId('a', 'b')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('keeps only short plain labels', () => {
    const long = 'x'.repeat(500);
    expect(cleanDims({ status: 'done', n: 3, ok: true, bad: Number.NaN, empty: null, gone: undefined, 'not a key': 'x', long })).toEqual({ status: 'done', n: 3, ok: true, long: 'x'.repeat(80) });
  });
  it('lists every month between two instants', () => {
    expect(monthsBetween(new Date('2026-11-30T23:59:00Z'), new Date('2027-01-01T00:00:00Z'))).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
    expect(monthsBetween(new Date('2026-11-02T00:00:00Z'), new Date('2026-11-02T01:00:00Z'))).toEqual(['2026-11-01']);
    expect(monthsBetween(new Date('2026-12-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'))).toEqual([]);
  });
  it('builds a label per metric and an empty label for the rest', () => {
    const sql = labelSql('e');
    expect(sql).toContain(`WHEN 'llm.cost_micro' THEN left(coalesce(e.dims ->> 'alias', ''), 80)`);
    expect(sql).toContain(`ELSE '' END`);
  });
});

describe('the numbers', () => {
  it('makes the range of whole UTC days ending today', () => {
    expect(usageRange(new Date('2026-11-02T23:59:59Z'), 3)).toMatchObject({ days: 3, since: '2026-10-31', until: '2026-11-02' });
    expect(usageRange(new Date('2026-11-02T00:00:00Z'), 1)).toMatchObject({ since: '2026-11-02', until: '2026-11-02' });
  });

  const rows: SeriesRow[] = [
    row('run.count', { dim: 'done', n: 6, total: 6 }),
    row('run.count', { dim: 'failed', n: 2, total: 2 }),
    row('run.count', { dim: 'stopped', n: 1, total: 1, day: '2026-10-31' }),
    row('tool.call', { dim: 'denied', n: 3, total: 3 }),
    row('tool.call', { dim: 'allowed', n: 7, total: 7 }),
    row('approval.decided', { dim: 'approved', n: 4, total: 4 }),
    row('approval.decided', { dim: 'denied', n: 1, total: 1 }),
    row('approval.wait_seconds', { dim: 'approved', n: 2, total: 90 }),
    row('answer.scoped', { n: 3, total: 3 }),
    row('answer.full', { n: 1, total: 1 }),
    row('answer.citations', { n: 4, total: 9 }),
    row('answer.dropped', { n: 4, total: 3 }),
    row('llm.cost_micro', { dim: 'smart', n: 2, total: 1_500_000 }),
    row('llm.cost_micro', { dim: 'fast', n: 1, total: 250_000, bot_id: B2 }),
    row('llm.tokens', { dim: 'smart', n: 2, total: 3200 }),
    row('signin.ok', { dim: 'password', team_id: null, bot_id: null, n: 2, total: 2 }),
    row('signin.ok', { dim: 'oidc', team_id: null, bot_id: null, n: 5, total: 5 }),
    row('signin.failed', { dim: 'wrong_password', team_id: null, bot_id: null, n: 1, total: 1 }),
  ];

  it('adds totals up, and says nothing of money when it may not', () => {
    const t = totalsOf(rows, true);
    expect(t).toMatchObject({ runs: 9, failedRuns: 2, stoppedRuns: 1, toolCalls: 10, toolsRefused: 3, approvalsApproved: 4, approvalsDenied: 1, answers: 4, answersScoped: 3, spendUsd: 1.75, tokens: 3200, llmCalls: 3 });
    expect(t.approvalWaitSeconds).toBe(45);
    const blind = totalsOf(rows, false);
    expect(blind.spendUsd).toBeNull();
    expect(blind.tokens).toBeNull();
    expect(blind.llmCalls).toBeNull();
    expect(totalsOf([], true)).toMatchObject({ runs: 0, spendUsd: 0, approvalWaitSeconds: null });
  });

  it('gives every day of the range, with a zero for a quiet one', () => {
    const range = usageRange(new Date('2026-11-01T12:00:00Z'), 3);
    const days = dailyOf(rows, range, true);
    expect(days.map((d) => d.day)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(days.map((d) => d.runs)).toEqual([0, 1, 8]);
    expect(days[2]!.spendUsd).toBe(1.75);
    expect(dailyOf(rows, range, false).every((d) => d.spendUsd === null)).toBe(true);
  });

  it('works out quality, and leaves a share empty when there is nothing to divide', () => {
    const q = qualityOf(rows);
    expect(q).toMatchObject({ answers: 4, scoped: 3, full: 1, citations: 9, dropped: 3 });
    expect(q.citationsPerAnswer).toBeCloseTo(2.25, 6);
    expect(q.droppedShare).toBeCloseTo(0.25, 6);
    expect(qualityOf([])).toMatchObject({ answers: 0, citationsPerAnswer: null, droppedShare: null });
  });

  it('adds spend up per model alias, the dearest first, and hides it without money', () => {
    expect(aliasesOf(rows, true)).toEqual([
      { alias: 'smart', spendUsd: 1.5, calls: 2 },
      { alias: 'fast', spendUsd: 0.25, calls: 1 },
    ]);
    expect(aliasesOf(rows, false)).toEqual([]);
  });

  it('adds sign-ins up by method', () => {
    expect(signInsOf(rows)).toEqual({ ok: 7, failed: 1, byMethod: [{ method: 'oidc', count: 5 }, { method: 'password', count: 2 }] });
  });

  it('lists the bots that worked and the teams that did, with an error rate that never passes one', () => {
    const names = {
      bots: new Map([[B1, { slug: 'brain', name: 'Brain', teamId: T1 }]]),
      teams: new Map([[T1, { slug: 'engineering', name: 'Engineering' }]]),
    };
    const bots = botRowsOf(rows, names, true);
    expect(bots[0]).toMatchObject({ botId: B1, slug: 'brain', teamSlug: 'engineering', runs: 9, failedRuns: 2, spendUsd: 1.5 });
    expect(bots[0]!.errorRate).toBeCloseTo(2 / 9, 6);
    expect(bots[1]).toMatchObject({ botId: B2, slug: null, runs: 0, errorRate: null });
    expect(botRowsOf(rows, names, false).every((b) => b.spendUsd === null)).toBe(true);
    const teams = teamRowsOf(rows, names, true);
    // the no-team sign-in rows are not a team that worked
    expect(teams.map((t) => t.teamId)).toEqual([T1]);
  });
});
