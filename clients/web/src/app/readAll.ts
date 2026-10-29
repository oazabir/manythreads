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
  await channelStore.markRead(type, id, upTo);
}

const AT_ONCE = 4;
const INBOX_PAGES = 3;

/** Runs the jobs a few at a time, so a long list is not one burst of requests. */
async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += AT_ONCE) {
    await Promise.all(items.slice(i, i + AT_ONCE).map((x) => work(x).catch(() => undefined)));
  }
}

/** Reads every channel, conversation and thread that has unread messages; resolves to how many it marked. */
export async function markEverythingRead(slug: string): Promise<number> {
  const summary = await fetchUnreadSummary();
  let marked = 0;
  await inBatches(summary.channels, async (c) => {
    await markConversationRead(c.channelId);
    marked++;
  });
  for (let page = 0, cursor: string | undefined; page < INBOX_PAGES; page++) {
    const res = await fetchThreadInbox(slug, 'unread', cursor).catch(() => null);
    if (!res) break;
    await inBatches(res.items, async (t) => {
      await markConversationRead(t.channel.id, t.rootMessageId);
      marked++;
    });
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  await channelStore.refreshSummary();
  return marked;
}
