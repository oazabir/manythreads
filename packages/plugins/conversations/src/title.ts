import type { PluginContext, PluginTx, ProviderImpl } from '@manythreads/sdk';
import { CHAT_TITLE_MAX } from '@manythreads/shared';
import { z } from 'zod';
import { TITLE_QUEUE } from './replies.ts';

// The name of a conversation (PLAN P20-16): after the first answer, the cheap `fast` model reads the first message and the start of the answer and
// writes a short title. Done outside any transaction while the model works (`detached`): two short system transactions, one to read and one to
// write. When there is no model for the alias, the gateway refuses, or the answer is empty, the title stays empty and the lists show the first
// words of the person's message. A title the person typed (`title_source = 'manual'`) is never replaced.

const Payload = z.object({ workspaceId: z.uuid(), threadRootId: z.uuid() });

/** The model door of gateway-llm, as far as this job uses it. */
interface TitleDoor extends ProviderImpl {
  evalComplete(
    tx: PluginTx,
    request: { workspaceId: string; botId: string; teamId: string; runId: string; alias: string; system: string; user: string; maxTokens: number; timeoutMs?: number; purpose: 'title' },
  ): Promise<{ ok: true; text: string } | { ok: false; reason: string; detail: string }>;
}

const ALIAS = 'fast';
const SYSTEM =
  'You name chat conversations. Read the start of the conversation and answer with a title of at most six words, in the language of the conversation. ' +
  'Answer with the title only: no quotes, no full stop, no label.';

/** What the model wrote, as a title: one line, no quotes or closing full stop, within the longest title; null when nothing is left. */
export function cleanTitle(raw: string): string | null {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  const bare = line
    .replace(/^(title|name)\s*:\s*/i, '')
    .replace(/^["'`“‘«]+|["'`”’»]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim();
  if (bare === '') return null;
  return bare.length <= CHAT_TITLE_MAX ? bare : `${bare.slice(0, CHAT_TITLE_MAX - 1).trimEnd()}…`;
}

export function registerTitleJob(ctx: PluginContext): void {
  ctx.jobs.register(
    TITLE_QUEUE,
    async (raw, _tx, job) => {
      const payload = Payload.parse(raw);
      const seen = await job.transaction(async (tx) => {
        const row = (
          await tx.query<{ bot_id: string; team_id: string; first: string; answer: string | null }>(
            `SELECT c.bot_id, c.team_id, left(m.body_plain, 600) AS first,
                    (SELECT left(r.body_plain, 600) FROM app.conversation_variants v JOIN app.messages r ON r.id = v.reply_message_id
                      WHERE v.thread_root_id = c.thread_root_id ORDER BY v.created_at LIMIT 1) AS answer
               FROM app.conversations c JOIN app.messages m ON m.id = c.thread_root_id
              WHERE c.thread_root_id = $1::uuid AND c.title_source IS NULL AND c.deleted_at IS NULL`,
            [payload.threadRootId],
          )
        ).rows[0];
        return row ?? null;
      });
      if (!seen) return;
      const llm = ctx.providers.get<TitleDoor>('llm');
      if (!llm) return;
      const user = `Person: ${seen.first}${seen.answer ? `\n\nBot: ${seen.answer}` : ''}`;
      const answer = await job.transaction((tx) =>
        llm.evalComplete(tx, {
          workspaceId: payload.workspaceId,
          botId: seen.bot_id,
          teamId: seen.team_id,
          runId: payload.threadRootId,
          alias: ALIAS,
          system: SYSTEM,
          user,
          maxTokens: 24,
          timeoutMs: 20_000,
          purpose: 'title',
        }),
      );
      if (!answer.ok) {
        job.log.info(`conversations: no title for ${payload.threadRootId}: ${answer.reason}`);
        return;
      }
      const title = cleanTitle(answer.text);
      if (title === null) return;
      await job.transaction(async (tx) => {
        const set = await tx.query<{ person_id: string; bot_id: string; channel_id: string }>(
          `UPDATE app.conversations SET title = $2, title_source = 'auto'
            WHERE thread_root_id = $1::uuid AND title_source IS NULL AND deleted_at IS NULL RETURNING person_id, bot_id, channel_id`,
          [payload.threadRootId, title],
        );
        const c = set.rows[0];
        if (!c) return;
        await ctx.audit.emit(tx, {
          type: 'conversations.conversation.renamed',
          botId: c.bot_id,
          personId: c.person_id,
          channelId: c.channel_id,
          threadRootId: payload.threadRootId,
          source: 'auto',
        });
      });
    },
    { detached: true, concurrency: 2, maxAttempts: 3 },
  );
}
