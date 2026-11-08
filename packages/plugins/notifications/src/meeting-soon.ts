import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { MeetingsScheduledStartingSoonEvent } from '@manythreads/shared';
import { announce } from './announce.ts';
import { quietPeople } from './hold.ts';
import { normalizePrefs } from './prefs.ts';

// Work package C (P16-05, decision D7): "starts in 5 minutes". The meetings plugin's reminder job says `meetings.scheduled.starting_soon` once per plan, with the invited people's ids; this makes one
// notification of the kind `meeting_soon` per invited person who can still read the room's channel ("Design review starts in 5 minutes", from the organizer, opening `/join/<id>`; the row's
// reference is the plan, `ref_type = scheduled_meeting`). Like a reminder, no channel level silences it; Do not disturb holds it, and the browser push is sent like the other kinds
// (`push.ts` words the title and the link). One row per person and plan: the event delivered twice writes nothing the second time.
const PREVIEW_MAX = 140;

/** "Design review starts in 5 minutes", cut at the title to the preview length (never in the tail). */
export function meetingSoonPreview(title: string): string {
  const tail = ' starts in 5 minutes';
  const name = title.replace(/\s+/g, ' ').trim() || 'A meeting';
  const chars = [...name];
  const room = Math.max(1, PREVIEW_MAX - tail.length);
  return `${chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : name}${tail}`;
}

export function registerMeetingSoon(ctx: PluginContext): void {
  ctx.events.subscribe('meetings.scheduled.starting_soon', async (raw: PluginEvent, tx: PluginTx) => {
    const event = MeetingsScheduledStartingSoonEvent.parse(raw);
    if (event.attendeePersonIds.length === 0) return;

    // The words come from the plan row (the event carries ids only). A plan that was cancelled or whose room already opened in the meantime has nothing to announce.
    const plan = (
      await tx.query<{ title: string; organizer_id: string; organizer_name: string | null }>(
        `SELECT s.title, s.organizer_id,
                (SELECT p.display_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id WHERE a.id = s.organizer_id AND a.kind = 'person') AS organizer_name
           FROM app.scheduled_meetings s WHERE s.id = $1::uuid AND s.status = 'scheduled'`,
        [event.scheduledMeetingId],
      )
    ).rows[0];
    if (!plan) return;

    // Only people who can read the channel now: the inbox policy hides the row from anyone else, but we do not even write it.
    const people = (
      await tx.query<{ person_id: string }>(
        `SELECT DISTINCT a.person_id FROM unnest($1::uuid[]) AS a(person_id) WHERE a.person_id IN (SELECT person_id FROM app.channel_audience($2::uuid))`,
        [[...new Set(event.attendeePersonIds)], event.channelId],
      )
    ).rows.map((r) => r.person_id);
    if (people.length === 0) return;

    const quiet = await quietPeople(tx, people, ctx.runtime.now());
    const preview = meetingSoonPreview(plan.title);
    const written: { id: string; person_id: string; held_at: Date | null }[] = [];
    for (const personId of people) {
      const row = await tx.query<{ id: string; person_id: string; held_at: Date | null }>(
        `INSERT INTO app.notifications AS n (workspace_id, person_id, kind, ref_type, ref_id, channel_id, actor_id, actor_name, preview, held_at)
         VALUES ($1::uuid, $2::uuid, 'meeting_soon', 'scheduled_meeting', $3::uuid, $4::uuid, $5::uuid, $6, $7, CASE WHEN $8::boolean THEN now() END)
         ON CONFLICT (person_id, ref_type, ref_id) DO NOTHING
         RETURNING n.id, n.person_id, n.held_at`,
        [event.workspaceId, personId, event.scheduledMeetingId, event.channelId, plan.organizer_id, (plan.organizer_name ?? 'Organizer').slice(0, 200), preview, quiet.has(personId)],
      );
      if (row.rows[0]) written.push(row.rows[0]);
    }
    if (written.length === 0) return;

    const prefs = await tx.query<{ person_id: string; prefs: unknown }>('SELECT person_id, prefs FROM app.notification_prefs WHERE person_id = ANY ($1::uuid[])', [written.map((w) => w.person_id)]);
    const prefsOf = new Map(prefs.rows.map((r) => [r.person_id, normalizePrefs(r.prefs)]));
    await announce(ctx, tx, event.workspaceId, written.filter((r) => r.held_at === null), prefsOf);
  });
}
