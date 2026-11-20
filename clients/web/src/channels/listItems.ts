import type { ChannelMessage } from '@manythreads/shared';
import { dayKey, dayLabel, estimateMessageHeight } from './format';
import { continuesRun, pendingContinues } from './runs';
import { linksOf, type LinksAbove } from '../linkpreview/dedupe';
import { firstUnreadIndex, type PendingSend } from './timeline';

/** What the message list draws, top to bottom: day dividers, one unread divider, messages, then messages still being sent. */
export type ListItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: 'unread' }
  | {
      kind: 'message';
      key: string;
      message: ChannelMessage;
      /** Continues the run of the message above: no avatar, no name (P21-01). */
      continued: boolean;
      /** The links the earlier messages of the same run carry, which get no second card here (P34-04); never across a page of older messages. */
      linksAbove?: LinksAbove;
    }
  | { kind: 'pending'; key: string; pending: PendingSend; /** Continues the run of the row above (P32-11). */ continued: boolean };

export const UNREAD_KEY = 'unread';
export const messageKey = (id: string): string => `m:${id}`;

/** Whether the message is in the list and can show what hangs under it (a card): a message that was deleted is drawn as "deleted" and shows nothing. */
export const messageShown = (items: readonly ListItem[], id: string): boolean => items.some((i) => i.kind === 'message' && i.key === messageKey(id) && i.message.deletedAt === null);

export function buildListItems(
  messages: readonly ChannelMessage[],
  pending: readonly PendingSend[],
  opts: { lastReadId: string | null; selfActor: string | null; allLoaded: boolean; readKnown: boolean; now?: Date; pageStarts?: readonly string[] },
): ListItem[] {
  const out: ListItem[] = [];
  const unreadAt = opts.readKnown ? firstUnreadIndex(messages, opts.lastReadId, opts.selfActor, opts.allLoaded) : -1;
  let day = '';
  const pageStarts = new Set(opts.pageStarts ?? []);
  let runLinks = new Set<string>();
  messages.forEach((m, i) => {
    const d = dayKey(m.createdAt);
    // a day divider or the unread divider breaks a run
    let broken = false;
    if (d !== day) {
      day = d;
      broken = true;
      out.push({ kind: 'day', key: `d:${d}`, label: dayLabel(m.createdAt, opts.now) });
    }
    if (i === unreadAt) {
      broken = true;
      out.push({ kind: 'unread', key: UNREAD_KEY });
    }
    const continued = !broken && continuesRun(messages[i - 1], m);
    // a link preview shows once per run of one author: a new run, or the first message of a page loaded later, starts afresh
    if (!continued || pageStarts.has(m.id)) runLinks = new Set();
    out.push({ kind: 'message', key: messageKey(m.id), message: m, continued, linksAbove: [...runLinks].join(' ') });
    for (const l of linksOf(m)) runLinks.add(l);
  });
  let above: ChannelMessage | PendingSend | undefined = messages.at(-1);
  for (const p of pending) {
    out.push({ kind: 'pending', key: `p:${p.localId}`, pending: p, continued: pendingContinues(above, opts.selfActor, p.createdAt) });
    above = p;
  }
  return out;
}

/** Message guesses by message object (a message is replaced, never edited in place), so a list rebuild does not split every body again. */
const guessed = new WeakMap<ChannelMessage, { plain: number; continued: number }>();
/** The header line a continued row does not have (22 px), and the space above a new group that a run row does not have either (P34-01). */
const CONTINUED_LESS = 30;

export function estimateItem(item: ListItem): number {
  switch (item.kind) {
    // a divider carries the next group's gap above it too (P34-01, measured: 44 and 38 px)
    case 'day':
      return 44;
    case 'unread':
      return 38;
    case 'message': {
      let h = guessed.get(item.message);
      if (h === undefined) {
        const plain = estimateMessageHeight(item.message);
        h = { plain, continued: plain - CONTINUED_LESS };
        guessed.set(item.message, h);
      }
      return item.continued ? h.continued : h.plain;
    }
    case 'pending':
      return estimateMessageHeight({ body: item.pending.body, reactions: [], replyCount: 0, attachments: item.pending.attachments }) + 18;
  }
}

/** The day pill that belongs at the top of the view when row `index` is first: the nearest day divider at or above it, or null. */
export function dayAt(items: readonly ListItem[], index: number): string | null {
  for (let i = Math.min(index, items.length - 1); i >= 0; i -= 1) {
    const it = items[i];
    if (it && it.kind === 'day') return it.label;
  }
  return null;
}
