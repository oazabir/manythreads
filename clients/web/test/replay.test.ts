import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import type { FullReplayEstimate, ReplayResult } from '@manythreads/shared';
import { setTransport } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { askFullReplay, closeReassessment, fetchReplay, listReassessments } from '../src/screens/workshop/replay-api';
import { DAY_CHOICES, KIND_WORDS, NOW_STATE_WORDS, REASON_WORDS, STATE_WORDS, VERDICT_WORDS, changeLine, confirmLabel, dollars, estimateLines, kindLine, noticesLine, summaryLine } from '../src/screens/workshop/replay-model';
import { ReassessmentNotices, ReplayPanel } from '../src/screens/workshop/Replay';

// P7-07: the Replay section and the "check this again" notices against the mock transport (the same routes and shapes as the server), the words of the model, and the markup.

const use = (as = 'omar') => setTransport(createMockTransport({ latencyMs: 0, as }));
const page = (node: ReturnType<typeof createElement>): string => renderToStaticMarkup(createElement(StaticRouter, { location: '/' }, node));

const counts = (same: number, tighter: number, looser: number, notReplayed: number) => ({ total: same + tighter + looser + notReplayed, same, tighter, looser, notReplayed });
const result = (over: Partial<ReplayResult> = {}): ReplayResult => ({
  days: 30,
  since: '2026-09-01T00:00:00.000Z',
  model: 'none',
  runs: 4,
  runsCapped: false,
  counts: counts(5, 2, 1, 1),
  byKind: { gate: counts(3, 1, 0, 1), guard: counts(1, 0, 1, 0), tool: counts(1, 1, 0, 0) },
  changes: [],
  changesCapped: false,
  decisionsCapped: false,
  notes: [],
  fullReplayable: [],
  ...over,
}) as ReplayResult;
const estimate = (over: Partial<FullReplayEstimate> = {}): FullReplayEstimate =>
  ({ runId: '00000000-0000-7000-8000-0000000c0001', calls: 3, promptTokens: 1500, completionTokens: 340, tokens: 1840, costUsd: 0.0124, priceKnown: true, maxCalls: 8, basis: 'x', confirmToken: 'a1b2c3d4e5f60718', ...over }) as FullReplayEstimate;

describe('the words', () => {
  it('reads the result out in one sentence: what changed, what cannot be checked, the rest the same', () => {
    expect(summaryLine(result())).toBe('Checked 9 decisions from 4 runs. 2 would be stricter, 1 would be milder, 1 cannot be checked again; the other 5 come out the same.');
    expect(summaryLine(result({ counts: counts(6, 0, 0, 0) }))).toMatch(/None of them would come out differently/);
    expect(summaryLine(result({ runsCapped: true }))).toMatch(/the newest ones/);
  });

  it('says so when there is nothing to replay, and when runs recorded nothing', () => {
    expect(summaryLine(result({ runs: 0, counts: counts(0, 0, 0, 0) }))).toBe('There are no runs of this bot in the last 30 days that you can replay.');
    expect(summaryLine(result({ runs: 3, counts: counts(0, 0, 0, 0) }))).toMatch(/none of them recorded a gate, data check or permission decision/);
  });

  it('names every kind, state and verdict in plain words, with no internal name', () => {
    const all = [...Object.values(KIND_WORDS), ...Object.values(STATE_WORDS), ...Object.values(NOW_STATE_WORDS), ...Object.values(VERDICT_WORDS), ...Object.values(REASON_WORDS)].join(' ');
    expect(all).not.toMatch(/waits_for_person|not_replayed|llm_gateway|knowledge_removed|run_decisions|bot_runner/);
    expect(DAY_CHOICES).toEqual([7, 14, 30]);
    expect(changeLine('allowed', 'waits_for_person')).toBe('Then it went through. Now it would wait for a person.');
    expect(changeLine('waits_for_person', null)).toBe('Then it waited for a person.');
    expect(kindLine(counts(0, 0, 0, 0))).toBe('Nothing recorded');
    expect(kindLine(counts(3, 1, 0, 2))).toBe('3 same, 1 stricter, 2 not checked again');
  });

  it('shows the cost before anything runs: tokens, price when known, the limit and that it is a rehearsal', () => {
    const lines = estimateLines(estimate());
    expect(lines[0]).toMatch(/about 1,840 tokens \(1,500 read, 340 written\)\. The original run cost \$0\.0124\./);
    expect(lines.join(' ')).toMatch(/stops after 8 model calls/);
    expect(lines.join(' ')).toMatch(/held back and marked “not really done”/);
    expect(confirmLabel(estimate())).toBe('Run it (about 1,840 tokens)');
    expect(estimateLines(estimate({ costUsd: null, priceKnown: false }))[0]).toMatch(/No price is recorded/);
    expect(estimateLines(estimate({ tokens: 0, promptTokens: 0, completionTokens: 0 }))[0]).toMatch(/no number to show/);
    expect(confirmLabel(estimate({ tokens: 0 }))).toBe('Run it anyway');
    expect(dollars(0.5)).toBe('$0.50');
    expect(dollars(0.0003)).toBe('$0.0003');
  });

  it('counts the things to check again', () => {
    expect(noticesLine(1)).toBe('1 thing to check again');
    expect(noticesLine(3)).toBe('3 things to check again');
  });
});

