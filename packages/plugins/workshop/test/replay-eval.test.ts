import { REASSESSMENT_REASONS, ReplayResult, type RunDecisionOutcome } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { describeReassessment } from '../src/reassess.ts';
import { looksInternal } from '../src/labels.ts';
import {
  REPLAY_NOTES,
  compareStates,
  evaluate,
  judgeGate,
  judgeGuard,
  judgeTool,
  prepareGate,
  recordedState,
  toolKey,
  type MessageNow,
  type RecordedDecision,
  type ReplayFacts,
} from '../src/replay-eval.ts';

// P7-07: the replay of recorded decisions, the pure part. No database and no model: the facts are handed in, the judgement comes out. Every explanation is plain words and never echoes
// the message text.

const RUN = '00000000-0000-7000-8000-0000000c0001';
const MSG = '00000000-0000-7000-8000-0000000e0001';
const at = '2026-10-30T10:00:00.000Z';

const decision = (over: Partial<RecordedDecision> & Pick<RecordedDecision, 'kind' | 'outcome'>): RecordedDecision => ({
  runId: RUN,
  at,
  subject: over.kind === 'gate' ? 'gate' : over.kind === 'guard' ? 'smart' : 'messages.post',
  target: null,
  messageId: over.kind === 'gate' ? MSG : null,
  detail: {},
  trigger: 'conversation',
  ...over,
});

const text = (t: string): MessageNow => ({ kind: 'text', text: t });
const list = (...entries: string[]) => prepareGate(entries, true);

describe('the scale', () => {
  it('puts every recorded outcome on one scale, mildest first', () => {
    expect(recordedState('gate', 'passed')).toBe('allowed');
    expect(recordedState('gate', 'held')).toBe('waits_for_person');
    expect(recordedState('gate', 'refused')).toBe('refused');
    expect(recordedState('guard', 'allow')).toBe('allowed');
    expect(recordedState('guard', 'redact')).toBe('redacted');
    expect(recordedState('guard', 'require_approval')).toBe('waits_for_person');
    expect(recordedState('guard', 'block')).toBe('refused');
    expect(recordedState('tool', 'allowed')).toBe('allowed');
    expect(recordedState('tool', 'needs_approval')).toBe('waits_for_person');
    expect(recordedState('tool', 'denied')).toBe('refused');
    // an outcome that cannot belong to its kind is not guessed at
    expect(recordedState('gate', 'redact')).toBeNull();
  });

  it('compares two states', () => {
    expect(compareStates('allowed', 'waits_for_person')).toBe('tighter');
    expect(compareStates('refused', 'allowed')).toBe('looser');
    expect(compareStates('redacted', 'redacted')).toBe('same');
  });
});

