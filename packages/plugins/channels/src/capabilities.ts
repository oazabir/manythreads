import type { MessagePostInput as ProviderPostInput, MessagePosted, MessageProvider, PluginTx } from '@manythreads/sdk';
import { AnswerPayload } from '@manythreads/shared';
import { z } from 'zod';
import { forbidden, invalid } from './http.ts';
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

/**
 * What the `messages` provider accepts as `meta` (PLAN P5-18): the platform's own bookkeeping, validated here so a plugin cannot store a
 * payload the clients would not read. `answer` is an `AnswerPayload` (the answer plugin stamps it), `runId` the bot run that wrote the message.
 */
const ProviderMeta = z.strictObject({ answer: AnswerPayload.optional(), runId: z.uuid().optional() });

/**
 * The `messages` provider: how a plugin posts a message with more than text. It is the same `postChannelMessage` the route and the capability
 * call, so a message made this way is indistinguishable from any other except for its `meta` — and it is not a capability, so no model can be
 * granted it and call it with a payload of its own (docs/plugins/answer.md).
 *
 * The provider does not take a caller's word for what the meta says. `meta.runId` is the transaction's own run (`app.run_id()`, set by the
 * kernel when the run's bot acts, never by SQL a plugin could write), and an `answer` is the answer of that run, by the bot that is posting it,
 * with the text that is the message: a plugin cannot post one run's Answer as another's, as another bot's, or with a text that differs from the
 * payload clients draw.
 */
export function registerMessageProvider(deps: Deps): void {
  const provider: MessageProvider = {
    id: 'channels',
    async post(tx: PluginTx, input: ProviderPostInput): Promise<MessagePosted> {
      const body = z.string().min(1).max(40_000).safeParse(input.body);
      if (!body.success) throw invalid('body: 1 to 40,000 characters');
      const meta = input.meta === undefined ? undefined : ProviderMeta.safeParse(input.meta);
      if (meta && !meta.success) throw invalid(`meta: ${meta.error.issues.map((i) => `${i.path.join('.') || '(meta)'}: ${i.message}`).join('; ')}`);
      if (meta?.success && (meta.data.runId !== undefined || meta.data.answer !== undefined)) {
        const here = (
          await tx.query<{ run_id: string | null; bot_id: string | null }>(
            `SELECT app.run_id()::text AS run_id,
                    (SELECT a.ref_id::text FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'bot') AS bot_id`,
          )
        ).rows[0];
        const run = here?.run_id ?? null;
        if (meta.data.runId !== undefined && (run === null || meta.data.runId !== run)) {
          throw forbidden('meta.runId is the run this transaction acts for, and no other');
        }
        const answer = meta.data.answer;
        if (answer !== undefined) {
          if (meta.data.runId === undefined) throw invalid('meta.runId: an answer names the run that wrote it');
          if (answer.answeredFor.runId !== run) throw forbidden('meta.answer.answeredFor.runId is the run this transaction acts for, and no other');
          if (here?.bot_id == null || answer.answeredFor.botId !== here.bot_id) throw forbidden('meta.answer.answeredFor.botId is the bot that posts the answer, and no other');
          if (answer.body !== body.data) throw invalid('meta.answer.body is the text of the message');
        }
      }
      const posted = await postChannelMessage(deps, tx, {
        channelId: input.channelId,
        body: body.data,
        threadRootId: input.threadRootId ?? null,
        ...(meta?.success ? { meta: meta.data as Record<string, unknown> } : {}),
      });
      return { id: posted.id, channelId: posted.channelId, threadRootId: posted.threadRootId, createdAt: posted.row.created_at.toISOString() };
    },
  };
  deps.ctx.providers.register('messages', provider);
}
