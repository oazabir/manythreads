import type { Approval, RunHead, ThreadInboxItem, ThreadTodo } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { filterThreads, fold, highlight, matchThread, mentionsParam, mergeFiltered, needsYou, orderThreads, parseFilter, progressOf, resolveNames, NOT_NEEDED } from '../src/inbox/rules';

// P29-15: every rule of the Threads view that is not drawing: how the filter box is read and matched, who "needs you", the order, and the one line of progress.

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, over: Partial<ThreadInboxItem> = {}): ThreadInboxItem =>
  ({
    rootMessageId: id(n),
    channel: { id: id(900 + n), name: 'dev', kind: 'channel', teamId: id(1), private: false },
    title: `Thread ${n}`,
    rootAuthorId: id(500),
    replyCount: 3,
    lastReplyAt: new Date(Date.UTC(2026, 10, 16, 12, 0, 0) - n * 60_000).toISOString(),
    followed: true,
    unreadCount: 0,
    mine: false,
    rootAuthor: null,
    participants: [],
    participantCount: 0,
    mentionCount: 0,
    lastReply: null,
    mention: null,
    ...over,
  }) as unknown as ThreadInboxItem;

describe('reading the filter box', () => {
  it('splits free words from @names, folds case and accents, drops repeats and a lone @', () => {
    expect(parseFilter('  Deploy  ÉTÉ deploy @Nadia @ @nadia ')).toEqual({ words: ['deploy', 'ete'], names: ['nadia'], empty: false });
    expect(parseFilter('   ')).toEqual({ words: [], names: [], empty: true });
    expect(parseFilter('@')).toMatchObject({ empty: true });
    expect(fold('Crème')).toBe('creme');
  });

  it('keeps the first six words and five names', () => {
    const p = parseFilter('a b c d e f g h @1 @2 @3 @4 @5 @6');
    expect(p.words).toHaveLength(6);
    expect(p.names).toHaveLength(5);
  });

  it('resolves a name to every person or bot it starts; a name nobody has is unmatched', () => {
    const roster = {
      people: [
        { actorId: 'a1', name: 'Nadia Karim', email: 'nadia@x.io' },
        { actorId: 'a2', name: 'Sam Lee', email: 'sam.lee@x.io' },
        { actorId: 'a3', name: 'Samira Noor', email: 'samira@x.io' },
      ],
      bots: [{ actorId: 'b1', slug: 'engineer', name: 'Engineer' }],
    };
    expect(resolveNames(['nad'], roster)).toEqual({ groups: [['a1']], unmatched: [] });
    expect(resolveNames(['sam'], roster).groups[0]).toEqual(['a2', 'a3']); // both Sams: either counts
    expect(resolveNames(['karim', 'engin'], roster)).toEqual({ groups: [['a1'], ['b1']], unmatched: [] });
    expect(resolveNames(['zed'], roster)).toEqual({ groups: [], unmatched: ['zed'] });
    expect(mentionsParam([['a2', 'a3'], ['b1']])).toBe('a2|a3,b1');
    expect(mentionsParam([])).toBeUndefined();
  });
});

describe('matching the loaded rows', () => {
  const releases = row(1, { channel: { id: id(901), name: 'releases', kind: 'channel' } as ThreadInboxItem['channel'], title: 'Cut over to EU' });
  const dev = row(2, { title: 'The releases checklist is stale', lastReply: { authorName: 'Rafi', preview: 'will fix it today' } });
  const other = row(3, { title: 'Lunch plans' });

  it('is a channel match when a word is in the channel name, a message match when it is only in the text, nothing otherwise', () => {
    expect(matchThread(releases, ['releases'])).toBe('channel');
    expect(matchThread(dev, ['releases'])).toBe('message');
    expect(matchThread(other, ['releases'])).toBeNull();
  });

  it('needs every word, anywhere in the row, and sees the latest reply and the mention', () => {
    expect(matchThread(dev, ['releases', 'fix'])).toBe('message');
    expect(matchThread(dev, ['releases', 'nope'])).toBeNull();
    expect(matchThread(row(4, { mention: { messageId: id(99), authorId: id(5), authorName: 'Rafi', kind: 'person', at: '2026-11-16T10:00:00.000Z', preview: 'please check the quokka' } }), ['quokka'])).toBe('message');
  });

  it('lists channel-name matches first, then message matches, each in the order they came', () => {
    expect(filterThreads([dev, other, releases], ['releases']).map((r) => r.rootMessageId)).toEqual([releases.rootMessageId, dev.rootMessageId]);
    expect(filterThreads([dev, other, releases], []).map((r) => r.rootMessageId)).toEqual([dev.rootMessageId, other.rootMessageId, releases.rootMessageId]);
  });

  it('puts the server answer first and adds the rows only this side matched', () => {
    expect(mergeFiltered([releases], [dev, releases]).map((r) => r.rootMessageId)).toEqual([releases.rootMessageId, dev.rootMessageId]);
  });
});

