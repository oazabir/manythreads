import type { PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import {
  MEETING_EMPTY_END_SECONDS,
  MeetingsMeetingEndedEvent,
  MeetingsParticipantJoinedEvent,
  MeetingsParticipantLeftEvent,
} from '@manythreads/shared';
import { announceRoom } from './live.ts';
import { bestEffort, currentMedia } from './media.ts';

// What happens to a room and its people, in one place: the routes, the jobs, the media server's notices and the membership events all end up here, so a person
// is marked as gone, the event is written and the empty-room clock is set the same way whoever caused it.

export const AUTOEND_QUEUE = 'meetings.autoend';
export const SWEEP_QUEUE = 'meetings.sweep';

type LeaveHow = MeetingsParticipantLeftEvent['how'];

interface GoneRow extends Record<string, unknown> {
  meeting_id: string;
  actor_id: string;
  workspace_id: string;
  team_id: string | null;
  channel_id: string | null;
}

/** Writes `meetings.participant.left` for people who just left. */
async function emitLeft(ctx: PluginContext, tx: PluginTx, rows: readonly GoneRow[], how: LeaveHow): Promise<void> {
  const at = ctx.runtime.now().toISOString();
  for (const r of rows) {
    await ctx.audit.emit(
      tx,
      MeetingsParticipantLeftEvent.parse({
        type: 'meetings.participant.left',
        schemaVersion: 1,
        workspaceId: r.workspace_id,
        teamId: r.team_id,
        channelId: r.channel_id,
        meetingId: r.meeting_id,
        actorId: r.actor_id,
        how,
        at,
      }),
    );
  }
}

/** Starts the two-minute clock of a room that has just become empty: a delayed job that does nothing if somebody came back (the clock is `empty_since`, kept by the database). */
export async function scheduleAutoEnd(ctx: PluginContext, tx: PluginTx, meetingId: string, workspaceId: string): Promise<void> {
  const empty = await tx.query<{ empty_since: Date | null }>("SELECT empty_since FROM app.meetings WHERE id = $1::uuid AND state = 'live'", [meetingId]);
  if (!empty.rows[0]?.empty_since) return;
  await ctx.jobs.enqueue(tx, AUTOEND_QUEUE, { meetingId, workspaceId }, { runAt: new Date(ctx.runtime.now().getTime() + MEETING_EMPTY_END_SECONDS * 1000) });
}

export interface DropFilter {
  /** SQL over `p` (meeting_participants) and `m` (meetings); parameters start at $1. */
  where: string;
  params: readonly unknown[];
}

/**
 * Marks the people matching `filter` (still in a live room) as having left, writes the events, clears their heartbeat, starts the empty-room clock where a room
 * emptied, and asks the media server to drop them (best effort: the database is the truth, and a dropped person cannot get a new token).
 * Returns how many people left.
 */
export async function dropParticipants(
  ctx: PluginContext,
  tx: PluginTx,
  filter: DropFilter,
  how: LeaveHow,
  log?: PluginLogger,
): Promise<number> {
  const res = await tx.query<GoneRow>(
    `UPDATE app.meeting_participants p SET left_at = now()
       FROM app.meetings m
      WHERE m.id = p.meeting_id AND m.state = 'live' AND p.left_at IS NULL AND (${filter.where})
      RETURNING p.meeting_id, p.actor_id, p.workspace_id, p.team_id, p.channel_id`,
    [...filter.params],
  );
  if (res.rows.length === 0) return 0;
  await tx.query('DELETE FROM app.meeting_presence r USING unnest($1::uuid[], $2::uuid[]) AS g(meeting_id, actor_id) WHERE r.meeting_id = g.meeting_id AND r.actor_id = g.actor_id', [
    res.rows.map((r) => r.meeting_id),
    res.rows.map((r) => r.actor_id),
  ]);
  await emitLeft(ctx, tx, res.rows, how);
  const media = currentMedia(ctx);
  if (media && media.status().configured) {
    for (const r of res.rows) await bestEffort(log, 'dropping a participant', () => media.kick(r.meeting_id, r.actor_id));
  }
  const rooms = new Map(res.rows.map((r) => [r.meeting_id, r]));
  for (const [meetingId, r] of rooms) {
    await scheduleAutoEnd(ctx, tx, meetingId, r.workspace_id);
    await announceRoom(ctx, tx, { id: meetingId, channel_id: r.channel_id, state: 'live' });
  }
  return res.rows.length;
}

/**
 * Closes a room: in the database through `app.meetings_end` (which checks the caller, or lets the system role through), then the events, then the media server
 * (best effort). Returns false when the room had already ended.
 */
export async function endRoom(
  ctx: PluginContext,
  tx: PluginTx,
  meetingId: string,
  reason: 'person' | 'empty',
  log?: PluginLogger,
): Promise<boolean> {
  const present = await tx.query<GoneRow>(
    'SELECT p.meeting_id, p.actor_id, p.workspace_id, p.team_id, p.channel_id FROM app.meeting_participants p WHERE p.meeting_id = $1::uuid AND p.left_at IS NULL',
    [meetingId],
  );
  const done = (await tx.query<{ ended: boolean }>('SELECT app.meetings_end($1::uuid, $2) AS ended', [meetingId, reason])).rows[0]?.ended === true;
  if (!done) return false;
  const m = (
    await tx.query<{ workspace_id: string; team_id: string | null; channel_id: string | null; started_at: Date; ended_at: Date; ended_by: string | null; people: number }>(
      `SELECT m.workspace_id, m.team_id, m.channel_id, m.started_at, m.ended_at, m.ended_by,
              (SELECT count(*)::int FROM app.meeting_participants p WHERE p.meeting_id = m.id) AS people
         FROM app.meetings m WHERE m.id = $1::uuid`,
      [meetingId],
    )
  ).rows[0];
  if (!m) return true;
  await emitLeft(ctx, tx, present.rows, 'ended');
  await ctx.audit.emit(
    tx,
    MeetingsMeetingEndedEvent.parse({
      type: 'meetings.meeting.ended',
      schemaVersion: 1,
      workspaceId: m.workspace_id,
      teamId: m.team_id,
      channelId: m.channel_id,
      meetingId,
      endedBy: m.ended_by,
      reason,
      durationSeconds: Math.max(0, Math.floor((m.ended_at.getTime() - m.started_at.getTime()) / 1000)),
      participantCount: m.people,
      at: m.ended_at.toISOString(),
    }),
  );
  await announceRoom(ctx, tx, { id: meetingId, channel_id: m.channel_id, state: 'ended' });
  const media = currentMedia(ctx);
  if (media && media.status().configured) await bestEffort(log, 'closing a room', () => media.closeRoom(meetingId));
  return true;
}

/** Writes `meetings.participant.joined`. */
export async function emitJoined(
  ctx: PluginContext,
  tx: PluginTx,
  m: { id: string; workspace_id: string; team_id: string | null; channel_id: string | null },
  actorId: string,
  rejoined: boolean,
): Promise<void> {
  await ctx.audit.emit(
    tx,
    MeetingsParticipantJoinedEvent.parse({
      type: 'meetings.participant.joined',
      schemaVersion: 1,
      workspaceId: m.workspace_id,
      teamId: m.team_id,
      channelId: m.channel_id,
      meetingId: m.id,
      actorId,
      rejoined,
      at: ctx.runtime.now().toISOString(),
    }),
  );
}
