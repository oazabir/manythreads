import type { PluginContext } from '@manythreads/sdk';
import { toPlainText } from '@manythreads/shared';
import { DELIVER_QUEUE, DeliverPayload } from './routes.ts';

// SPIKE (P5-01, docs/spikes/slack-compat.md): runs as SYSTEM (no RLS), scoped to payload.workspaceId. It re-checks
// everything the anonymous route could not: the channel exists, belongs to the bot's team and is not archived; the
// thread root (when given) is a live root message of the same channel; the bot actor row still exists for the team.
// A failure throws, so the job retries with backoff and then dead-letters — a bad payload never lands a message.
// The insert is idempotent on `meta.deliveryId`: a retry after a crash lands nothing twice.
//
// SPIKE-ONLY pattern, never a product shape: this handler writes `app.messages` directly instead of going through the
// channels plugin's route. That is acceptable here because the spike owns no product surface; P5-10 runtime work must
// reuse the channels behaviour (route shape or SDK service), not copy this insert.

interface ChannelRow {
  id: string;
  team_id: string;
  workspace_id: string;
  archived_at: Date | null;
  kind: string;
  private: boolean;
  [key: string]: unknown;
}

interface RootRow {
  id: string;
  channel_id: string;
  thread_root_id: string | null;
  deleted_at: Date | null;
  [key: string]: unknown;
}

export function registerDeliverJob(ctx: PluginContext): void {
  ctx.jobs.register(
    DELIVER_QUEUE,
    async (payload, tx) => {
      const input = DeliverPayload.parse(payload);

      const already = await tx.query<{ id: string }>('SELECT id FROM app.messages WHERE channel_id = $1 AND meta->>\'deliveryId\' = $2', [
        input.channelId,
        input.deliveryId,
      ]);
      if (already.rows[0]) return;

      const channel = (
        await tx.query<ChannelRow>('SELECT id, team_id, workspace_id, archived_at, kind, private FROM app.channels WHERE id = $1', [input.channelId])
      ).rows[0];
      if (!channel) throw new Error('slack-compat: no such channel');
      if (channel.team_id !== input.teamId || channel.workspace_id !== input.workspaceId) {
        throw new Error('slack-compat: the channel is not the bot\u2019s team\u2019s');
      }
      if (channel.archived_at) throw new Error('slack-compat: the channel is archived');
      // the spike has no membership check, so it posts only where every team member may already post: a public team channel
      if (channel.kind !== 'channel' || channel.private) throw new Error('slack-compat: the spike posts to public team channels only');

      const botTeam = (
        await tx.query<{ team_id: string }>(
          `SELECT b.team_id FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id
            WHERE a.id = $1 AND b.workspace_id = $2 AND b.status = 'active'`,
          [input.botActorId, input.workspaceId],
        )
      ).rows[0];
      if (!botTeam || botTeam.team_id !== input.teamId) throw new Error('slack-compat: the bot actor is gone or the bot is not active');

      if (input.threadRootId) {
        const root = (
          await tx.query<RootRow>('SELECT id, channel_id, thread_root_id, deleted_at FROM app.messages WHERE id = $1', [input.threadRootId])
        ).rows[0];
        if (!root || root.channel_id !== input.channelId) throw new Error('slack-compat: no such thread root in this channel');
        if (root.thread_root_id) throw new Error('slack-compat: reply to the first message of the thread, not to a reply');
        if (root.deleted_at) throw new Error('slack-compat: the thread root was deleted');
      }

      const inserted = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id, meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
          [
            input.workspaceId,
            input.channelId,
            input.botActorId,
            input.text,
            toPlainText(input.text),
            input.threadRootId,
            JSON.stringify({ via: 'slack-compat/spike', deliveryId: input.deliveryId }),
          ],
        )
      ).rows[0];
      if (!inserted) throw new Error('slack-compat: the insert answered no row');
      const messageId = inserted.id;

      await ctx.audit.emit(tx, {
        type: 'channel.message.posted',
        channelId: input.channelId,
        teamId: input.teamId,
        messageId,
        authorId: input.botActorId,
        threadRootId: input.threadRootId,
      });

      const audience = (
        await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1)', [input.channelId])
      ).rows.map((r) => r.person_id);
      await ctx.realtime.pushToPeople(tx, audience, 'message.posted', {
        channelId: input.channelId,
        messageId,
        threadRootId: input.threadRootId,
      });

      const recipients = input.threadRootId
        ? (await tx.query<{ person_id: string }>('SELECT person_id FROM app.thread_follower_ids($1)', [input.threadRootId])).rows.map(
            (r) => r.person_id,
          )
        : audience;
      await ctx.readState.onPosted(tx, {
        targetType: input.threadRootId ? 'thread' : 'channel',
        targetId: input.threadRootId ?? input.channelId,
        messageId,
        authorId: input.botActorId,
        recipientPersonIds: recipients,
      });
    },
    { maxAttempts: 5 },
  );
}