describe('the gate: the topic list of today against the message as it is now', () => {
  const passed = decision({ kind: 'gate', outcome: 'passed' });
  const held = (stage: string) => decision({ kind: 'gate', outcome: 'held', detail: { stage } });

  it('a message that went through but matches today’s list would now wait for a person', () => {
    const j = judgeGate(passed, 'allowed', text('Please walk me through the credential rotation.'), list('credential rotation'));
    expect(j).toMatchObject({ now: 'waits_for_person', verdict: 'tighter' });
    expect(j.explanation).toContain('would hold this message for a person');
  });

  it('a message held by the list that no longer matches would now go through', () => {
    const j = judgeGate(held('exact'), 'waits_for_person', text('What is for lunch?'), list('credential rotation'));
    expect(j).toMatchObject({ now: 'allowed', verdict: 'looser' });
  });

  it('a message the list still holds is the same', () => {
    expect(judgeGate(held('exact'), 'waits_for_person', text('credential rotation please'), list('credential rotation'))).toMatchObject({ verdict: 'same' });
  });

  it('a pattern entry holds what it matches', () => {
    expect(judgeGate(passed, 'allowed', text('error code ZX-4411 appeared'), list('/ZX-[0-9]+/'))).toMatchObject({ verdict: 'tighter' });
  });

  it('what the local model decided is not asked again, however the list reads now', () => {
    const j = judgeGate(held('classifier'), 'waits_for_person', text('What is for lunch?'), list('credential rotation'));
    expect(j).toMatchObject({ now: null, verdict: 'not_replayed' });
    expect(j.explanation).toContain('local model');
    expect(judgeGate(held('classifier_unavailable'), 'waits_for_person', text('What is for lunch?'), list('credential rotation')).verdict).toBe('not_replayed');
  });

  it('a bot with no list now lets a held message through, and one that never had a list stays the same', () => {
    expect(judgeGate(held('exact'), 'waits_for_person', text('anything'), prepareGate([], true))).toMatchObject({ now: 'allowed', verdict: 'looser' });
    expect(judgeGate(passed, 'allowed', undefined, prepareGate(undefined, true))).toMatchObject({ verdict: 'same' });
  });

  it('a list that does not load holds everything, like the real gate', () => {
    expect(judgeGate(passed, 'allowed', text('hello'), prepareGate(['/(a+)+$/ unbalanced ('], true))).toMatchObject({ now: 'waits_for_person', verdict: 'tighter' });
  });

  it('a message that is gone, unreadable or edited is not replayed, and so is an unreadable definition', () => {
    expect(judgeGate(passed, 'allowed', undefined, list('x y'))).toMatchObject({ verdict: 'not_replayed' });
    expect(judgeGate(passed, 'allowed', { kind: 'unreadable' }, list('x y'))).toMatchObject({ verdict: 'not_replayed' });
    const edited = judgeGate(passed, 'allowed', { kind: 'edited' }, list('x y'));
    expect(edited.verdict).toBe('not_replayed');
    expect(edited.explanation).toContain('edited');
    expect(judgeGate(passed, 'allowed', text('x y'), prepareGate(null, false))).toMatchObject({ verdict: 'not_replayed' });
  });

  it('a stop for a spending or rate limit is not the list’s decision', () => {
    expect(judgeGate(decision({ kind: 'gate', outcome: 'refused' }), 'refused', text('x'), list('x'))).toMatchObject({ verdict: 'not_replayed' });
  });

  it('never repeats the message in the explanation', () => {
    const secret = 'my-password-is-hunter2-credential-rotation';
    const j = judgeGate(passed, 'allowed', text(secret), list('credential rotation'));
    expect(j.explanation).not.toContain('hunter2');
  });
});

describe('the guard: the workspace’s preset of today', () => {
  const guard = (outcome: RunDecisionOutcome, detail: Record<string, unknown>, subject = 'smart') => decision({ kind: 'guard', outcome, subject, detail });

  it('an air-gapped workspace stops a call to any model but the local one', () => {
    const j = judgeGuard(guard('allow', { preset: 'standard', reason: null }), 'allowed', 'air-gapped');
    expect(j).toMatchObject({ now: 'refused', verdict: 'tighter' });
    expect(j.explanation).toContain('air-gapped');
    expect(judgeGuard(guard('allow', { preset: 'standard' }, 'local'), 'allowed', 'air-gapped').verdict).toBe('same');
  });

  it('a detection that was hidden is refused under the customer-facing preset, and the other way round', () => {
    expect(judgeGuard(guard('redact', { preset: 'standard', reason: null, rules: ['card'] }), 'redacted', 'customer-facing')).toMatchObject({ now: 'refused', verdict: 'tighter' });
    expect(judgeGuard(guard('block', { preset: 'customer-facing', reason: 'dlp', rules: ['card'] }), 'refused', 'standard')).toMatchObject({ now: 'redacted', verdict: 'looser' });
    expect(judgeGuard(guard('redact', { preset: 'standard', rules: ['card'] }), 'redacted', 'strict-egress').verdict).toBe('same');
  });

  it('a call that was only stopped by an air-gapped workspace goes through once it is not', () => {
    expect(judgeGuard(guard('block', { preset: 'air-gapped', reason: 'preset' }), 'refused', 'standard')).toMatchObject({ now: 'allowed', verdict: 'looser' });
  });

  it('a call that found nothing stays allowed, and an approval the bot asked for stands', () => {
    expect(judgeGuard(guard('allow', { preset: 'standard' }), 'allowed', 'customer-facing').verdict).toBe('same');
    expect(judgeGuard(guard('require_approval', { preset: 'standard', reason: 'dlp' }), 'waits_for_person', 'customer-facing').verdict).toBe('same');
  });

  it('limits, the check on a tool call’s data and an unreadable setting are not replayed', () => {
    expect(judgeGuard(guard('refused', { reason: 'budget' }), 'refused', 'standard').verdict).toBe('not_replayed');
    expect(judgeGuard(guard('refused', { reason: 'rate' }), 'refused', 'standard').verdict).toBe('not_replayed');
    expect(judgeGuard(guard('block', { rules: ['card'] }, 'mcp'), 'refused', 'standard').verdict).toBe('not_replayed');
    expect(judgeGuard(guard('allow', {}), 'allowed', null).verdict).toBe('not_replayed');
    expect(judgeGuard(guard('allow', {}), 'allowed', 'no-such-preset').verdict).toBe('not_replayed');
  });
});

