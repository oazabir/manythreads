import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { MeetingsInviteSentEvent, NotificationLevel, effectiveLevel, levelAllows } from '@manythreads/shared';
import { announce } from './announce.ts';
import { quietPeople } from './hold.ts';
import { workspaceDefaultLevel } from './levels.ts';
import { normalizePrefs, wantsInApp } from './prefs.ts';

// P15-27: "Nadia invited you to Design review". The meetings plugin says `meetings.invite.sent` when people are asked to a live call (as it starts, or with "Invite more"),
// with their ids; this makes one notification of the kind `meeting_invite` per person asked who can still read the call's channel, from the person who asked, opening the
// call card (`thread_root_id` is the call's start message; the reference is the meeting, `ref_type = meeting_invite`). The person's own settings apply as for a mention:
// a muted channel (membership or settings), the channel level "nothing" and the mentions switch turned off in the app leave them out; Do not disturb holds it; the
// browser push is worded in `push.ts`. One row per person and call: the event delivered twice writes nothing
// the second time, and a person is never asked twice (the meetings plugin leaves out the people asked before).
//
// A call that has ended by the time the event is read says nothing. A call in a direct message never makes one: everyone in the conversation is rung, and the ring is
// the invitation (the meetings plugin does not invite there; this is the second guard).
const PREVIEW_MAX = 140;

/** "Nadia invited you to Design review", cut in the title to the preview length (never in the name or the middle words). */
export function meetingInvitePreview(inviter: string, title: string): string {
  const who = [...(inviter.replace(/\s+/g, ' ').trim() || 'Someone')].slice(0, 60).join('');
  const head = `${who} invited you to `;
  const name = title.replace(/\s+/g, ' ').trim() || 'a call';
  const chars = [...name];
  const room = Math.max(1, PREVIEW_MAX - [...head].length);
  return `${head}${chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : name}`;
}

export function registerMeetingInvite(ctx: PluginContext): void {
  ctx.events.subscribe('meetings.invite.sent', async (raw: PluginEvent, tx: PluginTx) => {
    const event = MeetingsInviteSentEvent.parse(raw);

    // The words come from the meeting and the person who asked (the event carries ids only).
    const call = (
      await tx.query<{ title: string; thread_root_id: string | null; channel_kind: string; inviter_name: string | null }>(
        `SELECT m.title, m.thread_root_id, c.kind AS channel_kind,
                (SELECT p.display_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id WHERE a.id = $2::uuid AND a.kind = 'person') AS inviter_name
           FROM app.meetings m JOIN app.channels c ON c.id = m.channel_id
          WHERE m.id = $1::uuid AND m.channel_id = $3::uuid AND m.state = 'live'`,
        [event.meetingId, event.invitedBy, event.channelId],
      )
    ).rows[0];
    if (!call || call.channel_kind === 'dm') return;

    // Only people who can read the channel now: the inbox policy hides the row from anyone else, but we do not even write it.
    const people = (
      await tx.query<{ person_id: string }>(
        'SELECT DISTINCT a.person_id FROM unnest($1::uuid[]) AS a(person_id) WHERE a.person_id IN (SELECT person_id FROM app.channel_audience($2::uuid))',
        [[...new Set(event.personIds)], event.channelId],
      )
    ).rows.map((r) => r.person_id);
    if (people.length === 0) return;

    // the person's own settings, read as `deliver` (service.ts) reads them for a mention
    const settings = await tx.query<{ person_id: string; prefs: unknown; muted: boolean; level: string | null }>(
      `SELECT w.person_id, np.prefs, coalesce(cm.muted, false) AS muted, nl.level
         FROM unnest($1::uuid[]) AS w(person_id)
         LEFT JOIN app.notification_prefs np ON np.person_id = w.person_id
         LEFT JOIN app.channel_members cm ON cm.channel_id = $2::uuid AND cm.person_id = w.person_id
         LEFT JOIN app.notification_levels nl ON nl.channel_id = $2::uuid AND nl.person_id = w.person_id`,
      [people, event.channelId],
    );
    const workspaceDefault = await workspaceDefaultLevel(tx, event.workspaceId);
    const prefsOf = new Map<string, ReturnType<typeof normalizePrefs>>();
    const wanted: string[] = [];
    for (const s of settings.rows) {
      const prefs = normalizePrefs(s.prefs);
      prefsOf.set(s.person_id, prefs);
      const own = NotificationLevel.safeParse(s.level);
      const level = effectiveLevel(own.success ? own.data : null, call.channel_kind, workspaceDefault);
      if (!s.muted && levelAllows(level, 'meeting_invite') && wantsInApp(prefs, 'meeting_invite', event.channelId)) wanted.push(s.person_id);
    }
    if (wanted.length === 0) return;

    const inviter = (call.inviter_name ?? '').trim() || 'Someone';
    const quiet = await quietPeople(tx, wanted, ctx.runtime.now());
    const preview = meetingInvitePreview(inviter, call.title);
    const written: { id: string; person_id: string; held_at: Date | null }[] = [];
    for (const personId of wanted) {
      const row = await tx.query<{ id: string; person_id: string; held_at: Date | null }>(
        `INSERT INTO app.notifications (workspace_id, person_id, kind, ref_type, ref_id, channel_id, thread_root_id, actor_id, actor_name, preview, held_at)
         VALUES ($1::uuid, $2::uuid, 'meeting_invite', 'meeting_invite', $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, CASE WHEN $9::boolean THEN now() END)
         ON CONFLICT (person_id, ref_type, ref_id) DO NOTHING
         RETURNING id, person_id, held_at`,
        [event.workspaceId, personId, event.meetingId, event.channelId, call.thread_root_id, event.invitedBy, inviter.slice(0, 200), preview, quiet.has(personId)],
      );
      if (row.rows[0]) written.push(row.rows[0]);
    }
    if (written.length === 0) return;

    await announce(ctx, tx, event.workspaceId, written.filter((r) => r.held_at === null), prefsOf);
  });
}
