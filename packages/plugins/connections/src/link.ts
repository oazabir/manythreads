import type { PluginTx } from '@manythreads/sdk';
import { z } from 'zod';

// The link from a mail to the bot's post about it (PLAN P8-30). When the run an `inbox` claim opened posts its first message, the connections plugin sees the post
// (`channel.message.posted`) and records, on the claim, which run it was and which thread the post opened (`run_id`, `root_message_id`). That record is what `email.send` later
// uses to find the mail a conversation came from (email/tools.ts): the thread a person or another bot answers in is the post's thread.
//
// How the post is tied to the claim, using only rows the platform wrote:
//   post          `messages.meta.runId` is stamped by the platform alone from the transaction's own run (no argument can set it);
//   run           `bot_runs`: the run of THIS bot, started by an `inbox` trigger, answering in the post's own channel;
//   its job       `bot_runs.job_id`, and the job's payload carries `inbox.claimId` (the runtime put it there from the event), which is the claim.
// The first post wins: a claim already linked is left alone, so a bot that posts twice in one run does not move the link.
// Only a TOP-LEVEL post can be the link (it is its own thread root). A reply into a thread that already exists is never linked, however the bot got there (an explicit
// `threadRootId` is an argument the model controls): otherwise a bot steered by a mail could bind the claim to someone else's thread, and the people answering in that thread
// would then be answering the mail. Such a post is left alone and the claim waits for the run's next top-level post.

const RunId = z.uuid();

/** Links the post `messageId` to the claim of the inbox run that wrote it, if it is one. Returns whether a claim was linked. `tx` is a system transaction. */
export async function linkPost(tx: PluginTx, messageId: string): Promise<boolean> {
  const message = (
    await tx.query<{ channel_id: string; root: string; run_id: unknown }>(
      `SELECT m.channel_id, m.id AS root, m.meta -> 'runId' AS run_id
         FROM app.messages m WHERE m.id = $1::uuid AND m.thread_root_id IS NULL AND m.deleted_at IS NULL AND NOT (m.meta ? 'runFailure')`,
      [messageId],
    )
  ).rows[0];
  const runId = RunId.safeParse(message?.run_id);
  if (!message || !runId.success) return false;
  const linked = await tx.query(
    `UPDATE app.connection_mail_claims c
        SET run_id = r.id, root_message_id = $3::uuid, linked_at = now()
       FROM app.bot_runs r
       JOIN app.jobs j ON j.id = r.job_id
      WHERE r.id = $1::uuid AND r.trigger_type = 'inbox' AND r.channel_id = $2::uuid
        AND c.id::text = j.payload #>> '{inbox,claimId}'
        AND c.bot_id = r.bot_id AND c.workspace_id = r.workspace_id AND c.run_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM app.connection_mail_claims o WHERE o.root_message_id = $3::uuid)
    RETURNING c.id`,
    [runId.data, message.channel_id, message.root],
  );
  return linked.rows.length > 0;
}
