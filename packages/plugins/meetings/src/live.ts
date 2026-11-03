import type { MessageProvider, PluginContext, PluginTx } from '@manythreads/sdk';
import { MEETING_CHANGED_PUSH, MEETING_RING_SECONDS, MEETING_RINGING_PUSH, MeetingChangedPush, MeetingRingingPush } from '@manythreads/shared';
import { z } from 'zod';

// What the people with the page open are told as rooms change (PLAN P15-04): one small push to everyone who can read the room's channel ("something changed in this
// room, ask again": ids only, so no push ever carries a title or a name), and for a call in a direct message a ring to the other people of that conversation.
// A push is delivered when the transaction commits; a rolled-back change is never announced. The page also asks again every half minute, so a lost push heals.

export const RINGEND_QUEUE = 'meetings.ringend';
export const MISSED_CALL_TEXT = 'Missed call';

interface RoomFacts {
  id: string;
  channel_id: string | null;
  state: 'live' | 'ended';
}

/** The people who can read the room's channel (a direct message: its people). Empty for a room with no channel. */
async function audience(tx: PluginTx, channelId: string | null): Promise<string[]> {
  if (!channelId) return [];
  const res = await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [channelId]);
  return res.rows.map((r) => r.person_id);
}

/** Tells everyone who can read the room's channel that the room changed. */
export async function announceRoom(ctx: PluginContext, tx: PluginTx, room: RoomFacts): Promise<void> {
  const people = await audience(tx, room.channel_id);
  if (people.length === 0) return;
  await ctx.realtime.pushToPeople(tx, people, MEETING_CHANGED_PUSH, MeetingChangedPush.parse({ meetingId: room.id, channelId: room.channel_id, state: room.state }));
}

/** True when the channel is a direct message (or a conversation of people only), the one place a call rings. */
async function isDirectMessage(tx: PluginTx, channelId: string): Promise<boolean> {
  const res = await tx.query<{ kind: string }>('SELECT kind FROM app.channels WHERE id = $1::uuid', [channelId]);
  return res.rows[0]?.kind === 'dm';
}

/** A new call in a direct message: the other people ring for thirty seconds, and a job writes "Missed call" if nobody picked up. */
export async function ringDirectMessage(
  ctx: PluginContext,
  tx: PluginTx,
  room: { id: string; channel_id: string | null; workspace_id: string },
  caller: { actorId: string; personId: string },
): Promise<boolean> {
  if (!room.channel_id || !(await isDirectMessage(tx, room.channel_id))) return false;
  const others = (await audience(tx, room.channel_id)).filter((p) => p !== caller.personId);
  if (others.length === 0) return false;
  const name = (await tx.query<{ display_name: string }>('SELECT display_name FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid', [room.id, caller.actorId])).rows[0]?.display_name ?? 'Someone';
  await ctx.realtime.pushToPeople(
    tx,
    others,
    MEETING_RINGING_PUSH,
    MeetingRingingPush.parse({ meetingId: room.id, channelId: room.channel_id, callerActorId: caller.actorId, callerName: name, ringSeconds: MEETING_RING_SECONDS }),
  );
  await ctx.jobs.enqueue(
    tx,
    RINGEND_QUEUE,
    { meetingId: room.id, workspaceId: room.workspace_id, callerActorId: caller.actorId },
    { runAt: new Date(ctx.runtime.now().getTime() + MEETING_RING_SECONDS * 1000), dedupeKey: `ringend:${room.id}` },
  );
  return true;
}

const RingEndPayload = z.object({ meetingId: z.uuid(), workspaceId: z.uuid(), callerActorId: z.uuid() });

/**
 * Thirty seconds after a direct-message call began: if nobody but the caller ever came into the room, the call was missed. "Missed call" is written in the call's
 * thread as the caller (the thread is the call's home in the conversation), once.
 */
export function registerRingEndJob(ctx: PluginContext): void {
  ctx.jobs.register(
    RINGEND_QUEUE,
    async (payload, _tx, job) => {
      const p = RingEndPayload.parse(payload);
      const messages = ctx.providers.get<MessageProvider>('messages');
      if (!messages) return;
      const wrote = await ctx.db.as({ actorId: p.callerActorId, kind: 'person', workspaceId: p.workspaceId, personId: null, sessionId: null }, async (tx) => {
        const room = (await tx.query<{ channel_id: string | null; thread_root_id: string | null }>('SELECT channel_id, thread_root_id FROM app.meetings WHERE id = $1::uuid', [p.meetingId])).rows[0];
        if (!room?.channel_id) return false;
        const answered = await tx.query('SELECT 1 FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id <> $2::uuid LIMIT 1', [p.meetingId, p.callerActorId]);
        if (answered.rows.length > 0) return false;
        await messages.post(tx, { channelId: room.channel_id, body: MISSED_CALL_TEXT, threadRootId: room.thread_root_id, skipRefs: true });
        return true;
      });
      if (wrote) job.log.info('meetings: a direct-message call went unanswered');
    },
    { maxAttempts: 3 },
  );
}