describe('the tool door: the grants of today', () => {
  const tool = (outcome: RunDecisionOutcome, subject = 'messages.post') => decision({ kind: 'tool', outcome, subject });

  it('says what changed in plain words', () => {
    expect(judgeTool(tool('allowed'), 'allowed', { allowed: false, needsApproval: false })).toMatchObject({ now: 'refused', verdict: 'tighter' });
    expect(judgeTool(tool('denied'), 'refused', { allowed: true, needsApproval: false })).toMatchObject({ now: 'allowed', verdict: 'looser' });
    expect(judgeTool(tool('allowed'), 'allowed', { allowed: true, needsApproval: true })).toMatchObject({ now: 'waits_for_person', verdict: 'tighter' });
    expect(judgeTool(tool('allowed'), 'allowed', { allowed: true, needsApproval: false })).toMatchObject({ verdict: 'same' });
  });

  it('an answer the door could not give is not replayed', () => {
    expect(judgeTool(tool('allowed'), 'allowed', { unavailable: true }).verdict).toBe('not_replayed');
    expect(judgeTool(tool('allowed'), 'allowed', undefined).verdict).toBe('not_replayed');
  });

  it('never judges a call whose places were not all kept, and says so; a replay past its question limit says that instead', () => {
    const cut = decision({ kind: 'tool', outcome: 'allowed', subject: 'pages.write', detail: { truncated: true } });
    // even if the broker could be asked, a call that was recorded in part is not asked in part
    for (const now of [{ allowed: true, needsApproval: false }, { allowed: false, needsApproval: false }, undefined] as const) {
      const j = judgeTool(cut, 'allowed', now);
      expect(j.verdict).toBe('not_replayed');
      expect(j.explanation).toMatch(/more places than were kept/);
    }
    const many = judgeTool(tool('allowed'), 'allowed', { tooMany: true });
    expect(many.verdict).toBe('not_replayed');
    expect(many.explanation).toMatch(/too many different requests/);
    expect(many.explanation).not.toMatch(/could not be checked|permissions/);
  });

  it('says what a gate with no topic list means today without claiming anything about the list then', () => {
    const d = decision({ kind: 'gate', outcome: 'passed' });
    const same = judgeGate(d, 'allowed', text('hello'), { kind: 'none' });
    expect(same.verdict).toBe('same');
    expect(same.explanation).toMatch(/no topic list now/);
    expect(same.explanation).not.toMatch(/no topic list then/);
    const held = judgeGate(decision({ kind: 'gate', outcome: 'held' }), 'waits_for_person', text('hello'), { kind: 'none' });
    expect(held.verdict).toBe('looser');
    expect(held.explanation).toMatch(/waited for a person when the bot had a list/);
  });

  it('names the tool by what it does, never by its internal name', () => {
    const j = judgeTool(tool('allowed', 'pages.write'), 'allowed', { allowed: false, needsApproval: false });
    expect(j.explanation).toContain('write pages');
    expect(looksInternal(j.explanation)).toBe(false);
  });

  it('asks the door once for the same question', () => {
    const a = decision({ kind: 'tool', outcome: 'allowed', subject: 'pages.write', detail: { path: 'pages/a.md' } });
    const b = decision({ kind: 'tool', outcome: 'denied', subject: 'pages.write', detail: { path: 'pages/a.md' } });
    const c = decision({ kind: 'tool', outcome: 'allowed', subject: 'pages.write', detail: { path: 'pages/b.md' } });
    expect(toolKey(a)).toBe(toolKey(b));
    expect(toolKey(a)).not.toBe(toolKey(c));
    expect(toolKey(a)).not.toBe(toolKey({ ...a, trigger: 'mention' }));
  });
});

