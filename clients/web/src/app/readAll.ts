import { fetchMessages, fetchThreadInbox, fetchUnreadSummary } from '../api/endpoints';
import { channelKey, channelStore, threadKey } from '../channels/store';

/*
 * The keyboard's two ways to say "I have seen this": Esc reads the conversation that is open, Shift+Esc reads everything with unread
 * messages. A read position is a message id, so each target needs its newest message: the timeline already holds it when the conversation was
 * opened in this tab, otherwise one request asks the server for it.
 */

/** The newest message of a channel (or of one thread in it), or null when it has none. */
export async function newestMessageId(channelId: string, rootId: string | null): Promise<string | null> {
  const held = channelStore.get(rootId ? threadKey(rootId) : channelKey(channelId)).items.at(-1)?.id;
  if (held) return held;
  const page = await fetchMessages(channelId, { limit: 1, ...(rootId ? { threadRootId: rootId } : {}) });
  return page.items[0]?.id ?? null;
}

/** Marks one channel (or one thread) read up to its newest message, even when it was marked unread on purpose a moment ago. */
export async function markConversationRead(channelId: string, rootId: string | null = null): Promise<void> {
  const upTo = await newestMessageId(channelId, rootId);
  if (!upTo) return;
  const type = rootId ? 'thread' : 'channel';
  const id = rootId ?? channelId;
  channelStore.releaseUnreadHold(type, id);
  if (!(await channelStore.markRead(type, id, upTo))) throw new Error('The read position was not saved.');
}

const AT_ONCE = 4;
/** How many pages of unread threads one Shift+Esc goes through; what is left is reported (`more`), never claimed done. */
export const INBOX_PAGES = 20;

/** Runs the jobs a few at a time, so a long list is not one burst of requests; resolves to how many failed. */
async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<number> {
  let failed = 0;
  for (let i = 0; i < items.length; i += AT_ONCE) {
    await Promise.all(items.slice(i, i + AT_ONCE).map((x) => work(x).catch(() => void (failed += 1))));
  }
  return failed;
}

export interface ReadAllResult {
  marked: number;
  /** Conversations whose read position the server did not take. */
  failed: number;
  /** Unread threads were left after the last page read (or a page could not be read). */
  more: boolean;
}

/** Reads every channel, conversation and thread that has unread messages; says how many it marked, how many failed and whether some were left (issue #28). */
export async function markEverythingRead(slug: string): Promise<ReadAllResult> {
  const summary = await fetchUnreadSummary();
  let marked = 0;
  let failed = await inBatches(summary.channels, async (c) => {
    await markConversationRead(c.channelId);
    marked++;
  });
  let more = false;
  for (let page = 0, cursor: string | undefined; ; page++) {
    if (page >= INBOX_PAGES) {
      more = true;
      break;
    }
    const res = await fetchThreadInbox(slug, 'unread', cursor).catch(() => null);
    if (!res) {
      more = true;
      break;
    }
    failed += await inBatches(res.items, async (t) => {
      await markConversationRead(t.channel.id, t.rootMessageId);
      marked++;
    });
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  await channelStore.refreshSummary();
  return { marked, failed, more };
}

/** What Shift+Esc says when it is done. */
export function readAllWords(r: ReadAllResult): string {
  if (r.failed > 0) return `Marked ${r.marked} as read; ${r.failed} could not be marked. Try again.`;
  if (r.more) return `Marked ${r.marked} as read. More unread threads are left: press Shift+Esc again.`;
  return r.marked === 0 ? 'Nothing was unread.' : 'Everything marked as read.';
}

/**
 * The first message of a channel the reader has not read yet (the one "Mark unread from here" would need to put the read position back), or null
 * when nothing is unread or the timeline is not held. Taken before a conversation is marked read, so the notice can offer Undo.
 */
export function firstUnreadMessageId(channelId: string): string | null {
  if ((channelStore.snapshot().unread[channelId] ?? 0) <= 0) return null;
  const last = channelStore.readState(`channel:${channelId}`)?.lastReadId ?? null;
  const first = channelStore.get(channelKey(channelId)).items.find((m) => m.deletedAt === null && (last === null || m.id > last));
  return first?.id ?? null;
}

/** Puts a channel's read position back to just before `messageId` (Undo on "marked as read"). */
export async function undoMarkRead(channelId: string, messageId: string): Promise<void> {
  await channelStore.markUnread(channelId, messageId, null);
}
