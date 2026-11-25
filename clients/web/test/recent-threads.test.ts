import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RECENT_THREADS, parseRecentThreads, pushRecentThread, readRecentThreads, recordRecentThread, titleLine, type RecentThread } from '../src/app/recentThreads';
import { openedWords, recentThreadRows } from '../src/screens/summaries/summaries';

const base = new Date(2026, 10, 25, 10, 0, 0);
const iso = (minutesAgo: number): string => new Date(base.getTime() - minutesAgo * 60_000).toISOString();
const visit = (id: string, minutesAgo = 0, over: Partial<RecentThread> = {}): RecentThread => ({ rootId: id, channelId: 'c1', channelKind: 'channel', channelName: 'dev', title: `Thread ${id}`, at: iso(minutesAgo), ...over });

afterEach(() => vi.unstubAllGlobals());

const stubStorage = (): Map<string, string> => {
  const m = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
  return m;
};

describe('titleLine', () => {
  it('takes the first line with words, folded to one line and cut', () => {
    expect(titleLine('\n  Deploy   plan \nsecond line')).toBe('Deploy plan');
    expect(titleLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(titleLine('')).toBe('');
  });
});

describe('pushRecentThread', () => {
  it('puts the thread first and drops its earlier copy', () => {
    const list = pushRecentThread([visit('a', 5), visit('b', 9)], visit('b', 0));
    expect(list.map((e) => e.rootId)).toEqual(['b', 'a']);
    expect(list[0]?.at).toBe(iso(0));
  });
  it('keeps the newest ten', () => {
    let list: RecentThread[] = [];
    for (let i = 0; i < 14; i += 1) list = pushRecentThread(list, visit(`t${i}`, 14 - i));
    expect(list).toHaveLength(MAX_RECENT_THREADS);
    expect(list[0]?.rootId).toBe('t13');
    expect(list.at(-1)?.rootId).toBe('t4');
  });
});

describe('parseRecentThreads', () => {
  it('drops damaged entries and repeats, and orders newest first', () => {
    const raw = [visit('a', 30), { rootId: 'x' }, null, 'text', { ...visit('b', 2), at: 'not a time' }, visit('c', 1), visit('a', 40)];
    expect(parseRecentThreads(raw).map((e) => e.rootId)).toEqual(['c', 'a']);
  });
  it('reads anything that is not a list as none', () => {
    expect(parseRecentThreads({})).toEqual([]);
    expect(parseRecentThreads(undefined)).toEqual([]);
  });
});

describe('the stored list', () => {
  it('is kept per person and per team', () => {
    stubStorage();
    recordRecentThread('p1', 'eng', visit('a', 3));
    recordRecentThread('p1', 'eng', visit('b', 2));
    recordRecentThread('p1', 'eng', visit('a', 0));
    recordRecentThread('p2', 'eng', visit('z', 0));
    recordRecentThread('p1', 'ops', visit('y', 0));
    expect(readRecentThreads('p1', 'eng').map((e) => e.rootId)).toEqual(['a', 'b']);
    expect(readRecentThreads('p2', 'eng').map((e) => e.rootId)).toEqual(['z']);
    expect(readRecentThreads('p1', 'ops').map((e) => e.rootId)).toEqual(['y']);
  });
  it('reads damaged text as none', () => {
    const m = stubStorage();
    m.set('manythreads.recentThreads.p1.eng', '{not json');
    expect(readRecentThreads('p1', 'eng')).toEqual([]);
  });
  it('does not fail when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readRecentThreads('p1', 'eng')).toEqual([]);
    expect(() => recordRecentThread('p1', 'eng', visit('a'))).not.toThrow();
  });
});

describe('openedWords', () => {
  it('says when it was opened', () => {
    expect(openedWords(iso(0), base)).toBe('Opened just now');
    expect(openedWords(iso(20), base)).toBe('Opened 20 minutes ago');
    expect(openedWords(iso(60 * 3), base)).toBe('Opened 3 hours ago');
    expect(openedWords('nope', base)).toBe('');
  });
});

describe('recentThreadRows', () => {
  it('lists the newest first, one row per thread, at most ten, each linking to the thread', () => {
    const visited = Array.from({ length: 12 }, (_, i) => visit(`t${i}`, i + 1));
    visited.push(visit('t0', 90));
    const rows = recentThreadRows(visited, 'eng', base);
    expect(rows).toHaveLength(10);
    expect(rows[0]?.key).toBe('visited:t0');
    expect(rows[0]?.to).toBe('/t/eng/threads?thread=t0');
    expect(new Set(rows.map((r) => r.key)).size).toBe(10);
    expect(rows[0]?.meta).toBe('#dev · Opened 1 minute ago');
  });
  it('names a direct message and a chat with a bot in words, and a missing title', () => {
    const rows = recentThreadRows([visit('d', 1, { channelKind: 'dm', channelName: '', title: '' }), visit('b', 2, { channelKind: 'bot_conversation', channelName: '' })], 'eng', base);
    expect(rows[0]?.title).toBe('Untitled thread');
    expect(rows[0]?.meta).toBe('Direct message · Opened 1 minute ago');
    expect(rows[1]?.meta).toBe('Conversation with a bot · Opened 2 minutes ago');
  });
  it('adds who wrote last and the reply count when the Threads list has the thread', () => {
    const inbox = [{ rootMessageId: 'a', title: 'Fresh title', replyCount: 3, lastReply: { authorName: 'Nadia', preview: 'ok' }, channel: { kind: 'channel', name: 'dev' } }] as never;
    const [row, other] = recentThreadRows([visit('a', 20), visit('b', 30)], 'eng', base, inbox);
    expect(row?.title).toBe('Fresh title');
    expect(row?.meta).toBe('#dev · Nadia wrote last · 3 replies · Opened 20 minutes ago');
    expect(other?.meta).toBe('#dev · Opened 30 minutes ago');
  });
  it('is empty for nothing visited', () => {
    expect(recentThreadRows([], 'eng', base)).toEqual([]);
  });
});
