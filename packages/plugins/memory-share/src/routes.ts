import { conflict, json, notFound, requireManage, requireTeam, route, type PluginContext, type PluginTx, type TeamRow } from '@manythreads/sdk';
import {
  GetShareResponse,
  GetShareRunResponse,
  ListShareRunsQuery,
  ListShareRunsResponse,
  ListSharesResponse,
  PreviewShareResponse,
  RunShareResponse,
  ShareParams,
  ShareRunParams,
  ShareTeamParams,
  getShareRoute,
  getShareRunRoute,
  listShareRunsRoute,
  listSharesRoute,
  previewShareRoute,
  runShareRoute,
  shareHeadline,
} from '@manythreads/shared';
import { gather, loadLinks, previewOf } from './build.ts';
import { enqueueBuild } from './jobs.ts';
import { RUN_COLUMNS, toRun, toShareView, type LinkRow, type RunRow, type ShareRow } from './rows.ts';

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
}
