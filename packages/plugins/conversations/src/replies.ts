import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type { ChannelMessagePostedEvent } from '@manythreads/shared';

// The answers of a conversation (PLAN P20-16). A bot's reply in a person's conversation thread is one variant of the turn it answers: the first
// answer is variant 1, and Regenerate (or an edited last message sent again) adds the next, so the earlier answers stay and the person can page
// between them. Runs in the outbox consumer's system transaction, idempotent (the reply's id is the key; a run counts once), and enqueues the
// title job the first time a conversation gets an answer.

export const TITLE_QUEUE = 'conversations.title';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ReplyRow {
  person_id: string;
  workspace_id: string;
  created_at: Date;
  run_id: string | null;
  [key: string]: unknown;
}

export async function recordReply(ctx: PluginContext, event: ChannelMessagePostedEvent, tx: PluginTx): Promise<void> {
  if (event.threadRootId === null) return;
  // a bot's own answer (not a failure notice) in a thread that is a conversation
  const reply = (
    await tx.query<ReplyRow>(
      `SELECT c.person_id, c.workspace_id, m.created_at, m.meta ->> 'runId' AS run_id
         FROM app.messages m
         JOIN app.conversations c ON c.thread_root_id = m.thread_root_id AND c.channel_id = m.channel_id
         JOIN app.actors a ON a.id = m.author_id AND a.kind = 'bot'
        WHERE m.id = $1 AND m.deleted_at IS NULL AND m.meta ? 'runId' AND NOT (m.meta ? 'runFailure')`,
      [event.messageId],
    )
  ).rows[0];
  if (!reply || reply.run_id === null || !UUID.test(reply.run_id)) return;
  // one answer per run: a run that posted twice (a tool's post, then the final text) is still one variant, the first
  const seen = await tx.query('SELECT 1 FROM app.conversation_variants WHERE run_id = $1::uuid LIMIT 1', [reply.run_id]);
  if (seen.rows.length > 0) return;
  const run = (
    await tx.query<{ turn_message_id: string | null; model_alias: string | null; stopped_by_asker: boolean }>(
      'SELECT turn_message_id, model_alias, stopped_by_asker FROM app.bot_runs WHERE id = $1::uuid',
      [reply.run_id],
    )
  ).rows[0];
  if (!run) return;
  // the person's message this answers: what the run recorded, else the last message of a person in the thread before the answer
  let turn = run.turn_message_id;
  if (turn === null) {
    turn =
      (
        await tx.query<{ id: string }>(
          `SELECT m.id FROM app.messages m JOIN app.actors a ON a.id = m.author_id AND a.kind = 'person'
            WHERE (m.id = $1::uuid OR m.thread_root_id = $1::uuid) AND m.deleted_at IS NULL AND m.created_at <= $2
            ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
          [event.threadRootId, reply.created_at],
        )
      ).rows[0]?.id ?? null;
  }
  if (turn === null) return;
  const before = (await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.conversation_variants WHERE thread_root_id = $1::uuid', [event.threadRootId])).rows[0];
  const written = await tx.query(
    `WITH demoted AS (UPDATE app.conversation_variants SET chosen = false WHERE turn_message_id = $2::uuid)
     INSERT INTO app.conversation_variants (reply_message_id, turn_message_id, thread_root_id, workspace_id, person_id, variant_no, chosen, model_alias, stopped, run_id)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
            coalesce((SELECT max(variant_no) FROM app.conversation_variants WHERE turn_message_id = $2::uuid), 0) + 1, true, $6, $7, $8::uuid
     ON CONFLICT (reply_message_id) DO NOTHING
     RETURNING 1`,
    [event.messageId, turn, event.threadRootId, reply.workspace_id, reply.person_id, run.model_alias, run.stopped_by_asker, reply.run_id],
  );
  if (written.rows.length === 0) return;
  if (Number(before?.n ?? '0') === 0) {
    // the first answer of the conversation: name it (the job leaves a title the person gave alone)
    await ctx.jobs.enqueue(tx, TITLE_QUEUE, { workspaceId: reply.workspace_id, threadRootId: event.threadRootId }, { dedupeKey: `conversations-title:${event.threadRootId}` });
  }
}
