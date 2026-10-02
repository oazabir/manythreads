import {
  AddChannelMemberRequest,
  AddChannelMemberResponse,
  ArchiveChannelResponse,
  ChannelMemberPathParams,
  ChannelPathParams,
  CreateChannelGroupRequest,
  CreateChannelGroupResponse,
  CreateChannelRequest,
  CreateChannelResponse,
  GetChannelResponse,
  JoinChannelResponse,
  LeaveChannelResponse,
  ListChannelMembersResponse,
  NavChannelDirectory,
  RemoveChannelMemberResponse,
  TeamSlugParams,
  UpdateChannelRequest,
  UpdateChannelResponse,
  addChannelMemberRoute,
  archiveChannelRoute,
  createChannelGroupRoute,
  createChannelRoute,
  getChannelRoute,
  joinChannelRoute,
  leaveChannelRoute,
  listChannelMembersRoute,
  navChannelDirectoryRoute,
  removeChannelMemberRoute,
  unarchiveChannelRoute,
  updateChannelRoute,
} from '@manythreads/shared';
import type { PluginTx } from '@manythreads/sdk';
import { conflict, forbidden, invalid, json, notFound, route } from './http.ts';
import {
  CHANNEL_COLUMNS,
  toChannel,
  toChannelGroup,
  type ChannelGroupRow,
  type ChannelRow,
} from './rows.ts';
import { can, channelTeamId, myPersonId, pushChannelCreated, requireChannel, type Deps } from './service.ts';

type TeamRow = {
  id: string;
  workspace_id: string;
  archived_at: Date | null;
};

const stripHash = (name: string): string => name.replace(/^#/, '');

/** The team of a slug as the caller may see it; 403 for a team they cannot see (404 only for a workspace admin, as in the teams plugin). */
async function requireTeam(tx: PluginTx, slug: string): Promise<TeamRow> {
  const res = await tx.query<TeamRow>('SELECT id, workspace_id, archived_at FROM app.teams WHERE slug = $1', [slug]);
  const team = res.rows[0];
  if (team) return team;
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role === 'owner' || role === 'admin') throw notFound(`No team "${slug}"`);
  throw forbidden('You cannot see this team');
}

async function requireManageTeam(tx: PluginTx, team: TeamRow): Promise<void> {
  const res = await tx.query<{ ok: boolean }>("SELECT app.can_in_team($1, 'manage') AS ok", [team.id]);
  if (res.rows[0]?.ok !== true) throw forbidden('Only a team lead or workspace admin can do that');
  if (team.archived_at) throw conflict('This team is archived');
}

/** Template channels for a team that was seeded or created without the event: once per team, then a no-op (see 0001). */
export async function syncTemplateChannels(deps: Deps, tx: PluginTx, teamId: string): Promise<void> {
  const created = await tx.query<{ channel_id: string; name: string; private: boolean }>(
    'SELECT channel_id, name, private FROM app.channels_sync_template($1)',
    [teamId],
  );
  for (const row of created.rows) {
    await deps.ctx.audit.emit(tx, {
      type: 'channel.channel.created',
      channelId: row.channel_id,
      teamId,
      name: row.name,
      kind: 'channel',
      private: row.private,
    });
  }
}

