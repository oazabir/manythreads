import type { ChannelMessage } from '@manythreads/shared';
import { dayKey, dayLabel, estimateMessageHeight } from './format';
import { firstUnreadIndex, type PendingSend } from './timeline';

/** What the message list draws, top to bottom: day dividers, one unread divider, messages, then messages still being sent. */
export type ListItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: 'unread' }
  | { kind: 'message'; key: string; message: ChannelMessage }
  | { kind: 'pending'; key: string; pending: PendingSend };

export const UNREAD_KEY = 'unread';
export const messageKey = (id: string): string => `m:${id}`;

export function buildListItems(
  messages: readonly ChannelMessage[],
  pending: readonly PendingSend[],
  opts: { lastReadId: string | null; selfActor: string | null; allLoaded: boolean; readKnown: boolean; now?: Date },
): ListItem[] {
  const out: ListItem[] = [];
  const unreadAt = opts.readKnown ? firstUnreadIndex(messages, opts.lastReadId, opts.selfActor, opts.allLoaded) : -1;
  let day = '';
  messages.forEach((m, i) => {
    const d = dayKey(m.createdAt);
    if (d !== day) {
      day = d;
      out.push({ kind: 'day', key: `d:${d}`, label: dayLabel(m.createdAt, opts.now) });
    }
    if (i === unreadAt) out.push({ kind: 'unread', key: UNREAD_KEY });
    out.push({ kind: 'message', key: messageKey(m.id), message: m });
  });
  for (const p of pending) out.push({ kind: 'pending', key: `p:${p.localId}`, pending: p });
  return out;
}

export function estimateItem(item: ListItem): number {
  switch (item.kind) {
    case 'day':
      return 36;
    case 'unread':
      return 30;
    case 'message':
      return estimateMessageHeight(item.message);
    case 'pending':
      return estimateMessageHeight({ body: item.pending.body, reactions: [], replyCount: 0, attachments: item.pending.attachments }) + 18;
  }
}
