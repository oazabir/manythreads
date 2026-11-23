import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { MeetingsAppointmentChangedEvent, MeetingsAppointmentStartingSoonEvent } from '@manythreads/shared';
import { announce } from './announce.ts';
import { quietPeople } from './hold.ts';
import { normalizePrefs } from './prefs.ts';

/*
 * The team schedule (P36-06, P36-07; docs/plans/team-schedule.md). An invitation: each person newly invited to an appointment gets one `appointment_invite`
 * ("Nadia invited you to Escalation review · Tue 15 Jan 14:00"). A reminder: when an appointment starts in about five minutes its maker and its invited get one
 * `appointment_soon` ("Escalation review starts in 5 minutes"; a moved appointment raises the same row again). Both belong to the appointment's meeting space
 * (only its members get them) and open it. Do not disturb holds them; the browser push is sent like the other kinds.
 */

const PREVIEW_MAX = 140;
const clip = (s: string, n: number): string => {
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('');
};

/** "Tue 15 Jan 14:00 UTC" */
const whenText = (at: Date): string =>
  `${at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} ${at.toISOString().slice(11, 16)} UTC`;

export const appointmentInvitePreview = (inviter: string, title: string, at: Date): string => clip(`${inviter} invited you to ${title} · ${whenText(at)}`, PREVIEW_MAX);
export const appointmentSoonPreview = (title: string): string => `${clip(title, PREVIEW_MAX - 20)} starts in 5 minutes`;

type Facts = { title: string; starts_at: Date; space: string; maker_actor: string | null; maker_name: string | null; status: string };

async function factsOf(tx: PluginTx, appointmentId: string): Promise<Facts | undefined> {
  return (
    await tx.query<Facts>(
      `SELECT a.title, a.starts_at, a.space_channel_id AS space, a.created_by AS maker_actor, a.status,
              (SELECT p.display_name FROM app.people p WHERE p.id = a.created_by_person_id) AS maker_name
         FROM app.appointments a WHERE a.id = $1::uuid`,
      [appointmentId],
    )
  ).rows[0];
}

/** Writes one row per person who is a member of the space, and announces the ones not held. */
async function notify(ctx: PluginContext, tx: PluginTx, o: { workspaceId: string; people: readonly string[]; kind: 'appointment_invite' | 'appointment_soon'; refType: 'appointment_invite' | 'appointment'; appointmentId: string; facts: Facts; preview: string; at: string }): Promise<void> {
  const people = (
    await tx.query<{ person_id: string }>(
      'SELECT DISTINCT a.person_id FROM unnest($1::uuid[]) AS a(person_id) WHERE a.person_id IN (SELECT person_id FROM app.channel_audience($2::uuid))',
      [[...new Set(o.people)], o.facts.space],
    )
  ).rows.map((r) => r.person_id);
  if (people.length === 0) return;
  const quiet = await quietPeople(tx, people, ctx.runtime.now());
  const written: { id: string; person_id: string; held_at: Date | null }[] = [];
  for (const personId of people) {
    const row = await tx.query<{ id: string; person_id: string; held_at: Date | null }>(
      `INSERT INTO app.notifications AS n (workspace_id, person_id, kind, ref_type, ref_id, channel_id, actor_id, actor_name, preview, held_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8, $9, CASE WHEN $10::boolean THEN now() END)
       ON CONFLICT (person_id, ref_type, ref_id) DO UPDATE
         SET read_at = NULL, created_at = now(), preview = EXCLUDED.preview, held_at = EXCLUDED.held_at
         WHERE n.created_at < $11::timestamptz
       RETURNING n.id, n.person_id, n.held_at`,
      [o.workspaceId, personId, o.kind, o.refType, o.appointmentId, o.facts.space, o.facts.maker_actor, (o.facts.maker_name ?? 'Someone').slice(0, 200), o.preview, quiet.has(personId), o.at],
    );
    if (row.rows[0]) written.push(row.rows[0]);
  }
  if (written.length === 0) return;
  const prefs = await tx.query<{ person_id: string; prefs: unknown }>('SELECT person_id, prefs FROM app.notification_prefs WHERE person_id = ANY ($1::uuid[])', [written.map((w) => w.person_id)]);
  const prefsOf = new Map(prefs.rows.map((r) => [r.person_id, normalizePrefs(r.prefs)]));
  await announce(ctx, tx, o.workspaceId, written.filter((r) => r.held_at === null), prefsOf);
}

export function registerAppointmentNotifications(ctx: PluginContext): void {
  ctx.events.subscribe('meetings.appointment.changed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = MeetingsAppointmentChangedEvent.parse(raw);
    if (event.change === 'cancelled' || event.invitedPersonIds.length === 0) return;
    const facts = await factsOf(tx, event.appointmentId);
    if (!facts || facts.status !== 'scheduled') return;
    const inviter = (facts.maker_name ?? '').trim() || 'Someone';
    await notify(ctx, tx, {
      workspaceId: event.workspaceId,
      people: event.invitedPersonIds,
      kind: 'appointment_invite',
      refType: 'appointment_invite',
      appointmentId: event.appointmentId,
      facts,
      preview: appointmentInvitePreview(inviter, facts.title, facts.starts_at),
      at: event.at,
    });
  });

  ctx.events.subscribe('meetings.appointment.starting_soon', async (raw: PluginEvent, tx: PluginTx) => {
    const event = MeetingsAppointmentStartingSoonEvent.parse(raw);
    const facts = await factsOf(tx, event.appointmentId);
    if (!facts || facts.status !== 'scheduled') return;
    await notify(ctx, tx, {
      workspaceId: event.workspaceId,
      people: event.personIds,
      kind: 'appointment_soon',
      refType: 'appointment',
      appointmentId: event.appointmentId,
      facts,
      preview: appointmentSoonPreview(facts.title),
      at: event.at,
    });
  });
}
