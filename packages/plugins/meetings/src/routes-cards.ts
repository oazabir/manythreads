import { json, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { CALL_CARD_FACES, CallCard, ListCallCardsQuery, ListCallCardsResponse, listCallCardsRoute } from '@manythreads/shared';
import { isListening } from './listener.ts';
import { callerPerson } from './routes.ts';
import { MEETING_COLUMNS, type MeetingRow } from './rows.ts';

// The call cards (P15-26, docs/plugins/meetings.md "The call card"): a call's start message carries `meta.meeting`, and the web draws the card in its place from what this
// route answers. The meetings and their people are read through the caller's own row policies, so a call in a channel the caller cannot read is simply not in the answer.
// Only the names of the team and of the note-taker bot, and whether the notes are written, are read as the system, and only for calls the caller has already read.

interface PersonRow extends Record<string, unknown> {
  meeting_id: string;
  actor_id: string;
  display_name: string;
  left_at: Date | null;
}

interface InviteRow extends Record<string, unknown> {
  meeting_id: string;
  display_name: string;
  n: number;
}

interface RightsRow extends Record<string, unknown> {
  id: string;
  can_end: boolean;
  can_post: boolean;
  is_dm: boolean;
  can_notes: boolean;
  starter_name: string | null;
}

async function buildCards(ctx: PluginContext, tx: PluginTx, ids: readonly string[]): Promise<CallCard[]> {
  const caller = await callerPerson(tx);
  const rows = (await tx.query<MeetingRow & Record<string, unknown>>(`SELECT ${MEETING_COLUMNS} FROM app.meetings m WHERE m.id = ANY ($1::uuid[]) ORDER BY m.started_at, m.id`, [ids])).rows;
  if (rows.length === 0) return [];
  const found = rows.map((r) => r.id);
  const people = (
    await tx.query<PersonRow>(
      'SELECT p.meeting_id::text, p.actor_id::text, p.display_name, p.left_at FROM app.meeting_participants p WHERE p.meeting_id = ANY ($1::uuid[]) ORDER BY p.joined_at, p.actor_id',
      [found],
    )
  ).rows;
  // what the caller may do, asked the way the database decides it: ending is app.meetings_end's rule, inviting is the right to post, the notes are app.meetings_can_read_notes
  const rights = new Map(
    (
      await tx.query<RightsRow>(
        `SELECT m.id::text,
                (m.started_by = app.actor()
                 OR coalesce(CASE WHEN m.channel_id IS NOT NULL THEN app.lookup_channel_can(m.channel_id, 'manage') ELSE app.lookup_can_team(m.team_id, 'manage') END, false)) AS can_end,
                coalesce(m.channel_id IS NOT NULL AND app.lookup_channel_can(m.channel_id, 'post'), false) AS can_post,
                coalesce((SELECT c.kind = 'dm' FROM app.channels c WHERE c.id = m.channel_id), false) AS is_dm,
                coalesce(app.meetings_can_read_notes(m.id), false) AS can_notes,
                app.meetings_organizer_name(m.started_by) AS starter_name
           FROM app.meetings m WHERE m.id = ANY ($1::uuid[])`,
        [found],
      )
    ).rows.map((r) => [r.id, r] as const),
  );
  // the people asked (P15-27), through the caller's row policies: how many, and the first names in the order they were asked
  const invites = (
    await tx.query<InviteRow>(
      `SELECT i.meeting_id::text, i.display_name, i.n FROM (
         SELECT meeting_id, display_name, count(*) OVER (PARTITION BY meeting_id)::int AS n,
                row_number() OVER (PARTITION BY meeting_id ORDER BY invited_at, person_id) AS rn
           FROM app.meeting_invites WHERE meeting_id = ANY ($1::uuid[])) i
        WHERE i.rn <= $2 ORDER BY i.meeting_id, i.rn`,
      [found, CALL_CARD_FACES],
    )
  ).rows;
  const notesFor = found.filter((id) => rights.get(id)?.can_notes === true);
  const teamIds = [...new Set(rows.map((r) => r.team_id).filter((t): t is string => t !== null))];
  const botIds = [...new Set(rows.map((r) => r.notetaker_bot_id).filter((b): b is string => b !== null))];
  const names = await ctx.db.system(
    async (sys) => ({
      written: new Set(
        notesFor.length === 0
          ? []
          : (await sys.query<{ meeting_id: string }>("SELECT meeting_id::text FROM app.meeting_notes WHERE meeting_id = ANY ($1::uuid[]) AND status = 'written'", [notesFor])).rows.map((r) => r.meeting_id),
      ),
      teams: new Map(
        teamIds.length === 0 ? [] : (await sys.query<{ id: string; slug: string }>('SELECT id::text, slug FROM app.teams WHERE id = ANY ($1::uuid[])', [teamIds])).rows.map((r) => [r.id, r.slug] as const),
      ),
      bots: new Map(
        botIds.length === 0 ? [] : (await sys.query<{ id: string; name: string }>('SELECT id::text, name FROM app.bots WHERE id = ANY ($1::uuid[])', [botIds])).rows.map((r) => [r.id, r.name] as const),
      ),
    }),
    { workspaceId: tx.actor.workspaceId },
  );

  return rows.map((m) => {
    const all = people.filter((p) => p.meeting_id === m.id);
    const here = all.filter((p) => p.left_at === null);
    const right = rights.get(m.id);
    const live = m.state === 'live';
    const slug = m.team_id === null ? undefined : names.teams.get(m.team_id);
    const bot = m.notetaker_bot_id === null ? undefined : names.bots.get(m.notetaker_bot_id);
    return CallCard.parse({
      meetingId: m.id,
      kind: m.kind,
      title: m.title,
      state: m.state,
      startedBy: m.started_by,
      starterName: all.find((p) => p.actor_id === m.started_by)?.display_name ?? right?.starter_name ?? 'Someone',
      startedAt: m.started_at.toISOString(),
      endedAt: m.ended_at ? m.ended_at.toISOString() : null,
      durationSeconds: m.ended_at ? Math.max(0, Math.round((m.ended_at.getTime() - m.started_at.getTime()) / 1000)) : null,
      present: here.slice(0, CALL_CARD_FACES).map((p) => ({ actorId: p.actor_id, displayName: p.display_name })),
      presentCount: here.length,
      joinedCount: all.length,
      invited: (() => {
        const mine = invites.filter((i) => i.meeting_id === m.id);
        return { count: mine[0]?.n ?? 0, names: mine.map((i) => i.display_name) };
      })(),
      notetaker: bot === undefined ? null : { name: bot, listening: live && isListening(ctx, m.id) },
      you: {
        joined: here.some((p) => p.actor_id === caller.actorId),
        canEnd: live && right?.can_end === true,
        // a direct message invites nobody: everyone in it was rung
        canInvite: live && right?.can_post === true && right.is_dm !== true,
      },
      notesLink: names.written.has(m.id) ? (slug !== undefined ? `/t/${slug}/meetings/${m.id}` : `/meetings/${m.id}`) : null,
    });
  });
}

export function registerCallCardRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listCallCardsRoute,
    schema: { query: ListCallCardsQuery, response: ListCallCardsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { ids } = ListCallCardsQuery.parse(req.query);
      return json(ListCallCardsResponse.parse({ cards: await buildCards(ctx, tx, [...new Set(ids)]) }));
    }),
  });
}
