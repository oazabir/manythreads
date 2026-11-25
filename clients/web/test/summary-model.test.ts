import { describe, expect, it } from 'vitest';
import type { SummariseResponse } from '@manythreads/shared';
import {
  RANGE_LABEL,
  SUMMARY_PANEL,
  coverageText,
  defaultRange,
  emptyText,
  parseSummaryPanelId,
  rangesOf,
  readStartOf,
  rememberReadStart,
  rememberUnread,
  summaryFileName,
  summaryFileText,
  summaryPanelId,
} from '../src/channels/summaryModel';

// P18-05: the Summary panel's rules (docs/plans/catch-me-up.md): the panel id, the ranges and which one it starts with, where "Since I last read" starts, and the
// words and file of a summary.

const C = '0190c3a0-0000-7000-8000-000000000001';
const R = '0190c3a0-0000-7000-8000-000000000002';
type Ready = Extract<SummariseResponse, { state: 'ready' }>;
const ready = (over: Partial<Ready> = {}): Ready =>
  ({
    state: 'ready',
    range: 'new',
    body: '- Ship on Friday [1]',
    sources: [{ n: 1, messageId: R, threadRootId: null }],
    messageCount: 48,
    readCount: 48,
    leftOut: 0,
    from: '2026-11-25T09:02:00.000Z',
    to: '2026-11-25T16:40:00.000Z',
    botName: 'Brain',
    ...over,
  }) as Ready;

describe('the Summary panel', () => {
  it('names a channel or a thread in its id, and refuses anything else', () => {
    expect(SUMMARY_PANEL).toBe('summary');
    expect(summaryPanelId({ channelId: C, threadRootId: null })).toBe(C);
    expect(parseSummaryPanelId(summaryPanelId({ channelId: C, threadRootId: R }))).toEqual({ channelId: C, threadRootId: R });
    expect(parseSummaryPanelId(C)).toEqual({ channelId: C, threadRootId: null });
    for (const bad of ['', 'x', `${C}.${R}.${R}`, `${C}.nope`, `../${C}`]) expect(parseSummaryPanelId(bad), bad).toBeNull();
  });

  it('offers a channel three ranges and a thread two, and starts since the last read only when there was something unread', () => {
    const channel = { channelId: C, threadRootId: null };
    const thread = { channelId: C, threadRootId: R };
    expect(rangesOf(channel).map((r) => RANGE_LABEL[r])).toEqual(['Since I last read', 'Last 24 hours', 'Last 7 days']);
    expect(rangesOf(thread).map((r) => RANGE_LABEL[r])).toEqual(['Whole thread', 'Since I last read']);
    expect(defaultRange(channel)).toBe('day');
    expect(defaultRange(thread)).toBe('all');
    rememberUnread(channel, true);
    expect(defaultRange(channel)).toBe('new');
    rememberUnread(channel, false);
    expect(defaultRange(channel)).toBe('day');
  });

  it('keeps the read position the screen opened with; unknown means the server decides, null means nothing was read', () => {
    const place = { channelId: C, threadRootId: R };
    expect(readStartOf(place)).toBeUndefined();
    rememberReadStart(place, null);
    expect(readStartOf(place)).toBeNull();
    rememberReadStart(place, R);
    expect(readStartOf(place)).toBe(R);
  });

  it('says what it covered and what it left out, in plain words', () => {
    const now = new Date('2026-11-25T18:00:00.000Z');
    expect(coverageText(ready(), now)[0]).toMatch(/^From 48 messages, .+ to .+\.$/);
    expect(coverageText(ready(), now)).toHaveLength(1);
    expect(coverageText(ready({ readCount: 400, leftOut: 1120 }), now)[1]).toBe('The 400 newest messages were read; 1,120 older ones were left out.');
    expect(coverageText(ready({ readCount: 1, leftOut: 1 }), now)[1]).toBe('The 1 newest message was read; 1 older one was left out.');
    expect(emptyText('new', '#dev')).toBe('Nothing new since you last read #dev.');
    expect(emptyText('week', '#dev')).toBe('Nothing was written in #dev in the last 7 days.');
    expect(emptyText('all', 'this thread')).toBe('This thread has no replies yet.');
  });

  it('saves a file with a safe name, the summary, where it came from and a link for each number', () => {
    const at = new Date(2026, 10, 25, 9, 4);
    expect(summaryFileName('#dev', at)).toBe('#dev 2026-11-25 0904.md');
    expect(summaryFileName('a/b:c*?"<>|\u0001', at)).toBe('a b c 2026-11-25 0904.md');
    expect(summaryFileName('', at)).toBe('Summary 2026-11-25 0904.md');
    const text = summaryFileText(ready(), '#dev', at, (s) => `https://example.test/t/eng/c/dev?message=${s.messageId}`);
    expect(text.split('\n')[0]).toBe('# Summary of #dev');
    expect(text).toContain('- Ship on Friday [1]');
    expect(text).toContain(`- [1] https://example.test/t/eng/c/dev?message=${R}`);
    expect(summaryFileText(ready(), '#dev', at)).not.toContain('Messages:');
  });
});
