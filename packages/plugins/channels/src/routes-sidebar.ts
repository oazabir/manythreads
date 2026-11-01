import type { PluginTx } from '@manythreads/sdk';
import {
  DEFAULT_SIDEBAR_PREFS,
  GetSidebarPrefsResponse,
  MAX_STARRED_CHANNELS,
  PutSidebarPrefsRequest,
  PutSidebarPrefsResponse,
  SidebarPrefs,
  TeamSlugParams,
  getSidebarPrefsRoute,
  putSidebarPrefsRoute,
} from '@manythreads/shared';
import { forbidden, invalid, json, notFound, route } from './http.ts';
import { myPersonId, type Deps } from './service.ts';

type TeamRef = { id: string };

/** The team of a slug as the caller may see it: 403 for one they cannot see (404 only for a workspace admin), as the channel routes answer. */
async function requireTeam(tx: PluginTx, slug: string): Promise<TeamRef> {
  const team = (await tx.query<TeamRef>('SELECT id FROM app.teams WHERE slug = $1', [slug])).rows[0];
  if (team) return team;
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role === 'owner' || role === 'admin') throw notFound(`No team "${slug}"`);
  throw forbidden('You cannot see this team');
}

/** Sidebar settings belong to a person; a bot has none. */
async function requirePerson(tx: PluginTx): Promise<string> {
  const id = await myPersonId(tx);
  if (!id) throw forbidden('The sidebar belongs to people');
  return id;
}

/**
 * The saved view as the caller may see it now: stars only for channels of this team they can still read (and that are not archived), and a
 * group order that names only groups that still exist. Row level security does the filtering of channels; the groups are checked here.
 */
async function readPrefs(tx: PluginTx, personId: string, teamId: string): Promise<SidebarPrefs> {
  const row = (
    await tx.query<{ sort: string; hide_idle: boolean; group_order: string[] }>(
      'SELECT sort, hide_idle, group_order FROM app.sidebar_prefs WHERE person_id = $1::uuid AND team_id = $2::uuid',
      [personId, teamId],
    )
  ).rows[0];
  const stars = await tx.query<{ channel_id: string }>(
    `SELECT s.channel_id FROM app.channel_stars s JOIN app.channels c ON c.id = s.channel_id
      WHERE s.person_id = $1::uuid AND c.team_id = $2::uuid AND c.kind = 'channel' AND c.archived_at IS NULL
      ORDER BY s.created_at, s.channel_id`,
    [personId, teamId],
  );
  const order = row?.group_order ?? [];
  const known = order.length === 0 ? new Set<string>() : await existingGroupIds(tx, teamId, order);
  return SidebarPrefs.parse({
    starred: stars.rows.map((r) => r.channel_id),
    sort: row?.sort ?? DEFAULT_SIDEBAR_PREFS.sort,
    hideIdle: row?.hide_idle ?? DEFAULT_SIDEBAR_PREFS.hideIdle,
    groupOrder: order.filter((id) => known.has(id)),
  });
}

/** Of these ids, the ones that are a group of the team or the team itself (the id the directory gives channels that sit in no group). */
async function existingGroupIds(tx: PluginTx, teamId: string, ids: readonly string[]): Promise<Set<string>> {
  const res = await tx.query<{ id: string }>('SELECT id FROM app.channel_groups WHERE team_id = $1::uuid AND id = ANY($2::uuid[])', [teamId, ids]);
  const found = new Set(res.rows.map((r) => r.id));
  if (ids.includes(teamId)) found.add(teamId);
  return found;
}

/**
 * A person's own sidebar view for one team (PLAN P14-15): stars, sort, "hide idle channels" and the order of the groups. Every row belongs to the
 * caller and row level security enforces it; the checks here make the answers plain (which channel cannot be starred, which group is unknown).
 * Nothing is announced to anyone, so no event is emitted.
 */
