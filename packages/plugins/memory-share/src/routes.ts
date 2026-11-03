import { conflict, forbidden, json, notFound, requireManage, requireTeam, route, type PluginContext, type PluginTx, type TeamRow } from '@manythreads/sdk';
import {
  GetShareResponse,
  IncomingActionResponse,
  IncomingLinkParams,
  ListIncomingSharesResponse,
  MemorySharingSetting,
  SetMemorySharingBody,
  ShareIncoming,
  GetShareRunResponse,
  ListShareRunsQuery,
  ListShareRunsResponse,
  ListSharesResponse,
  PreviewShareResponse,
  RunShareResponse,
  ShareParams,
  ShareRunParams,
  ShareTeamParams,
  actOnIncomingShareRoute,
  getMemorySharingRoute,
  getShareRoute,
  getShareRunRoute,
  listShareRunsRoute,
  listIncomingSharesRoute,
  listSharesRoute,
  setMemorySharingRoute,
  previewShareRoute,
  runShareRoute,
  shareHeadline,
} from '@manythreads/shared';
import { emitLinked } from './accept.ts';
import { gather, loadLinks, previewOf } from './build.ts';
import { enqueueBuild } from './jobs.ts';
import { RUN_COLUMNS, toRun, toShareView, type LinkRow, type RunRow, type ShareRow } from './rows.ts';
import { SHARING_OFF_REASON, sharingEnabled } from './util.ts';

// The routes of a team's outgoing shares (PLAN P8-22, P8-23). Anyone who can read the team lists its shares and reads one; a lead or workspace admin previews a share,
// runs it now and reads its runs (a run names what was left out). Nothing here sends a digest: that is the next task's. docs/plugins/memory-share.md.

async function canManage(tx: PluginTx, team: TeamRow): Promise<boolean> {
  return (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1, 'manage') AS ok", [team.id])).rows[0]?.ok === true;
}

async function requireShare(tx: PluginTx, team: TeamRow, shareSlug: string): Promise<ShareRow> {
  const row = (await tx.query<ShareRow>(`SELECT * FROM app.memory_shares WHERE team_id = $1 AND slug = $2 AND status <> 'removed'`, [team.id, shareSlug])).rows[0];
  if (!row) throw notFound('No such share in this team');
  return row;
}