describe('highlighting a match', () => {
  it('marks every occurrence, ignoring case and accents, and keeps the original letters', () => {
    expect(highlight('Deploy the deploys, déployer', ['deploy'])).toEqual([
      { text: 'Deploy', hit: true },
      { text: ' the ', hit: false },
      { text: 'deploy', hit: true },
      { text: 's, ', hit: false },
      { text: 'déploy', hit: true },
      { text: 'er', hit: false },
    ]);
    expect(highlight('Été', ['ete'])).toEqual([{ text: 'Été', hit: true }]);
  });

  it('is one plain piece with no words or no match', () => {
    expect(highlight('plain text', [])).toEqual([{ text: 'plain text', hit: false }]);
    expect(highlight('plain text', ['zzz'])).toEqual([{ text: 'plain text', hit: false }]);
    expect(highlight('', ['a'])).toEqual([{ text: '', hit: false }]);
  });

  it('marks overlapping words as one run', () => {
    expect(highlight('deploy plan', ['deploy', 'loy p'])).toEqual([{ text: 'deploy p', hit: true }, { text: 'lan', hit: false }]);
  });
});

const approval = (over: Partial<Approval> = {}): Approval => ({ id: id(700), status: 'pending', canDecide: true, createdAt: '2026-11-16T09:00:00.000Z', ...over }) as unknown as Approval;
const mention = (at: string) => ({ messageId: id(800), authorId: id(5), authorName: 'Rafi', kind: 'person' as const, at, preview: 'can you decide?' });

describe('who needs you', () => {
  it('is nobody when nothing waits', () => {
    expect(needsYou(row(1), [])).toBe(NOT_NEEDED);
  });

  it('needs the person for a pending approval they may decide, not one they may not, not a settled one', () => {
    expect(needsYou(row(1), [approval()]).needs).toBe(true);
    expect(needsYou(row(1), [approval({ canDecide: false })]).needs).toBe(false);
    expect(needsYou(row(1), [approval({ status: 'approved' })]).needs).toBe(false);
  });

  it('needs the person for an unanswered mention, and takes the older of the two as the time it began to wait', () => {
    const m = needsYou(row(1, { mention: mention('2026-11-16T11:00:00.000Z') }), []);
    expect(m).toMatchObject({ needs: true, approval: null, since: '2026-11-16T11:00:00.000Z' });
    const both = needsYou(row(1, { mention: mention('2026-11-16T11:00:00.000Z') }), [approval({ createdAt: '2026-11-16T10:00:00.000Z' }), approval({ id: id(701), createdAt: '2026-11-16T08:00:00.000Z' })]);
    expect(both.since).toBe('2026-11-16T08:00:00.000Z');
    expect(both.approval?.id).toBe(id(701));
  });

  it('orders the rows that need the person first, the longest waiting on top, the rest as they came; "time" leaves one part', () => {
    const rows = [row(1), row(2, { mention: mention('2026-11-16T11:00:00.000Z') }), row(3), row(4, { mention: mention('2026-11-16T07:00:00.000Z') })];
    const needs = (root: string): ReturnType<typeof needsYou> => needsYou(rows.find((r) => r.rootMessageId === root)!, []);
    const a = orderThreads(rows, needs, 'needs');
    expect(a.needs.map((r) => r.rootMessageId)).toEqual([id(4), id(2)]);
    expect(a.rest.map((r) => r.rootMessageId)).toEqual([id(1), id(3)]);
    const b = orderThreads(rows, needs, 'time');
    expect(b.needs).toEqual([]);
    expect(b.rest.map((r) => r.rootMessageId)).toEqual([id(1), id(2), id(3), id(4)]);
  });
});

const todo = (statuses: Array<'waiting' | 'working' | 'blocked' | 'done'>): ThreadTodo =>
  ({ rootId: id(1), title: 'Ship the fix', version: 1, updatedAt: '2026-11-16T10:00:00.000Z', items: statuses.map((status, i) => ({ id: `i${i}`, text: `Step ${i + 1}`, status })) }) as unknown as ThreadTodo;
const head = (now: RunHead['now']): RunHead => ({ state: 'working', now }) as unknown as RunHead;

describe('the one line of progress on a row', () => {
  it('says "2 of 4", the bar and the item being worked on', () => {
    expect(progressOf(todo(['done', 'done', 'working', 'waiting']), null)).toEqual({ kind: 'todo', count: '2 of 4', pct: 50, text: 'Step 3', tone: 'working', allDone: false });
  });

  it('names the bot that is working on it when a run is going', () => {
    expect(progressOf(todo(['done', 'working']), { botName: 'Engineer' })?.text).toBe('Step 2 · Engineer');
  });

  it('shows a blocked item as blocked and a finished list as done', () => {
    expect(progressOf(todo(['done', 'blocked', 'waiting']), null)).toMatchObject({ tone: 'blocked', text: 'Step 2' });
    expect(progressOf(todo(['done', 'done']), null)).toMatchObject({ count: '2 of 2 done', pct: 100, tone: 'done', allDone: true, text: 'Ship the fix' });
  });

  it('is the run when there is no list: bot and what it does now', () => {
    expect(progressOf(null, { botName: 'Engineer', head: head({ kind: 'command', title: 'pnpm lint', paths: [], helper: null, count: 1 }) })?.text).toMatch(/^Engineer · /);
    expect(progressOf(null, { botName: 'Engineer' })).toMatchObject({ kind: 'run', text: 'Engineer · Working', count: null, pct: null });
  });

  it('says nothing when there is no list and no run', () => {
    expect(progressOf(null, null)).toBeNull();
    expect(progressOf(todo([]), null)).toBeNull();
  });
});
