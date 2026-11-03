import type { PluginContext, PluginEvent } from '@manythreads/sdk';
import { ChannelMemberRemovedEvent, TeamMemberRemovedEvent } from '@manythreads/shared';
import { dropParticipants } from './service.ts';

// Losing the right to read a channel (taken out of it, or off its team) takes a person out of its voice room within seconds: the database marks them as gone, the
// media server is asked to drop them, and they get no new token (the room is no longer readable to them). A person who can still read the channel, for example one
// who left a public channel, stays. The one-minute sweep (jobs.ts) is the net for a missed notice.

export function registerMeetingConsumers(ctx: PluginContext): void {
  ctx.events.subscribe('channel.member.removed', async (raw: PluginEvent, tx) => {
    const event = ChannelMemberRemovedEvent.parse(raw);
    const audience = await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [event.channelId]);
    if (audience.rows.some((r) => r.person_id === event.personId)) return;
    await dropParticipants(ctx, tx, { where: 'p.person_id = $1::uuid AND m.channel_id = $2::uuid', params: [event.personId, event.channelId] }, 'kicked');
  });

  ctx.events.subscribe('team.member.removed', async (raw: PluginEvent, tx) => {
    const event = TeamMemberRemovedEvent.parse(raw);
    const rooms = await tx.query<{ id: string; channel_id: string | null }>(
      `SELECT m.id, m.channel_id FROM app.meetings m JOIN app.meeting_participants p ON p.meeting_id = m.id
        WHERE m.state = 'live' AND m.team_id = $1::uuid AND p.person_id = $2::uuid AND p.left_at IS NULL`,
      [event.teamId, event.personId],
    );
    for (const room of rooms.rows) {
      if (room.channel_id) {
        const audience = await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [room.channel_id]);
        if (audience.rows.some((r) => r.person_id === event.personId)) continue;
      }
      await dropParticipants(ctx, tx, { where: 'p.person_id = $1::uuid AND m.id = $2::uuid', params: [event.personId, room.id] }, 'kicked');
    }
  });
}