export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listSharesRoute,
    schema: { response: ListSharesResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug } = ShareTeamParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const shares = (await tx.query<ShareRow>(`SELECT * FROM app.memory_shares WHERE team_id = $1 AND status <> 'removed' ORDER BY name, slug`, [team.id])).rows;
      const ids = shares.map((s) => s.id);
      const links = ids.length === 0 ? [] : (await tx.query<LinkRow>('SELECT * FROM app.memory_share_links WHERE share_id = ANY ($1::uuid[])', [ids])).rows;
      // a run names what was left out, so only the people who manage the team see them (the database enforces it; everyone else gets no last run)
      const last = ids.length === 0 ? [] : (await tx.query<Pick<RunRow, 'id' | 'share_id' | 'state' | 'created_at'>>(
        'SELECT DISTINCT ON (r.share_id) r.id, r.share_id, r.state, r.created_at FROM app.memory_share_runs r WHERE r.share_id = ANY ($1::uuid[]) ORDER BY r.share_id, r.id DESC',
        [ids],
      )).rows;
      return json(
        ListSharesResponse.parse({
          shares: shares.map((s) => toShareView(s, links.filter((l) => l.share_id === s.id), last.find((r) => r.share_id === s.id))),
          canManage: await canManage(tx, team),
        }),
      );
    }),
  });

  ctx.http.route({
    ...getShareRoute,
    schema: { response: GetShareResponse },
    rateLimit: { limit: 240, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, shareSlug } = ShareParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const share = await requireShare(tx, team, shareSlug);
      const links = await loadLinks(tx, share.id);
      const last = (await tx.query<Pick<RunRow, 'id' | 'state' | 'created_at'>>('SELECT r.id, r.state, r.created_at FROM app.memory_share_runs r WHERE r.share_id = $1 ORDER BY r.id DESC LIMIT 1', [share.id])).rows[0];
      const view = toShareView(share, links, last);
      return json(GetShareResponse.parse({ share: view, canManage: await canManage(tx, team), destinations: view.destinations }));
    }),
  });

  // "Matches N concepts · M left out": what the share would send now, from the index alone. Nothing is built, nothing is read from the repo, nothing is stored.
  ctx.http.route({
    ...previewShareRoute,
    schema: { response: PreviewShareResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, shareSlug } = ShareParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const share = await requireShare(tx, team, shareSlug);
      if (share.status !== 'active') throw conflict(share.invalid_reason ?? 'This share’s file is not valid, so nothing can be previewed.');
      const gathered = await gather(tx, share, ctx.runtime.now());
      const preview = previewOf(share, gathered);
      return json(PreviewShareResponse.parse({ preview: { ...preview, headline: shareHeadline(preview.counts.matched, preview.counts.leftOut) } }));
    }),
  });

  // Run now: a lead or admin starts a digest. The run is filed as them, the build is a job, and the answer is the run in `building`. The share is not locked (the request
  // role cannot lock it): the index that allows one `building` run per share keeps two builds apart.
  ctx.http.route({
    ...runShareRoute,
    schema: { response: RunShareResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, shareSlug } = ShareParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      if (team.archived_at) throw conflict('This team is archived, so nothing can be shared from it.');
      const share = await requireShare(tx, team, shareSlug);
      if (share.status !== 'active') throw conflict(share.invalid_reason ?? 'This share’s file is not valid, so it cannot run.');
      if (!(await sharingEnabled(tx, team.workspace_id))) throw conflict(SHARING_OFF_REASON);
      const run = (
        await tx.query<RunRow>(
          `INSERT INTO app.memory_share_runs AS r (workspace_id, team_id, share_id, trigger_kind, state, mode, requested_by)
           VALUES ($1, $2, $3, 'manual', 'building', $4, $5)
           ON CONFLICT DO NOTHING
           RETURNING ${RUN_COLUMNS}`,
          [team.workspace_id, team.id, share.id, share.mode, tx.actor.id],
        )
      ).rows[0];
      if (!run) throw conflict('A digest of this share is already being built. Wait for it to finish, then run it again.');
      await enqueueBuild(ctx, tx, run);
      return json(RunShareResponse.parse({ run: toRun(run) }), 202);
    }),
  });

  ctx.http.route({
    ...listShareRunsRoute,
    schema: { query: ListShareRunsQuery, response: ListShareRunsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, shareSlug } = ShareParams.parse(req.params);
      const query = ListShareRunsQuery.parse(req.query);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const share = await requireShare(tx, team, shareSlug);
      const rows = await tx.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM app.memory_share_runs r WHERE r.share_id = $1 ORDER BY r.id DESC LIMIT $2`, [share.id, query.limit]);
      return json(ListShareRunsResponse.parse({ runs: rows.rows.map(toRun) }));
    }),
  });

  ctx.http.route({
    ...getShareRunRoute,
    schema: { response: GetShareRunResponse },
    rateLimit: { limit: 240, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, shareSlug, runId } = ShareRunParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const share = await requireShare(tx, team, shareSlug);
      const run = (await tx.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM app.memory_share_runs r WHERE r.id = $1 AND r.share_id = $2`, [runId, share.id])).rows[0];
      if (!run) throw notFound('No such run for this share');
      return json(GetShareRunResponse.parse({ run: toRun(run) }));
    }),
  });

  // The receiving side. Anyone who can read the team sees which teams send to it; only its leads and the workspace's admins pause, resume or end a link. The sending team
  // never does either from here: it ends a link by taking the destination out of its file.
  ctx.http.route({
    ...listIncomingSharesRoute,
    schema: { response: ListIncomingSharesResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug } = ShareTeamParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const rows = (await tx.query<IncomingDbRow>('SELECT * FROM app.memory_share_incoming($1::uuid)', [team.id])).rows;
      return json(ListIncomingSharesResponse.parse({ incoming: rows.map(toIncoming), canManage: await canManage(tx, team) }));
    }),
  });

  ctx.http.route({
    ...actOnIncomingShareRoute,
    schema: { response: IncomingActionResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, linkId, action } = IncomingLinkParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      if (team.archived_at) throw conflict('This team is archived, so its shares cannot be changed.');
      let moved: MovedLinkRow | undefined;
      try {
        moved = (await tx.query<MovedLinkRow>('SELECT * FROM app.memory_share_link_act($1::uuid, $2::uuid, $3)', [linkId, team.id, action])).rows[0];
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === '55000') throw conflict(err instanceof Error ? err.message : 'That change is not possible now.');
        if (code === 'P0002') throw notFound('No such share for this team');
        throw err;
      }
      if (!moved) throw notFound('No such share for this team');
      await emitLinked(
        ctx,
        tx,
        { id: moved.o_link_id, workspace_id: moved.o_workspace_id, team_id: moved.o_team_id, dest_team_id: moved.o_dest_team_id, share_id: moved.o_share_id },
        moved.o_from,
        moved.o_to,
        moved.o_ended,
        moved.o_actor,
      );
      const rows = (await tx.query<IncomingDbRow>('SELECT * FROM app.memory_share_incoming($1::uuid)', [team.id])).rows;
      const link = rows.find((r) => r.o_link_id === linkId);
      if (!link) throw notFound('No such share for this team');
      return json(IncomingActionResponse.parse({ link: toIncoming(link) }));
    }),
  });

  // The workspace's "Memory sharing" switch. Everyone in the workspace can read it (a team should know why nothing arrives); owners and admins change it.
  const settingOf = async (tx: PluginTx): Promise<MemorySharingSetting> => {
    const row = (
      await tx.query<{ enabled: boolean; updated_at: Date }>('SELECT enabled, updated_at FROM app.memory_sharing_settings WHERE workspace_id = $1::uuid', [tx.actor.workspaceId])
    ).rows[0];
    const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
    return MemorySharingSetting.parse({ enabled: row?.enabled ?? true, canChange: role === 'owner' || role === 'admin', changedAt: row ? row.updated_at.toISOString() : null });
  };

  ctx.http.route({
    ...getMemorySharingRoute,
    schema: { response: MemorySharingSetting },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (_req, tx) => json(await settingOf(tx))),
  });

  ctx.http.route({
    ...setMemorySharingRoute,
    schema: { body: SetMemorySharingBody, response: MemorySharingSetting },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
      if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace owners and admins can switch memory sharing on or off.');
      const body = SetMemorySharingBody.parse(req.body);
      const before = await settingOf(tx);
      await tx.query(
        `INSERT INTO app.memory_sharing_settings (workspace_id, enabled, changed_by, updated_at) VALUES ($1::uuid, $2, $3::uuid, now())
         ON CONFLICT (workspace_id) DO UPDATE SET enabled = EXCLUDED.enabled, changed_by = EXCLUDED.changed_by, updated_at = now()`,
        [tx.actor.workspaceId, body.enabled, tx.actor.id],
      );
      if (before.enabled !== body.enabled) {
        await ctx.audit.emit(tx, {
          type: 'memory.sharing.switched',
          schemaVersion: 1,
          workspaceId: tx.actor.workspaceId,
          enabled: body.enabled,
          changedBy: tx.actor.id,
          at: ctx.runtime.now().toISOString(),
        });
      }
      return json(await settingOf(tx));
    }),
  });
}

