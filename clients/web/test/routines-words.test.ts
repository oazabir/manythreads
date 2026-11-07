import { describe, expect, it } from 'vitest';
import type { ScheduledJobRunId } from '@manythreads/shared';
import {
  allowancePercent,
  allowanceSentence,
  canRunNow,
  lastRunSentence,
  quietHoursProblem,
  quietHoursSentence,
  routineLook,
  sourcesSentence,
  sourcesUsedSentence,
  stopSentence,
  timeZoneProblem,
  turnOnLabel,
} from '../src/screens/files/routines/routinesWords';
import { CHANGED_UNDER_YOU, countLine, dueLabel, dueProblem, isConflict, splitItems } from '../src/screens/files/actionItems/actionItemsWords';

const item = (what: string, done: boolean) => ({ id: 'a1b2c3d4', what, owner: null, due: null, done, source: null, why: [], cardTaskId: null });

describe('routine words', () => {
  it('tells paused from stopped by the platform', () => {
    expect(routineLook({ enabled: true, stoppedReason: null })).toEqual({ tone: 'ok', label: 'On' });
    expect(routineLook({ enabled: false, stoppedReason: null }).label).toBe('Paused');
    expect(routineLook({ enabled: false, stoppedReason: 'spend_cap' }).label).toBe('Stopped');
  });
  it('says why a routine was stopped, and offers the right button', () => {
    expect(stopSentence({ stoppedReason: null })).toBeNull();
    expect(stopSentence({ stoppedReason: 'spend_cap' })).toBe('This routine was turned off because it used up your spending allowance for this month.');
    expect(turnOnLabel({ stoppedReason: 'bot_off' })).toBe('Turn back on');
    expect(turnOnLabel({ stoppedReason: null })).toBe('Turn on');
  });
  it('offers Run now only for a routine that is on and not stopped', () => {
    expect(canRunNow({ enabled: true, stoppedReason: null })).toBe(true);
    expect(canRunNow({ enabled: true, stoppedReason: 'bot_off' })).toBe(false);
    expect(canRunNow({ enabled: false, stoppedReason: null })).toBe(false);
  });
  it('says what the last run did', () => {
    expect(lastRunSentence(null)).toBe('It has not run yet.');
    expect(lastRunSentence({ id: '0192f0c4-1111-7000-8000-000000000001' as ScheduledJobRunId, status: 'failed', startedAt: '2026-11-07T07:30:00.000Z', endedAt: null, reason: 'Your mail is not connected.' })).toBe('The last run did not finish: Your mail is not connected.');
  });
  it('names what a routine looks at, in plain words', () => {
    expect(sourcesSentence([])).toBe('It does not look at anything of yours.');
    expect(sourcesSentence(['mail', 'mentions'])).toBe('It looks at your mail, mentions of you.');
  });
  it('counts what a run read per kind and never shows their text', () => {
    expect(sourcesUsedSentence({ sourcesUsed: [] })).toBe('It did not read anything.');
    expect(sourcesUsedSentence({ sourcesUsed: [{ type: 'mail', ref: 'x', scope: 'person' }, { type: 'mail', ref: 'y', scope: 'person' }, { type: 'action_items', ref: 'z', scope: 'person' }] })).toBe('It read mail 2, action items 1.');
  });
  it('says the allowance in dollars and caps the bar', () => {
    expect(allowanceSentence({ spentUsd: 1.2, monthlyCapUsd: 5 })).toBe('$1.20 of your $5.00 allowance used this month, $3.80 left. A routine stops when it is used up.');
    expect(allowancePercent({ spentUsd: 9, monthlyCapUsd: 5 })).toBe(100);
    expect(allowancePercent({ spentUsd: 0, monthlyCapUsd: 0 })).toBe(100);
    expect(allowanceSentence({ spentUsd: 0, monthlyCapUsd: 0 })).toContain('no spending allowance');
  });
  it('checks quiet hours and a time zone', () => {
    expect(quietHoursProblem('22:00', '07:00')).toBeNull();
    expect(quietHoursProblem('22:00', '22:00')).toBe('The quiet hours need two different times.');
    expect(quietHoursProblem('', '07:00')).toBe('Write both times like 22:00.');
    expect(quietHoursSentence({ from: '22:00', to: '07:00' })).toContain('between 22:00 and 07:00');
    expect(quietHoursSentence(null)).toBe('No quiet hours: a routine runs when it is due.');
    expect(timeZoneProblem('Asia/Dubai')).toBeNull();
    expect(timeZoneProblem('Mars/Base')).not.toBeNull();
    expect(timeZoneProblem('  ')).not.toBeNull();
  });
});

describe('action item words', () => {
  it('says a due date the way a person does', () => {
    expect(dueLabel('2026-11-07', '2026-11-07')).toEqual({ text: 'Due today', overdue: false });
    expect(dueLabel('2026-11-08', '2026-11-07')).toEqual({ text: 'Due tomorrow', overdue: false });
    expect(dueLabel('2026-11-06', '2026-11-07')).toEqual({ text: 'Was due yesterday', overdue: true });
    expect(dueLabel('2026-11-01', '2026-11-07')).toEqual({ text: 'Was due 1 Nov', overdue: true });
    expect(dueLabel('2026-12-24', '2026-11-07')).toEqual({ text: 'Due 24 Dec', overdue: false });
  });
  it('puts open items before finished ones and counts them', () => {
    const items = [item('b', true), item('a', false), item('c', false)];
    const { open, done } = splitItems(items);
    expect(open.map((i) => i.what)).toEqual(['a', 'c']);
    expect(done.map((i) => i.what)).toEqual(['b']);
    expect(countLine(items)).toBe('2 to do, 1 done.');
    expect(countLine([])).toBe('Nothing on your list yet.');
  });
  it('accepts only a real calendar day', () => {
    expect(dueProblem('')).toBeNull();
    expect(dueProblem('2026-11-20')).toBeNull();
    expect(dueProblem('2026-02-30')).toBe('That is not a real date.');
    expect(dueProblem('next friday')).toBe('Pick a date.');
  });
  it('knows a refused stale edit and says the change was not saved', () => {
    expect(isConflict({ status: 409 })).toBe(true);
    expect(isConflict(new Error('x'))).toBe(false);
    expect(CHANGED_UNDER_YOU).toContain('not saved');
  });
});
