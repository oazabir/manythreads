import { createHash, randomBytes } from 'node:crypto';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  CreateTeamInvitationResponse,
  GetInvitationResponse,
  InviteTeamMemberRequest,
  ListTeamInvitationsResponse,
  acceptInvitationRoute,
  createInvitationRoute,
  createTeamInvitationRoute,
  getInvitationRoute,
  listTeamInvitationsRoute,
} from '@manythreads/shared';
import { conflict, forbidden, gone, json, notFound, route, SlugParam, TokenParam } from './http.ts';
import { rosterRows } from './routes-roster.ts';
import { INVITATION_COLUMNS, toInvitation, type InvitationRow } from './rows.ts';
import {
  callerPersonId,
  isWorkspaceAdmin,
  requireActive,
  requireManage,
  requireTeam,
  type Deps,
} from './teams.ts';

/** A fresh token (shown once) and the sha256 that is stored. */
const newToken = (): { token: string; hash: Buffer } => {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
};
const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

interface InsertInvitation {
  teamId: string | null;
  email: string;
  role: 'admin' | 'member' | 'guest';
  grant: Record<string, unknown>;
}

async function insertInvitation(tx: PluginTx, input: InsertInvitation): Promise<{ row: InvitationRow; token: string }> {
  const { token, hash } = newToken();
  const invitedBy = await callerPersonId(tx);
  const res = await tx.query<InvitationRow>(
    `INSERT INTO app.invitations (workspace_id, team_id, email, role, grant_spec, token_hash, invited_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING ${INVITATION_COLUMNS}`,
    [tx.actor.workspaceId, input.teamId, input.email, input.role, JSON.stringify(input.grant), hash, invitedBy],
  );
  const row = res.rows[0];
  if (!row) throw new Error('invitation insert returned no row');
  return { row, token };
}

/** The invitation mail. Best effort: a mail failure never fails the invitation (the creator still has the token). */
async function sendInviteMail(ctx: PluginContext, tx: PluginTx, input: { email: string; token: string; teamName: string | null }): Promise<void> {
  try {
    const who = await tx.query<{ inviter: string | null; workspace: string | null }>(
      `SELECT (SELECT p.display_name FROM app.people p WHERE p.id = app.person_id()) AS inviter,
              (SELECT w.name FROM app.workspaces w WHERE w.id = app.workspace_id()) AS workspace`,
    );
    await ctx.mail.send({
      template: 'invite',
      to: input.email,
      inviterName: who.rows[0]?.inviter ?? 'Someone',
      workspaceName: who.rows[0]?.workspace ?? 'your workspace',
      teamName: input.teamName,
      url: `${ctx.runtime.publicUrl}/invite/${input.token}`,
    });
  } catch {
    // Delivery is retried by the person re-inviting; nothing to roll back.
  }
}