interface IncomingDbRow extends Record<string, unknown> {
  o_link_id: string;
  o_share_id: string;
  o_from_team_id: string;
  o_from_slug: string;
  o_from_name: string;
  o_share_name: string;
  o_mode: string;
  o_state: string;
  o_ended: string | null;
  o_approval_id: string | null;
  o_requested_at: Date;
  o_accepted_at: Date | null;
  o_last_delivered_at: Date | null;
  o_deliveries: number;
}

interface MovedLinkRow extends Record<string, unknown> {
  o_link_id: string;
  o_share_id: string;
  o_team_id: string;
  o_dest_team_id: string;
  o_workspace_id: string;
  o_from: 'requested' | 'accepted' | 'paused' | 'revoked';
  o_to: 'requested' | 'accepted' | 'paused' | 'revoked';
  o_ended: 'removed' | 'by_team' | null;
  o_actor: string | null;
}

function toIncoming(r: IncomingDbRow): ShareIncoming {
  return ShareIncoming.parse({
    id: r.o_link_id,
    shareId: r.o_share_id,
    fromTeamId: r.o_from_team_id,
    fromSlug: r.o_from_slug,
    fromName: r.o_from_name,
    shareName: r.o_share_name,
    mode: r.o_mode,
    state: r.o_state,
    endedReason: r.o_ended,
    approvalId: r.o_approval_id,
    requestedAt: r.o_requested_at.toISOString(),
    acceptedAt: r.o_accepted_at ? r.o_accepted_at.toISOString() : null,
    lastDeliveredAt: r.o_last_delivered_at ? r.o_last_delivered_at.toISOString() : null,
    deliveries: r.o_deliveries,
  });
}
