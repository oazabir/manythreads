import type { PluginContext, PluginEvent } from '@manythreads/sdk';
import { MeetingsNotesWrittenEvent } from '@manythreads/shared';
import { announce } from './announce.ts';
import { quietPeople } from './hold.ts';
import { normalizePrefs } from './prefs.ts';

// Action items from a meeting (PLAN P15-12, decision C9). When the Scribe has written a finished voice room's notes, `meetings.notes.written` names the people the action items
// were given to (`actionOwnerIds`, actor ids of team members: ids only, never text). Each of them gets one notification of the kind `meeting_actions`: "2 action items from
// <title>", from the Scribe, and opening it goes to the meeting page (the row's reference is the meeting, not a message).
//
// It is something the person was asked to do, so, like a reminder, the channel's level, a muted channel and the per-kind switch do not silence it; the person must still be
// able to read the room's channel (the inbox policy hides the row from anyone who cannot), and Do not disturb holds it until it ends. One row per person and meeting: the
// event delivered twice writes nothing the second time.

const PREVIEW_MAX = 140;

/** "1 action item from Sprint review" / "2 action items from Sprint review", cut to the preview length at the title (never in the count). */
export function actionItemsPreview(count: number, title: string): string {
  const head = `${count} ${count === 1 ? 'action item' : 'action items'} from `;
  const name = title.replace(/\s+/g, ' ').trim() || 'a meeting';
  const chars = [...name];
  const room = Math.max(1, PREVIEW_MAX - head.length);
  return `${head}${chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : name}`;
}

export function registerMeetingActions(ctx: PluginContext): void {
  ctx.events.subscribe('meetings.notes.written', async (raw: PluginEvent, tx) => {
    const event = MeetingsNotesWrittenEvent.parse(raw);
    if (event.actionOwnerIds.length === 0 || event.channelId === null) return;

    const meeting = (
      await tx.query<{ title: string; thread_root_id: string | null; items: unknown }>(
        'SELECT m.title, m.thread_root_id, n.items FROM app.meetings m JOIN app.meeting_notes n ON n.meeting_id = m.id WHERE m.id = $1::uuid',
        [event.meetingId],
      )
    ).rows[0];
    if (!meeting) return;

    // How many action items each owner has, from the items the platform checked and stored (never from the event).
    const counts = new Map<string, number>();
    for (const item of Array.isArray(meeting.items) ? (meeting.items as { kind?: unknown; ownerId?: unknown }[]) : []) {
      if (item.kind === 'action' && typeof item.ownerId === 'string') counts.set(item.ownerId, (counts.get(item.ownerId) ?? 0) + 1);
    }

    const owners = (
      await tx.query<{ actor_id: string; person_id: string }>(
        `SELECT a.id AS actor_id, a.ref_id AS person_id FROM app.actors a
          WHERE a.id = ANY ($1::uuid[]) AND a.kind = 'person' AND a.workspace_id = $2::uuid
            AND a.ref_id IN (SELECT person_id FROM app.channel_audience($3::uuid))`,
        [[...new Set(event.actionOwnerIds)], event.workspaceId, event.channelId],
      )
    ).rows;
    if (owners.length === 0) return;

    const sender = (await tx.query<{ name: string }>(`SELECT b.name FROM app.actors a JOIN app.bots b ON b.id = a.ref_id WHERE a.id = $1::uuid AND a.kind = 'bot'`, [event.writtenBy])).rows[0];
    const quiet = await quietPeople(tx, owners.map((o) => o.person_id), ctx.runtime.now());

    const written: { id: string; person_id: string; held_at: Date | null }[] = [];
    for (const owner of owners) {
      const count = counts.get(owner.actor_id) ?? 1;
      const row = await tx.query<{ id: string; person_id: string; held_at: Date | null }>(
        `INSERT INTO app.notifications AS n (workspace_id, person_id, kind, ref_type, ref_id, channel_id, thread_root_id, actor_id, actor_name, preview, held_at)
         VALUES ($1::uuid, $2::uuid, 'meeting_actions', 'meeting', $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, CASE WHEN $9::boolean THEN now() END)
         ON CONFLICT (person_id, ref_type, ref_id) DO NOTHING
         RETURNING n.id, n.person_id, n.held_at`,
        [event.workspaceId, owner.person_id, event.meetingId, event.channelId, meeting.thread_root_id, event.writtenBy, (sender?.name ?? 'Scribe').slice(0, 200), actionItemsPreview(count, meeting.title), quiet.has(owner.person_id)],
      );
      if (row.rows[0]) written.push(row.rows[0]);
    }
    if (written.length === 0) return;

    const prefs = await tx.query<{ person_id: string; prefs: unknown }>('SELECT person_id, prefs FROM app.notification_prefs WHERE person_id = ANY ($1::uuid[])', [written.map((w) => w.person_id)]);
    const prefsOf = new Map(prefs.rows.map((r) => [r.person_id, normalizePrefs(r.prefs)]));
    await announce(ctx, tx, event.workspaceId, written.filter((r) => r.held_at === null), prefsOf);
  });
}
