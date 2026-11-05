import type { ChannelMessage } from '@manythreads/shared';

const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const DAY_PARTS = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const STAMP = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export { toneOf } from '../components/tone';

export const clock = (iso: string): string => CLOCK.format(new Date(iso));

/** A calendar day in the reader's time zone, as a sortable key. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Today", "Yesterday", "Monday 7 September" (with the year when it is not this one). */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  // assembled from parts so the punctuation does not depend on the browser's locale data: "Monday 7 September"
  const part = (type: Intl.DateTimeFormatPartTypes): string => DAY_PARTS.formatToParts(d).find((p) => p.type === type)?.value ?? '';
  const label = `${part('weekday')} ${part('day')} ${part('month')}`;
  return d.getFullYear() === now.getFullYear() ? label : `${label} ${d.getFullYear()}`;
}

/** The full date and time of a message, for a tooltip: "Mon 26 Oct, 20:39" (with the year when it is not this one). */
export function fullStamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const part = (type: Intl.DateTimeFormatPartTypes): string => STAMP.formatToParts(d).find((p) => p.type === type)?.value ?? '';
  const label = `${part('weekday')} ${part('day')} ${part('month')}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`}`;
  return `${label}, ${clock(iso)}`;
}

/** "now", "2m", "1h", "Fri", "3 Sep": how long ago, for the Threads inbox. */
export function ago(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 45) return 'now';
  if (s < 3_600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86_400) return `${Math.round(s / 3_600)}h`;
  if (s < 6 * 86_400) return WEEKDAY.format(d);
  return SHORT.format(d);
}

/** "Last reply 2h ago", "Last reply just now", "Last reply Fri" / "Last reply 3 Sep": under the reply count. */
export function lastReplyText(iso: string, now: Date = new Date()): string {
  const a = ago(iso, now);
  if (a === 'now') return 'Last reply just now';
  return /^\d+[mh]$/.test(a) ? `Last reply ${a} ago` : `Last reply ${a}`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

/** The two to four letter label on an attachment card. */
export function fileKind(name: string, mime: string): { label: string; tone: 'pdf' | 'img' | 'md' | 'zip' | 'file' } {
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1] ?? '').toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return { label: 'PDF', tone: 'pdf' };
  if (mime.startsWith('image/')) return { label: ext ? ext.toUpperCase().slice(0, 3) : 'IMG', tone: 'img' };
  if (ext === 'md' || ext === 'markdown') return { label: 'MD', tone: 'md' };
  if (['zip', 'gz', 'tgz', 'tar', '7z'].includes(ext)) return { label: ext.toUpperCase().slice(0, 3), tone: 'zip' };
  return { label: ext ? ext.toUpperCase().slice(0, 3) : 'FILE', tone: 'file' };
}

/** What to assume a message's height is before it has been drawn (the list corrects it with the real height). */
export function estimateMessageHeight(m: Pick<ChannelMessage, 'body' | 'reactions' | 'replyCount'> & { attachments?: readonly unknown[] }): number {
  const lines = m.body.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 88)), 0);
  // a long text is clamped to four lines with a "Show more" line under it (P21-03)
  return 30 + (lines > 6 ? 4 * 21 + 26 : lines * 21) + (m.reactions.length > 0 ? 30 : 0) + (m.replyCount > 0 ? 28 : 0) + (m.attachments?.length ?? 0) * 46;
}