export function registerChannelRoutes(deps: Deps): void {
  const { ctx } = deps;
  const emit = ctx.audit.emit;

  // The sidebar's channel groups (shell feature-detects this route; shape: NavChannelDirectory). A guest gets only the channels
  // granted to them, in one group, whatever the slug: they have no team to name.
  ctx.http.route({
    ...navChannelDirectoryRoute,
    schema: { response: NavChannelDirectory },
    handler: route(async (req, tx) => {
      const { slug } = TeamSlugParams.parse(req.params);
      const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role ?? null;
      const rows =
        role === 'guest'
          ? (
              await tx.query<DirectoryRow>(
                `SELECT c.id, c.name, c.private, NULL::uuid AS group_id, NULL::text AS group_name, 0 AS group_position, c.position, NULL::uuid AS team_id
                   FROM app.channels c WHERE c.kind = 'channel' AND c.archived_at IS NULL ORDER BY lower(c.name), c.id`,
              )
            ).rows
          : await teamDirectory(deps, tx, slug);
      const groups = new Map<string, { id: string; name: string; channels: { id: string; name: string; isPrivate: boolean; unread: number }[] }>();
      for (const r of rows) {
        const key = r.group_id ?? `ungrouped:${r.team_id ?? 'none'}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { id: r.group_id ?? r.team_id ?? 'channels', name: r.group_name ?? 'Channels', channels: [] }));
        g.channels.push({ id: r.id, name: r.name, isPrivate: r.private, unread: 0 });
      }
      return json(NavChannelDirectory.parse({ groups: [...groups.values()] }));
    }),
  });

  ctx.http.route({
    ...createChannelGroupRoute,
    schema: { body: CreateChannelGroupRequest },
    handler: route(async (req, tx) => {
      const { slug } = TeamSlugParams.parse(req.params);
      const body = CreateChannelGroupRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManageTeam(tx, team);
      const id = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
      const position = (
        await tx.query<{ n: number }>('SELECT coalesce(max(position), 0) + 1 AS n FROM app.channel_groups WHERE team_id = $1', [team.id])
      ).rows[0]!.n;
      const row = await ctx.db.getOneOrCreate<ChannelGroupRow>(tx, {
        table: 'app.channel_groups',
        values: { id, workspace_id: team.workspace_id, team_id: team.id, name: body.name, position },
        conflict: ['team_id', 'name'],
        returning: ['id', 'workspace_id', 'team_id', 'name', 'position', 'created_at'],
      });
      const created = row.id === id;
      return json(CreateChannelGroupResponse.parse({ group: toChannelGroup(row), created }), created ? 201 : 200);
    }),
  });

  ctx.http.route({
    ...createChannelRoute,
    schema: { body: CreateChannelRequest },
    handler: route(async (req, tx) => {
      const { slug } = TeamSlugParams.parse(req.params);
      const body = CreateChannelRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManageTeam(tx, team);
      if (body.groupId) {
        const group = await tx.query<{ team_id: string }>('SELECT team_id FROM app.channel_groups WHERE id = $1', [body.groupId]);
        if (group.rows[0]?.team_id !== team.id) throw invalid('groupId: no such group in this team');
      }
      const name = stripHash(body.name);
      const isPrivate = body.private === true;
      // Without a group the channel joins the team's default group ("Channels", made by the template), when there is one.
      const groupId =
        body.groupId !== undefined
          ? body.groupId
          : ((await tx.query<{ id: string }>("SELECT id FROM app.channel_groups WHERE team_id = $1 AND name = 'Channels'", [team.id])).rows[0]?.id ?? null);
      const id = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
      // No RETURNING: the new private channel is not in this statement's visibility set yet. Read it back afterwards.
      await tx.query(
        `INSERT INTO app.channels (id, workspace_id, team_id, group_id, name, kind, private, purpose, position, created_by)
         VALUES ($1, $2, $3, $4, $5, 'channel', $6, $7, (SELECT coalesce(max(position), 0) + 1 FROM app.channels WHERE team_id = $3), app.actor())`,
        [id, team.workspace_id, team.id, groupId, name, isPrivate, body.purpose ?? ''],
      ).catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505') throw conflict(`A channel named "#${name}" already exists in this team`);
        throw err;
      });
      if (isPrivate) {
        const me = await myPersonId(tx);
        if (!me) throw conflict('Only a person can create a private channel');
        await tx.query('SELECT app.channels_add_member($1, $2)', [id, me]);
      }
      const row = (await tx.query<ChannelRow>(`SELECT ${CHANNEL_COLUMNS} FROM app.channels c WHERE c.id = $1`, [id])).rows[0];
      if (!row) throw conflict('The channel was created but you cannot see it: join the team first');
      await emit(tx, { type: 'channel.channel.created', channelId: id, teamId: team.id, name, kind: 'channel', private: isPrivate });
      await pushChannelCreated(deps, tx, row);
      return json(CreateChannelResponse.parse({ channel: toChannel(row) }), 201);
    }),
  });

  ctx.http.route({
    ...getChannelRoute,
    schema: { response: GetChannelResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelPathParams.parse(req.params);
      const channel = await requireChannel(tx, channelId);
      const member = await tx.query('SELECT 1 FROM app.channel_members WHERE channel_id = $1 AND person_id = app.person_id()', [channelId]);
      return json(
        GetChannelResponse.parse({
          channel: toChannel(channel),
          isMember: member.rows.length > 0,
          canPost: !channel.archived_at && (await can(tx, channelId, 'post')),
          canManage: await can(tx, channelId, 'manage'),
        }),
      );
    }),
  });

  ctx.http.route({
    ...updateChannelRoute,
    schema: { body: UpdateChannelRequest, response: UpdateChannelResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelPathParams.parse(req.params);
      const body = UpdateChannelRequest.parse(req.body);
      const channel = await requireChannel(tx, channelId);
      if (!(await can(tx, channelId, 'manage'))) throw forbidden('Only a team lead or workspace admin can change a channel');
      if (channel.archived_at) throw conflict('This channel is archived');
      const changes: { name?: string; purpose?: string; groupId?: string | null } = {};
      if (body.name !== undefined && stripHash(body.name) !== channel.name) changes.name = stripHash(body.name);
      if (body.purpose !== undefined && body.purpose !== channel.purpose) changes.purpose = body.purpose;
      if (body.groupId !== undefined && body.groupId !== channel.group_id) changes.groupId = body.groupId;
      if (Object.keys(changes).length === 0) return json(UpdateChannelResponse.parse({ channel: toChannel(channel), changed: false }));
      const res = await tx
        .query<ChannelRow>(
          `UPDATE app.channels c SET name = coalesce($2, name), purpose = coalesce($3, purpose),
                  group_id = CASE WHEN $4::boolean THEN $5::uuid ELSE group_id END, updated_at = now()
            WHERE c.id = $1 RETURNING ${CHANNEL_COLUMNS}`,
          [channelId, changes.name ?? null, changes.purpose ?? null, 'groupId' in changes, changes.groupId ?? null],
        )
        .catch((err: unknown) => {
          if ((err as { code?: string }).code === '23505') throw conflict(`A channel named "#${changes.name ?? ''}" already exists in this team`);
          throw err;
        });
      const row = res.rows[0];
      if (!row) throw forbidden('You cannot change this channel');
      await emit(tx, { type: 'channel.channel.updated', channelId, teamId: row.team_id, changes });
      return json(UpdateChannelResponse.parse({ channel: toChannel(row), changed: true }));
    }),
  });

  const setArchived = (archived: boolean) =>
    route(async (req, tx) => {
      const { channelId } = ChannelPathParams.parse(req.params);
      const channel = await requireChannel(tx, channelId);
      if (!(await can(tx, channelId, 'manage'))) throw forbidden('Only a team lead or workspace admin can archive a channel');
      const res = await tx.query<ChannelRow>(
        `UPDATE app.channels c SET archived_at = ${archived ? 'now()' : 'NULL'}, updated_at = now()
          WHERE c.id = $1 AND (c.archived_at IS NULL) = $2 RETURNING ${CHANNEL_COLUMNS}`,
        [channelId, archived],
      );
      const row = res.rows[0];
      if (row) await emit(tx, { type: 'channel.channel.archived', channelId, teamId: row.team_id, archived });
      return json(ArchiveChannelResponse.parse({ channel: toChannel(row ?? channel), changed: row !== undefined }));
    });
  ctx.http.route({ ...archiveChannelRoute, schema: { response: ArchiveChannelResponse }, handler: setArchived(true) });
  ctx.http.route({ ...unarchiveChannelRoute, schema: { response: ArchiveChannelResponse }, handler: setArchived(false) });

  ctx.http.route({
    ...joinChannelRoute,
    schema: { response: JoinChannelResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelPathParams.parse(req.params);
      const joined = (await tx.query<{ joined: boolean }>('SELECT app.channels_join($1) AS joined', [channelId])).rows[0]?.joined === true;
      if (joined) {
        const channel = await requireChannel(tx, channelId);
        const personId = (await myPersonId(tx))!;
        await emit(tx, { type: 'channel.member.added', channelId, teamId: channel.team_id, personId, self: true });
      }
      return json(JoinChannelResponse.parse({ joined }));
    }),
  });

  ctx.http.route({
    ...leaveChannelRoute,
    schema: { response: LeaveChannelResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelPathParams.parse(req.params);
      const channel = await requireChannel(tx, channelId);
      const personId = await myPersonId(tx);
      if (!personId) throw forbidden('Only a person can leave a channel');
      const left = (await tx.query<{ left: boolean }>('SELECT app.channels_remove_member($1, $2) AS "left"', [channelId, personId])).rows[0]?.left === true;
      if (left) await emit(tx, { type: 'channel.member.removed', channelId, teamId: channel.team_id, personId, self: true });
      return json(LeaveChannelResponse.parse({ left }));
    }),
  });

  ctx.http.route({
    ...listChannelMembersRoute,
    schema: { response: ListChannelMembersResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelPathParams.parse(req.params);
      await requireChannel(tx, channelId);
      const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
      if (role === 'guest') throw forbidden('Guests do not see member lists');
      const res = await tx.query<{ person_id: string; display_name: string; muted: boolean; created_at: Date }>(
        `SELECT m.person_id, p.display_name, m.muted, m.created_at
           FROM app.channel_members m JOIN app.people p ON p.id = m.person_id
          WHERE m.channel_id = $1 ORDER BY lower(p.display_name), m.person_id`,
        [channelId],
      );
      return json(
        ListChannelMembersResponse.parse({
          members: res.rows.map((r) => ({
            personId: r.person_id,
            displayName: r.display_name,
            muted: r.muted,
            joinedAt: r.created_at.toISOString(),
          })),
        }),
      );
    }),
  });

  ctx.http.route({
    ...addChannelMemberRoute,
    schema: { body: AddChannelMemberRequest, response: AddChannelMemberResponse },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelPathParams.parse(req.params);
      const { personId } = AddChannelMemberRequest.parse(req.body);
      const added = (await tx.query<{ added: boolean }>('SELECT app.channels_add_member($1, $2) AS added', [channelId, personId])).rows[0]?.added === true;
      if (added) {
        const teamId = await channelTeamId(tx, channelId);
        await emit(tx, { type: 'channel.member.added', channelId, teamId, personId, self: (await myPersonId(tx)) === personId });
      }
      return json(AddChannelMemberResponse.parse({ added }));
    }),
  });

  ctx.http.route({
    ...removeChannelMemberRoute,
    schema: { response: RemoveChannelMemberResponse },
    handler: route(async (req, tx) => {
      const { channelId, personId } = ChannelMemberPathParams.parse(req.params);
      const removed = (await tx.query<{ removed: boolean }>('SELECT app.channels_remove_member($1, $2) AS removed', [channelId, personId])).rows[0]?.removed === true;
      if (removed) {
        await emit(tx, {
          type: 'channel.member.removed',
          channelId,
          teamId: await channelTeamId(tx, channelId),
          personId,
          self: (await myPersonId(tx)) === personId,
        });
      }
      return json(RemoveChannelMemberResponse.parse({ removed }));
    }),
  });
}

type DirectoryRow = {
  id: string;
  name: string;
  private: boolean;
  group_id: string | null;
  group_name: string | null;
  group_position: number;
  position: number;
  team_id: string | null;
};

/** The channels of one team the caller can see, by group then position (row level security hides the rest). */
async function teamDirectory(deps: Deps, tx: PluginTx, slug: string): Promise<DirectoryRow[]> {
  const team = (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [slug])).rows[0];
  if (!team) return [];
  await syncTemplateChannels(deps, tx, team.id);
  return (
    await tx.query<DirectoryRow>(
      `SELECT c.id, c.name, c.private, c.group_id, g.name AS group_name, coalesce(g.position, 2147483647) AS group_position,
              c.position, c.team_id
         FROM app.channels c LEFT JOIN app.channel_groups g ON g.id = c.group_id
        WHERE c.team_id = $1 AND c.kind = 'channel' AND c.archived_at IS NULL
        ORDER BY coalesce(g.position, 2147483647), lower(coalesce(g.name, '')), c.position, lower(c.name), c.id`,
      [team.id],
    )
  ).rows;
}

