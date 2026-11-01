import { IMPORT_SKIP_REASONS, IMPORT_STATUSES, type ImportRun } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { STATUS_WORDS, actionsFor, channelOutcomeWords, formatSize, isActive, progressFraction, progressWords, skippedLine, tooBigWarning } from '../src/screens/import/format';

type P = Pick<ImportRun, 'status' | 'progress'>;
const progress = (done: number, total: number, phase: 'people' | 'channels' | 'messages' | 'finishing' = 'messages'): ImportRun['progress'] => ({
  phase,
  messagesDone: done,
  messagesTotal: total,
  channelsDone: 0,
  channelsTotal: 0,
});

describe('import screen words', () => {
  it('has a plain sentence for every status and every reason a thing is left out', () => {
    for (const s of IMPORT_STATUSES) expect(STATUS_WORDS[s], s).toMatch(/\w/);
    for (const r of IMPORT_SKIP_REASONS) expect(skippedLine(r, 3), r).toMatch(/^3 \w/);
  });

  it('shows sizes in the unit a person reads', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(300 * 1024 * 1024)).toBe('300 MB');
    expect(formatSize(1024 ** 3)).toBe('1.0 GB');
  });

  it('warns about a file over the default limit, and only then', () => {
    expect(tooBigWarning(1024 ** 3)).toBeNull();
    expect(tooBigWarning(2 * 1024 ** 3)).toMatch(/2\.0 GB/);
  });
});

describe('progress', () => {
  it('is a fraction between 0 and 1, and null when nothing is known', () => {
    expect(progressFraction({ progress: null })).toBeNull();
    expect(progressFraction({ progress: progress(0, 0) })).toBeNull();
    expect(progressFraction({ progress: progress(50, 200) })).toBe(0.25);
    expect(progressFraction({ progress: progress(300, 200) })).toBe(1);
  });

  it('says what the job is doing in words', () => {
    const run = (status: ImportRun['status'], p: ImportRun['progress']): P => ({ status, progress: p });
    expect(progressWords(run('queued', null))).toMatch(/waiting/i);
    expect(progressWords(run('analysing', null))).toMatch(/nothing is written/i);
    expect(progressWords(run('running', progress(1200, 4000)))).toBe('Writing messages: 1,200 of 4,000 messages.');
    expect(progressWords(run('running', progress(0, 0, 'people')))).toBe('Matching people.');
  });
});

describe('what a run offers', () => {
  it('lets a run be read, started, cancelled or removed only when that makes sense', () => {
    expect(actionsFor('uploaded')).toEqual({ dryRun: true, start: false, cancel: false, remove: true });
    expect(actionsFor('analysed')).toEqual({ dryRun: true, start: true, cancel: false, remove: true });
    for (const s of ['analysing', 'queued', 'running'] as const) expect(actionsFor(s), s).toEqual({ dryRun: false, start: false, cancel: true, remove: false });
    for (const s of ['done', 'failed', 'cancelled'] as const) expect(actionsFor(s), s).toEqual({ dryRun: false, start: false, cancel: false, remove: true });
  });

  it('keeps asking the server only while a job is working', () => {
    expect(IMPORT_STATUSES.filter(isActive)).toEqual(['analysing', 'queued', 'running']);
  });
});

describe('what the screen says about a channel and a left-out kind', () => {
  it('names the reason in words, not as a code', () => {
    expect(channelOutcomeWords({ outcome: 'skip', reason: 'dm_not_matched', becomes: null })).toBe('left out (direct conversation where someone has no account here)');
    expect(channelOutcomeWords({ outcome: 'skip', reason: null, becomes: null })).toBe('left out');
    expect(channelOutcomeWords({ outcome: 'exists', reason: null, becomes: null })).toBe('already there');
    expect(channelOutcomeWords({ outcome: 'create', reason: null, becomes: 'dev-ops' })).toBe('becomes #dev-ops');
    for (const r of IMPORT_SKIP_REASONS) expect(channelOutcomeWords({ outcome: 'skip', reason: r, becomes: null }), r).not.toMatch(/_/);
  });

  it('uses the singular for a count of one and the plural otherwise', () => {
    expect(skippedLine('huddle', 1)).toBe('1 huddle');
    expect(skippedLine('huddle', 2)).toBe('2 huddles');
    expect(skippedLine('orphan_reply', 1)).toMatch(/^1 reply whose/);
    expect(skippedLine('orphan_reply', 1200)).toMatch(/^1,200 replies whose/);
    for (const r of IMPORT_SKIP_REASONS) expect(skippedLine(r, 1), r).not.toMatch(/^1 \w+s\b.*\bare\b/);
  });
});