describe('the flow, offline', () => {
  beforeEach(() => use());

  it('replays for a lead: free, with changes in words, and a run that can be asked again', async () => {
    const { replay } = await fetchReplay('engineering', 'brain', 30);
    expect(replay.model).toBe('none');
    expect(replay.counts.tighter).toBe(2);
    expect(replay.changes.length).toBeGreaterThan(0);
    expect(replay.changes.every((c) => c.explanation.length > 20)).toBe(true);
    expect(replay.fullReplayable).toHaveLength(1);
  });

  it('shows a member less and offers no full replay', async () => {
    use('nadia');
    const { replay } = await fetchReplay('engineering', 'brain', 7);
    expect(replay.days).toBe(7);
    expect(replay.runs).toBeLessThan(12);
    expect(replay.fullReplayable).toEqual([]);
    await expect(askFullReplay('engineering', 'brain', '00000000-0000-7000-8000-0000000c0001')).rejects.toThrow(/team lead or an admin/);
  });

  it('a full replay shows its cost first and starts only once the same number is sent back', async () => {
    const runId = (await fetchReplay('engineering', 'brain', 30)).replay.fullReplayable[0]!.runId;
    const first = await askFullReplay('engineering', 'brain', runId);
    expect(first.status).toBe('needs_confirmation');
    if (first.status !== 'needs_confirmation') throw new Error('unreachable');
    await expect(askFullReplay('engineering', 'brain', runId, { tokens: first.estimate.tokens + 1, token: first.estimate.confirmToken })).rejects.toThrow(/estimate changed/);
    await expect(askFullReplay('engineering', 'brain', runId, { tokens: first.estimate.tokens, token: '0000000000000000' })).rejects.toThrow(/estimate changed/);
    const started = await askFullReplay('engineering', 'brain', runId, { tokens: first.estimate.tokens, token: first.estimate.confirmToken });
    expect(started.status).toBe('started');
    if (started.status !== 'started') throw new Error('unreachable');
    expect(started.session.mode).toBe('rehearse');
    expect(started.session.entries[0]).toMatchObject({ kind: 'person' });
  });

  it('refuses a run that kept no message in the server’s words', async () => {
    await expect(askFullReplay('engineering', 'brain', '00000000-0000-7000-8000-0000000c0002')).rejects.toThrow(/did not keep the message/);
  });

  it('lists the notices and lets a lead close one, once', async () => {
    const open = (await listReassessments('engineering', 'support-bot')).reassessments;
    expect(open.length).toBeGreaterThanOrEqual(2);
    const closed = await closeReassessment('engineering', 'support-bot', open[0]!.id, 'done');
    expect(closed.reassessment.status).toBe('done');
    expect((await listReassessments('engineering', 'support-bot')).reassessments.map((n) => n.id)).not.toContain(open[0]!.id);
    await expect(closeReassessment('engineering', 'support-bot', open[0]!.id, 'done')).rejects.toThrow(/No such open notice/);
  });

  it('a member reads the notices but cannot close them', async () => {
    use('nadia');
    const open = (await listReassessments('engineering', 'support-bot')).reassessments;
    expect(open.length).toBeGreaterThan(0);
    await expect(closeReassessment('engineering', 'support-bot', open[0]!.id, 'dismissed')).rejects.toThrow(/team lead or an admin/);
  });
});

describe('the markup', () => {
  it('the Replay section starts empty: a labelled section, a days choice, a button that says what it does, a live region, and no result', () => {
    const out = page(createElement(ReplayPanel, { slug: 'engineering', botSlug: 'brain', canManage: true, onStarted: () => undefined }));
    expect(out).toContain('aria-labelledby="ws-replay-h"');
    expect(out).toContain('Replay guard and gate decisions');
    expect(out).toContain('data-testid="ws-replay-days"');
    expect(out).toContain('Replay decisions · last 30 days');
    expect(out).toContain('role="status"');
    expect(out).not.toContain('ws-replay-result');
    // a free replay says so up front
    expect(out).toMatch(/Free and repeatable/);
    expect(out).toMatch(/No model is called/);
  });

  it('the notices render nothing before they are loaded (no flash of an empty box)', () => {
    expect(page(createElement(ReassessmentNotices, { slug: 'engineering', botSlug: 'support-bot', canManage: true, compact: false, onOpen: () => undefined }))).toBe('');
  });
});
