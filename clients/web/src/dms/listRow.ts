import { REMINDERS_DM_KEY_PREFIX, type DirectMessageSummary } from '@manythreads/shared';
import type { MessageChange } from '../channels/store';
import { clock, fullStamp } from '../channels/format';

/*
 * The Messages page as a chat app's list (P34-05, finding 23 and correction 9 of docs/plans/everyday-screens.md): each conversation is the face, the name, the
 * last line and its time, and the unread count. The server's DM list already carries the last message and the count (`DirectMessageSummary`); while the page is
 * open, a message that arrives, is edited or is deleted in a conversation changes its row here (`withMessageChange`), and the count comes from the channel store.
 */

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const SHORT_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** The time of a row's last message: "14:05" today, "Yesterday", "Mon" this week, "3 Nov" this year, else "3 Nov 2025". */
export function listTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return clock(iso);
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAY.format(d);
  return d.getFullYear() === now.getFullYear() ? SHORT.format(d) : SHORT_YEAR.format(d);
}

export type DmListRow = {
  channelId: string;
  label: string;
  /** The face: the other person in a one-to-one, else none (a group, Reminders, notes to self draw the name's initials). */
  peerId: string | null;
  kind: 'person' | 'group' | 'reminders' | 'self';
  /** The last line, with who wrote it when that is not obvious ("You: ...", in a group "Nadia: ..."); empty when nothing was said yet. */
  preview: string;
  time: string | null;
  timeTitle: string | null;
  unread: number;
};

/** One row of the list. `label` is the conversation's name (`dmLabel`); `unread` is the live count when the store has one; `nameOf` names an author by actor id in a group. */
export function dmListRow(dm: DirectMessageSummary, opts: { label: string; selfPersonId: string; selfActor: string | null; unread?: number | undefined; nameOf: (actorId: string) => string | null; now?: Date }): DmListRow {
  const others = dm.participants.filter((p) => p.personId !== opts.selfPersonId);
  const reminders = dm.channel.dmKey?.startsWith(REMINDERS_DM_KEY_PREFIX) ?? false;
  const kind: DmListRow['kind'] = reminders ? 'reminders' : others.length === 0 ? 'self' : others.length === 1 ? 'person' : 'group';
  const last = dm.lastMessage;
  let preview = '';
  if (last) {
    const text = last.preview.replace(/\s+/g, ' ').trim() || 'Sent an attachment';
    const mine = opts.selfActor !== null && last.authorId === opts.selfActor;
    const who = mine && kind !== 'self' ? 'You' : kind === 'group' ? opts.nameOf(last.authorId)?.split(' ')[0] ?? null : null;
    preview = who ? `${who}: ${text}` : text;
  }
  return {
    channelId: dm.channel.id,
    label: opts.label,
    peerId: kind === 'person' ? others[0]!.personId : null,
    kind,
    preview,
    time: last ? listTime(last.createdAt, opts.now) : null,
    timeTitle: last ? fullStamp(last.createdAt, opts.now) : null,
    unread: Math.max(0, opts.unread ?? dm.unreadCount),
  };
}

/**
 * The list after a message arrived, was edited or was deleted. A new top-level message becomes its conversation's last line and moves the conversation to the
 * top (the server's order: newest last message first); a thread reply is not a last line (the server takes top-level messages only). `refetch` says the last
 * line was deleted and the list must be asked again (the one before it is not known here). The same list comes back when nothing changed.
 */
export function withMessageChange(items: readonly DirectMessageSummary[], change: MessageChange): { items: readonly DirectMessageSummary[]; refetch: boolean } {
  const channelId = change.type === 'deleted' ? change.channelId : change.message.channelId;
  const at = items.findIndex((d) => d.channel.id === channelId);
  if (at < 0) return { items, refetch: false };
  const dm = items[at]!;
  if (change.type === 'deleted') return { items, refetch: change.threadRootId === null && dm.lastMessage?.id === change.messageId };
  const m = change.message;
  if (m.threadRootId !== null || m.deletedAt !== null) return { items, refetch: false };
  const line = { id: m.id, authorId: m.authorId, preview: (m.bodyPlain || m.body).slice(0, 140), createdAt: m.createdAt };
  if (change.type === 'edited') {
    if (dm.lastMessage?.id !== m.id || dm.lastMessage.preview === line.preview) return { items, refetch: false };
    const next = [...items];
    next[at] = { ...dm, lastMessage: { ...dm.lastMessage, preview: line.preview } };
    return { items: next, refetch: false };
  }
  const prev = dm.lastMessage;
  if (prev && (prev.id === m.id ? prev.preview === line.preview : prev.createdAt > m.createdAt)) return { items, refetch: false };
  const updated = { ...dm, lastMessage: line };
  return { items: [updated, ...items.slice(0, at), ...items.slice(at + 1)], refetch: false };
}