export function registerSidebarRoutes(deps: Deps): void {
  const { ctx } = deps;

  ctx.http.route({
    ...getSidebarPrefsRoute,
    schema: { response: GetSidebarPrefsResponse },
    handler: route(async (req, tx) => {
      const { slug } = TeamSlugParams.parse(req.params);
      const person = await requirePerson(tx);
      const team = await requireTeam(tx, slug);
      return json(GetSidebarPrefsResponse.parse(await readPrefs(tx, person, team.id)));
    }),
  });

  ctx.http.route({
    ...putSidebarPrefsRoute,
    rateLimit: { limit: 120, windowMs: 60_000 },
    schema: { body: PutSidebarPrefsRequest, response: PutSidebarPrefsResponse },
    handler: route(async (req, tx) => {
      const { slug } = TeamSlugParams.parse(req.params);
      const body = PutSidebarPrefsRequest.parse(req.body);
      const person = await requirePerson(tx);
      const team = await requireTeam(tx, slug);
      // One writer at a time per person and team, so two quick changes (two devices) cannot interleave their list replacements.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [`channels.sidebar-prefs:${person}:${team.id}`]);

      const add = [...new Set<string>(body.starAdd ?? [])];
      const remove = [...new Set<string>(body.starRemove ?? [])];
      if (add.some((id) => remove.includes(id))) throw invalid('A channel cannot be starred and unstarred in one change.');
      if (add.length > 0) {
        // As the caller: a channel they cannot read looks the same as one that does not exist.
        const seen = await tx.query<{ id: string; team_id: string | null; kind: string; archived: boolean }>(
          'SELECT id, team_id, kind, archived_at IS NOT NULL AS archived FROM app.channels WHERE id = ANY($1::uuid[])',
          [add],
        );
        if (seen.rows.length !== add.length) throw forbidden('You cannot star a channel you cannot see.');
        for (const c of seen.rows) {
          if (c.kind !== 'channel' || c.team_id !== team.id) throw invalid('Only a channel of this team can be starred.');
          if (c.archived) throw invalid('An archived channel cannot be starred.');
        }
        // The cap counts the stars that would be left: this team's current stars, without the ones being removed, plus the new ones.
        const kept = await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM app.channel_stars s JOIN app.channels c ON c.id = s.channel_id
            WHERE s.person_id = $1::uuid AND c.team_id = $2::uuid AND c.kind = 'channel' AND c.archived_at IS NULL
              AND NOT (s.channel_id = ANY($3::uuid[])) AND NOT (s.channel_id = ANY($4::uuid[]))`,
          [person, team.id, add, remove],
        );
        if (Number(kept.rows[0]?.n ?? 0) + add.length > MAX_STARRED_CHANNELS) throw invalid(`You can star at most ${MAX_STARRED_CHANNELS} channels.`);
      }
      if (remove.length > 0) {
        // Only this person's own stars, only in this team; a channel that is not starred is simply left alone.
        await tx.query(
          `DELETE FROM app.channel_stars s USING app.channels c
            WHERE s.person_id = $1::uuid AND c.id = s.channel_id AND c.team_id = $2::uuid AND s.channel_id = ANY($3::uuid[])`,
          [person, team.id, remove],
        );
      }
      if (add.length > 0) {
        await tx.query(
          `INSERT INTO app.channel_stars (person_id, channel_id, workspace_id)
           SELECT $1::uuid, unnest($2::uuid[]), app.workspace_id() ON CONFLICT (person_id, channel_id) DO NOTHING`,
          [person, add],
        );
      }

      let order: string[] | undefined;
      if (body.groupOrder) {
        order = body.groupOrder.map((id) => id.toLowerCase());
        if (new Set(order).size !== order.length) throw invalid('A group can be listed only once.');
        if (order.length > 0) {
          const known = await existingGroupIds(tx, team.id, order);
          if (order.some((id) => !known.has(id))) throw invalid('One of those groups does not belong to this team.');
        }
      }
      if (order !== undefined || body.sort !== undefined || body.hideIdle !== undefined) {
        await tx.query(
          `INSERT INTO app.sidebar_prefs (person_id, team_id, workspace_id, sort, hide_idle, group_order)
           VALUES ($1::uuid, $2::uuid, app.workspace_id(), coalesce($3::text, 'team'), coalesce($4::boolean, false), coalesce($5::uuid[], '{}'))
           ON CONFLICT (person_id, team_id) DO UPDATE SET
             sort = coalesce($3::text, app.sidebar_prefs.sort),
             hide_idle = coalesce($4::boolean, app.sidebar_prefs.hide_idle),
             group_order = coalesce($5::uuid[], app.sidebar_prefs.group_order),
             updated_at = now()`,
          [person, team.id, body.sort ?? null, body.hideIdle ?? null, order ?? null],
        );
      }
      return json(PutSidebarPrefsResponse.parse(await readPrefs(tx, person, team.id)));
    }),
  });
}