describe('the whole replay', () => {
  const facts = (decisions: RecordedDecision[], over: Partial<ReplayFacts> = {}): ReplayFacts => ({
    decisions,
    messages: new Map([[MSG, text('Please walk me through the credential rotation.')]]),
    gate: list('credential rotation'),
    preset: 'standard',
    tools: new Map(),
    ...over,
  });

  it('counts by kind, lists what changed newest first, and parses as the API shape', () => {
    const decisions = [
      decision({ kind: 'gate', outcome: 'passed', at: '2026-10-29T10:00:00.000Z' }),
      decision({ kind: 'guard', outcome: 'allow', at: '2026-10-30T10:00:00.000Z', detail: { preset: 'standard' } }),
      decision({ kind: 'guard', outcome: 'redact', at: '2026-10-28T10:00:00.000Z', detail: { preset: 'standard', rules: ['card'] } }),
    ];
    const out = evaluate(facts(decisions, { preset: 'customer-facing' }));
    expect(out.counts).toEqual({ total: 3, same: 1, tighter: 2, looser: 0, notReplayed: 0 });
    expect(out.byKind.gate).toMatchObject({ total: 1, tighter: 1 });
    expect(out.byKind.guard).toMatchObject({ total: 2, same: 1, tighter: 1 });
    expect(out.byKind.tool.total).toBe(0);
    expect(out.changes.map((c) => c.at)).toEqual(['2026-10-29T10:00:00.000Z', '2026-10-28T10:00:00.000Z']);
    expect(out.changesCapped).toBe(false);
    const whole = ReplayResult.parse({ days: 30, since: at, model: 'none', runs: 1, runsCapped: false, decisionsCapped: false, ...out, notes: [...REPLAY_NOTES], fullReplayable: [] });
    expect(JSON.stringify(whole)).not.toContain('credential rotation');
  });

  it('caps the list of changes and says so', () => {
    const many = Array.from({ length: 130 }, (_v, i) => decision({ kind: 'gate', outcome: 'passed', at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
    const out = evaluate(facts(many));
    expect(out.counts.tighter).toBe(130);
    expect(out.changes).toHaveLength(100);
    expect(out.changesCapped).toBe(true);
  });

  it('a record it does not understand is counted as not replayed', () => {
    const out = evaluate(facts([decision({ kind: 'gate', outcome: 'redact' })]));
    expect(out.counts.notReplayed).toBe(1);
  });

  it('states its limits and never claims to have called a model', () => {
    expect(REPLAY_NOTES.join(' ')).toContain('Nothing was sent to a model');
    for (const note of REPLAY_NOTES) expect(looksInternal(note)).toBe(false);
  });
});

describe('the notices of re-assessment', () => {
  it('has plain words for every reason, a headline and two to five things to look at', () => {
    for (const reason of REASSESSMENT_REASONS) {
      const t = describeReassessment(reason, 'handbook', { now: 0.7, before: 0.9, min: 0.8 });
      expect(t.headline.length, reason).toBeGreaterThan(10);
      expect(t.headline.length, reason).toBeLessThanOrEqual(200);
      expect(t.checks.length, reason).toBeGreaterThanOrEqual(2);
      expect(t.checks.length, reason).toBeLessThanOrEqual(5);
      for (const line of [t.headline, ...t.checks]) {
        expect(line.length, `${reason}: ${line}`).toBeLessThanOrEqual(300);
        expect(looksInternal(line), `${reason}: ${line}`).toBe(false);
      }
    }
  });

  it('names what changed and, for a score, the numbers', () => {
    expect(describeReassessment('knowledge_removed', 'handbook').headline).toContain('“handbook”');
    expect(describeReassessment('runner_revoked', 'office-box').headline).toContain('“office-box”');
    expect(describeReassessment('eval_dropped', '', { now: 0.7, before: 0.9, min: 0.8 }).headline).toBe('The bot’s test score dropped from 90% to 70%.');
    expect(describeReassessment('knowledge_added', 'manuals', undefined, true).headline).toMatch(/lists none, so it searches every base of its team/);
    expect(describeReassessment('knowledge_removed', 'manuals', undefined, true).headline).toMatch(/lists none/);
  });
});
