import type { PluginTx } from '@manythreads/sdk';
import { z } from 'zod';
import { postChannelMessage, type Deps } from './service.ts';

// What a bot may do with channel messages (SPEC §7.1 lists `messages.*` among a bot's native capabilities; PLAN P5-10). A
// capability is how one plugin calls another's behaviour — plugins never import each other — so the reply a runtime posts
// into a thread arrives here and goes through `postChannelMessage`, the same function the post route calls. Nothing about
// the write changes because a bot made it: the author is the transaction's actor (the run's bot), the permission is
// `app.channel_can(channel, 'post')` (a bot is a member of its team, so its team's public channels — never a private channel or a
// DM; the one exception is the bot conversation channel its own live run answers in, channels migration 0006), and the message is a
// normal message: mention resolution, unread counters, live push, `channel.message.posted`.
//
// `messages.search` lives in the search plugin (it owns the index); this file is only the write side.

/** The tool's arguments, exactly as the MCP gateway's catalog describes them to a model. */
export const PostMessageInput = z.strictObject({
  channelId: z.uuid(),
  body: z.string().min(1).max(40_000),
  /** The thread to reply in: the root message id. Absent posts a new top-level message. */
  threadRootId: z.uuid().nullish(),
});
export type PostMessageInput = z.infer<typeof PostMessageInput>;

/** The answer: ids, never the message text back (the run already knows what it wrote). */
export interface PostMessageAnswer {
  ok: true;
  messageId: string;
  channelId: string;
  threadRootId: string | null;
}

export function registerMessageCapabilities(deps: Deps): void {
  const { ctx } = deps;
  ctx.capabilities.register('messages.post', async (input: Record<string, unknown>, tx: PluginTx): Promise<PostMessageAnswer> => {
    const parsed = PostMessageInput.parse(input);
    const posted = await postChannelMessage(deps, tx, {
      channelId: parsed.channelId,
      body: parsed.body,
      threadRootId: parsed.threadRootId ?? null,
    });
    return { ok: true, messageId: posted.id, channelId: posted.channelId, threadRootId: posted.threadRootId };
  });
}
