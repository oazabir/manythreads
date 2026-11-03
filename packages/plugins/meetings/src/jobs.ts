import type { PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import { MEETING_EMPTY_END_SECONDS, MEETING_PRESENCE_STALE_SECONDS } from '@manythreads/shared';
import { z } from 'zod';
import { AUTOEND_QUEUE, SWEEP_QUEUE, dropParticipants, endRoom } from './service.ts';

// Two jobs keep rooms honest. Both compare times in the database (`now()`), so one clock decides.
//  * meetings.autoend  runs two minutes after the last person left and ends the room if it is still empty (somebody coming back clears `empty_since`, so it does nothing).
//  * meetings.sweep    every minute: people silent for three minutes are counted as gone (a closed laptop, a lost connection), people who can no longer read the
//                      channel are dropped, and any room empty for two minutes is ended (the safety net for a lost autoend job).

const AutoEndPayload = z.object({ meetingId: z.uuid(), workspaceId: z.uuid() });

async function endIfStillEmpty(ctx: PluginContext, tx: PluginTx, meetingId: string, log: PluginLogger): Promise<boolean> {
  const due = await tx.query(
    "SELECT 1 FROM app.meetings WHERE id = $1::uuid AND state = 'live' AND empty_since IS NOT NULL AND empty_since <= now() - make_interval(secs => $2::int)",
    [meetingId, MEETING_EMPTY_END_SECONDS],
  );
  if (due.rows.length === 0) return false;
  return endRoom(ctx, tx, meetingId, 'empty', log);
}

/** The people of live rooms who can no longer read the room's channel (removed, or the team seat gone), dropped as `kicked`. Scoped to one workspace. */
export async function dropWithoutAccess(ctx: PluginContext, tx: PluginTx, log: PluginLogger): Promise<number> {
  const rooms = await tx.query<{ id: string; channel_id: string }>(
    `SELECT DISTINCT m.id, m.channel_id FROM app.meetings m
       JOIN app.meeting_participants p ON p.meeting_id = m.id AND p.left_at IS NULL
      WHERE m.state = 'live' AND m.channel_id IS NOT NULL`,
  );
  let dropped = 0;
  for (const room of rooms.rows) {
    dropped += await dropParticipants(
      ctx,
      tx,
      {
        where: 'p.meeting_id = $1::uuid AND NOT (p.person_id = ANY (ARRAY(SELECT person_id FROM app.channel_audience($2::uuid))))',
        params: [room.id, room.channel_id],
      },
      'kicked',
      log,
    );
  }
  return dropped;
}

export function registerMeetingJobs(ctx: PluginContext): void {
  ctx.jobs.register(
    AUTOEND_QUEUE,
    async (payload, tx, job) => {
      const p = AutoEndPayload.parse(payload);
      if (await endIfStillEmpty(ctx, tx, p.meetingId, job.log)) job.log.info('meetings: a voice room ended after two empty minutes');
    },
    { maxAttempts: 3 },
  );

  ctx.jobs.register(
    SWEEP_QUEUE,
    async (_payload, _unused, job) => {
      // Detached: the steps below are short transactions one after the other (the per-workspace step must not overlap the first, which could hold the same rows).
      const first = await job.transaction(async (tx) => {
        const stale = await dropParticipants(
          ctx,
          tx,
          {
            where: `coalesce((SELECT max(r.seen_at) FROM app.meeting_presence r WHERE r.meeting_id = p.meeting_id AND r.actor_id = p.actor_id), p.joined_at) < now() - make_interval(secs => $1::int)`,
            params: [MEETING_PRESENCE_STALE_SECONDS],
          },
          'dropped',
          job.log,
        );
        const empty = await tx.query<{ id: string }>(
          "SELECT id FROM app.meetings WHERE state = 'live' AND empty_since IS NOT NULL AND empty_since <= now() - make_interval(secs => $1::int)",
          [MEETING_EMPTY_END_SECONDS],
        );
        let ended = 0;
        for (const r of empty.rows) if (await endRoom(ctx, tx, r.id, 'empty', job.log)) ended += 1;
        const workspaces = await tx.query<{ workspace_id: string }>("SELECT DISTINCT workspace_id FROM app.meetings WHERE state = 'live'");
        return { stale, ended, workspaces: workspaces.rows.map((w) => w.workspace_id) };
      });
      // People who lost access: app.channel_audience needs the workspace in the transaction, so one short transaction per workspace with a live room.
      let kicked = 0;
      for (const workspaceId of first.workspaces) {
        kicked += await ctx.db.system((tx) => dropWithoutAccess(ctx, tx, job.log), { workspaceId });
      }
      if (first.stale + first.ended + kicked > 0) job.log.info(`meetings: ${first.stale} silent person(s) dropped, ${kicked} without access dropped, ${first.ended} empty room(s) ended`);
    },
    { cron: '* * * * *', maxAttempts: 1, detached: true },
  );
}
