import { CHANNEL_SUMMARY_RANGES, THREAD_SUMMARY_RANGES, type SummariseResponse, type SummaryRange } from '@manythreads/shared';

/*
 * The rules of the Summary panel (P18-05, docs/plans/catch-me-up.md), apart from React so a test can run them, and the panel's type, which the channel menu, the
 * channel view and the thread need without loading the panel.
 */

/** The type of the panel entry: `summary:<channelId>` or `summary:<channelId>.<threadRootId>`; registered in `kernel/panel/builtins.tsx`. */
export const SUMMARY_PANEL = 'summary';

export type SummaryPlace = { channelId: string; threadRootId: string | null };

export const summaryPanelId = (p: SummaryPlace): string => (p.threadRootId ? `${p.channelId}.${p.threadRootId}` : p.channelId);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The place a panel id names, or null for an id that is not one. */
export function parseSummaryPanelId(id: string): SummaryPlace | null {
  const [channelId, threadRootId, extra] = id.split('.');
  if (extra !== undefined || !channelId || !UUID.test(channelId)) return null;
  if (threadRootId !== undefined && !UUID.test(threadRootId)) return null;
  return { channelId, threadRootId: threadRootId ?? null };
}

/**
 * Where "Since I last read" starts: the read position a screen opened with, kept here for the panel (the screen marks the place read as soon as it is on screen, so
 * the stored position has already moved). In memory only: after a reload the server's stored position is used.
 */
const starts = new Map<string, string | null>();
export const rememberReadStart = (p: SummaryPlace, lastReadId: string | null): void => void starts.set(summaryPanelId(p), lastReadId);
/** `undefined` when nothing was remembered (the server then uses the stored position). */
export const readStartOf = (p: SummaryPlace): string | null | undefined => (starts.has(summaryPanelId(p)) ? starts.get(summaryPanelId(p)) : undefined);
/** Whether the screen opened with something unread there. */
const unreadAtOpen = new Set<string>();
export const rememberUnread = (p: SummaryPlace, unread: boolean): void => void (unread ? unreadAtOpen.add(summaryPanelId(p)) : unreadAtOpen.delete(summaryPanelId(p)));

/**
 * The choices the panel shows. "Since I was away" is a channel's, and only for a person who is out of office or came back in the last two weeks (`MyPresence.away`);
 * the default stays "Since I last read", which already covers the days away for a place not read since.
 */
export const rangesOf = (p: SummaryPlace, away = false): readonly SummaryRange[] =>
  p.threadRootId ? THREAD_SUMMARY_RANGES : CHANNEL_SUMMARY_RANGES.filter((r) => r !== 'away' || away);

/** The range the panel starts with: since the last read when there was something unread, else the last day (a thread: all of it). */
export function defaultRange(p: SummaryPlace): SummaryRange {
  if (unreadAtOpen.has(summaryPanelId(p))) return 'new';
  return p.threadRootId ? 'all' : 'day';
}

export const RANGE_LABEL: Record<SummaryRange, string> = { new: 'Since I last read', day: 'Last 24 hours', week: 'Last 7 days', all: 'Whole thread', away: 'Since I was away' };

/** "Nothing new since you last read #dev." and the like. */
export function emptyText(range: SummaryRange, placeName: string): string {
  if (range === 'new') return `Nothing new since you last read ${placeName}.`;
  if (range === 'all') return 'This thread has no replies yet.';
  if (range === 'away') return `Nothing was written in ${placeName} while you were away.`;
  return `Nothing was written in ${placeName} in the ${range === 'day' ? 'last 24 hours' : 'last 7 days'}.`;
}

const count = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const time = (iso: string, now: Date): string => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? clock : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock}`;
};

type Ready = Extract<SummariseResponse, { state: 'ready' }>;

/** "From 48 messages, 9:02 to 16:40." and, for a place that was too long, what was left out. */
export function coverageText(s: Ready, now: Date = new Date()): string[] {
  const out = [`From ${count(s.readCount, 'message', 'messages')}, ${time(s.from, now)} to ${time(s.to, now)}.`];
  if (s.leftOut > 0) out.push(`The ${count(s.readCount, 'newest message was', 'newest messages were')} read; ${count(s.leftOut, 'older one was', 'older ones were')} left out.`);
  return out;
}

/** The name of the file "Save to my files" makes: `#dev 2026-11-25 0914.md`, without characters a file name cannot hold. */
export function summaryFileName(placeName: string, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stampText = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}`;
  const plain = [...placeName].map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? ' ' : c)).join('');
  const safe = plain.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Summary';
  return `${safe} ${stampText}.md`;
}

/** What the file holds: a title line, the summary, where it came from, and a link for each number it cites (`linkOf` answers an address, or null). */
export function summaryFileText(s: Ready, placeName: string, at: Date, linkOf: (source: Ready['sources'][number]) => string | null = () => null): string {
  const links = s.sources.map((src) => ({ n: src.n, href: linkOf(src) })).filter((l): l is { n: number; href: string } => l.href !== null);
  return [
    `# Summary of ${placeName}`,
    '',
    `${RANGE_LABEL[s.range]} · written by ${s.botName} on ${at.toLocaleString()}`,
    '',
    s.body,
    '',
    ...coverageText(s, at),
    ...(links.length > 0 ? ['', 'Messages:', ...links.map((l) => `- [${l.n}] ${l.href}`)] : []),
  ].join('\n');
}

export const SUMMARY_FOLDER = 'Summaries';