export function registerInvitationRoutes(ctx: PluginContext, { emit }: Deps): void {
  ctx.http.route({
    ...createTeamInvitationRoute,
    schema: { body: InviteTeamMemberRequest, response: CreateTeamInvitationResponse },
    handler: route(async (req, tx) => {
      const { slug } = SlugParam.parse(req.params);
      const body = InviteTeamMemberRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      requireActive(team);
      if ((await rosterRows(tx, team.id)).some((m) => m.email.toLowerCase() === body.email)) {
        throw conflict(`${body.email} is already on this team`);
      }
      const { row, token } = await insertInvitation(tx, {
        teamId: team.id,
        email: body.email,
        role: 'member',
        grant: { teamRole: body.teamRole },
      });
      await emit(tx, {
        type: 'workspace.invitation.created',
        teamId: team.id,
        invitationId: row.id,
        email: row.email,
        role: 'member',
        teamRole: body.teamRole,
      });
      await sendInviteMail(ctx, tx, { email: row.email, token, teamName: team.name });
      return json(CreateTeamInvitationResponse.parse({ invitation: toInvitation(row), token }), 201);
    }),
  });

  ctx.http.route({
    ...listTeamInvitationsRoute,
    schema: { response: ListTeamInvitationsResponse },
    handler: route(async (req, tx) => {
      const team = await requireTeam(tx, SlugParam.parse(req.params).slug);
      await requireManage(tx, team);
      const res = await tx.query<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM app.invitations
         WHERE team_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC, id`,
        [team.id],
      );
      return json(ListTeamInvitationsResponse.parse({ invitations: res.rows.map(toInvitation) }));
    }),
  });

  // Workspace-level invitations (admins): another admin, a member without a team, or a guest with pending channel grants.
  ctx.http.route({
    ...createInvitationRoute,
    schema: { body: CreateInvitationRequest, response: CreateInvitationResponse },
    handler: route(async (req, tx) => {
      const body = CreateInvitationRequest.parse(req.body);
      if (!(await isWorkspaceAdmin(tx))) throw forbidden('Only a workspace admin can invite to the workspace');
      let grant: Record<string, unknown> = {};
      if (body.role === 'guest') {
        const channels = body.channels ?? [];
        const slugs = [...new Set(channels.map((c) => c.teamSlug))];
        const teams = await tx.query<{ id: string; slug: string }>('SELECT id, slug FROM app.teams WHERE slug = ANY($1::text[])', [slugs]);
        const byId = new Map(teams.rows.map((t) => [t.slug, t.id]));
        const missing = slugs.find((s) => !byId.has(s));
        if (missing) throw notFound(`No team "${missing}"`);
        // Recorded now, applied when channels exist (the channel does not have to be there yet).
        grant = { channels: channels.map((c) => ({ teamId: byId.get(c.teamSlug), teamSlug: c.teamSlug, channel: c.channel })) };
      }
      const { row, token } = await insertInvitation(tx, { teamId: null, email: body.email, role: body.role, grant });
      await emit(tx, {
        type: 'workspace.invitation.created',
        teamId: null,
        invitationId: row.id,
        email: row.email,
        role: body.role,
        teamRole: null,
      });
      await sendInviteMail(ctx, tx, { email: row.email, token, teamName: null });
      return json(CreateInvitationResponse.parse({ invitation: toInvitation(row), token }), 201);
    }),
  });

  // Public from here: the token is the credential. Both are rate limited per client address.
  ctx.http.route({
    ...getInvitationRoute,
    public: true,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: GetInvitationResponse },
    handler: route(async (req, tx) => {
      const { token } = TokenParam.parse(req.params);
      const res = await tx.query<{ info: { outcome: string } & Record<string, unknown> }>(
        'SELECT app.teams_invitation_info($1) AS info',
        [hashToken(token)],
      );
      const info = res.rows[0]?.info;
      if (!info || info.outcome === 'not_found') throw notFound('This invitation link is not valid');
      if (info.outcome === 'gone') return gone('This invitation has expired or was already used');
      return json(GetInvitationResponse.parse(info));
    }),
  });

  ctx.http.route({
    ...acceptInvitationRoute,
    public: true,
    rateLimit: { limit: 10, windowMs: 60_000 },
    schema: { body: AcceptInvitationRequest, response: AcceptInvitationResponse },
    handler: route(async (req, tx) => {
      const { token } = TokenParam.parse(req.params);
      const body = AcceptInvitationRequest.parse(req.body ?? {});
      const res = await tx.query<{ result: { outcome: string } & Record<string, unknown> }>(
        'SELECT app.teams_invitation_accept($1, $2) AS result',
        [hashToken(token), body.name ?? null],
      );
      const result = res.rows[0]?.result;
      if (!result || result.outcome === 'not_found') throw notFound('This invitation link is not valid');
      if (result.outcome === 'gone') return gone('This invitation has expired or was already used');
      if (result.outcome === 'forbidden') throw forbidden('This account is suspended');
      return json(AcceptInvitationResponse.parse(result));
    }),
  });
}
