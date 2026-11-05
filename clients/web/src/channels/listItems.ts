import type { ChannelMessage } from '@manythreads/shared';
import { dayKey, dayLabel, estimateMessageHeight } from './format';
import { continuesRun } from './runs';
import { firstUnreadIndex, type PendingSend } from './timeline';

/** What the message list draws, top to bottom: day dividers, one unread divider, messages, then messages still being sent. */
export type ListItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: 'unread' }
  | { kind: 'message'; key: string; message: ChannelMessage; /** Continues the run of the message above: no avatar, no name (P21-01). */ continued: boolean }
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
    out.push({ kind: 'message', key: messageKey(m.id), message: m, continued: !broken && continuesRun(messages[i - 1], m) });
  });
  for (const p of pending) out.push({ kind: 'pending', key: `p:${p.localId}`, pending: p });
  return out;
}

/** Message guesses by message object (a message is replaced, never edited in place), so a list rebuild does not split every body again. */
const guessed = new WeakMap<ChannelMessage, { plain: number; continued: number }>();
/** The header line a continued row does not have. */
const CONTINUED_LESS = 22;

export function estimateItem(item: ListItem): number {
  switch (item.kind) {
    case 'day':
      return 36;
    case 'unread':
      return 30;
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
